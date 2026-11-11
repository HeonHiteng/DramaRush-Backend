#!/usr/bin/env python3
"""Import series posters from public Google Drive files into KBbox.

For every entry in scripts/posters.manifest.json:
  1. download the master from Drive into a work dir outside the repo (skipped when the file
     is already there with the expected size; Drive's "can't scan for viruses" page is handled),
  2. render it (PDF: page 1 via PyMuPDF; images: Pillow, EXIF-rotated, colour-managed to sRGB),
  3. write the app poster <work>/out/<id>.jpg (long side 1350 px, progressive JPEG, no metadata,
     <= 400 KB by stepping quality 85 -> 70) and derive two gradient colours from it,
  4. upload it to storage series-posters/<id>.jpg (upsert) and insert the series row if missing,
     otherwise update poster_image_uri (colours only while they are still what this script set).

Re-running is safe: an unchanged poster that is already live is not re-uploaded (use --force).

Usage:
  npm run import-posters -- [--dry-run] [--only <id>] [--force] [--work-dir <dir>] [--manifest <file>]

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in scripts/.env. Python 3 + Pillow + PyMuPDF.
Downloaded files are treated as untrusted data: they are only parsed as images/PDFs.
"""

import argparse
import colorsys
import hashlib
import html
import http.cookiejar
import io
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageCms, ImageOps

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent

LONG_SIDE = 1350
PDF_MIN_LONG_SIDE = 1500
QUALITY_START, QUALITY_MIN, QUALITY_STEP = 85, 70, 5
TARGET_BYTES = 400 * 1024
MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024
USER_AGENT = "Mozilla/5.0 (kbbox-import-posters)"
COLOUR_KEYS = ("poster_color_from", "poster_color_to", "banner_color_from", "banner_color_to")
ROW_KEYS = ("synopsis", "genres", "rating", "status", "language", "cast_members", "popularity", "is_new")

Image.MAX_IMAGE_PIXELS = None  # print masters are huge; the sources are known Drive files


class PosterError(Exception):
    pass


# ---------------------------------------------------------------- env / http


def load_env(path):
    env = {}
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env[key.strip()] = value
    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


class Supabase:
    def __init__(self, url, key):
        self.url = url.rstrip("/")
        self.key = key

    def request(self, method, path, body=None, headers=None, timeout=120):
        hdrs = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        hdrs.update(headers or {})
        data = body
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as err:
            detail = err.read()[:500].decode("utf-8", "replace")
            raise PosterError(f"{method} {path.split('?')[0]} -> HTTP {err.code}: {detail}") from None

    def public_url(self, bucket, name):
        return f"{self.url}/storage/v1/object/public/{bucket}/{urllib.parse.quote(name)}"

    def get_series(self, series_id):
        q = urllib.parse.urlencode({"id": f"eq.{series_id}", "select": "id,poster_image_uri," + ",".join(COLOUR_KEYS)})
        _, raw = self.request("GET", f"/rest/v1/series?{q}")
        rows = json.loads(raw)
        return rows[0] if rows else None

    def insert_series(self, row):
        self.request("POST", "/rest/v1/series", row, {"Prefer": "return=minimal"})

    def patch_series(self, series_id, fields):
        q = urllib.parse.urlencode({"id": f"eq.{series_id}"})
        self.request("PATCH", f"/rest/v1/series?{q}", fields, {"Prefer": "return=minimal"})

    def upload(self, bucket, name, data, content_type):
        self.request(
            "POST",
            f"/storage/v1/object/{bucket}/{urllib.parse.quote(name)}",
            data,
            {"Content-Type": content_type, "x-upsert": "true", "cache-control": "3600"},
            timeout=300,
        )


# ---------------------------------------------------------------- download

FORM_RE = re.compile(r"<form[^>]*\bid=\"download-form\"[^>]*>(.*?)</form>", re.S | re.I)
ACTION_RE = re.compile(r"<form[^>]*\bid=\"download-form\"[^>]*\baction=\"([^\"]+)\"", re.S | re.I)
INPUT_RE = re.compile(r"<input[^>]*>", re.I)
ATTR_RE = re.compile(r"(\w+)=\"([^\"]*)\"")


def confirm_url(page, original_url):
    """Next URL from Drive's "can't scan this file for viruses" page (form or confirm= token)."""
    action, form = ACTION_RE.search(page), FORM_RE.search(page)
    if action and form:
        params = {}
        for tag in INPUT_RE.findall(form.group(1)):
            attrs = dict(ATTR_RE.findall(tag))
            if attrs.get("type", "").lower() == "hidden" and "name" in attrs:
                params[attrs["name"]] = html.unescape(attrs.get("value", ""))
        target = html.unescape(action.group(1))
        host = urllib.parse.urlparse(target).hostname or ""
        if not (host == "google.com" or host.endswith(".google.com")):
            raise PosterError(f"Drive confirm form points to unexpected host {host!r}")
        return target + ("&" if "?" in target else "?") + urllib.parse.urlencode(params)
    token = re.search(r"confirm=([0-9A-Za-z_-]+)", page)
    if token:
        return original_url + "&confirm=" + token.group(1)
    return None


def looks_like(kind, head):
    if kind == "pdf":
        return head.startswith(b"%PDF")
    return (
        head.startswith(b"\xff\xd8\xff")
        or head.startswith(b"\x89PNG\r\n\x1a\n")
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
        or head[:4] in (b"II*\x00", b"MM\x00*")
    )


def download(entry, dest, expected_bytes):
    if dest.exists() and expected_bytes and dest.stat().st_size == expected_bytes:
        return "cached"
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [("User-Agent", USER_AGENT)]
    url = "https://drive.google.com/uc?export=download&id=" + urllib.parse.quote(entry["driveId"])
    resp = opener.open(url, timeout=120)
    for _ in range(3):
        if not resp.headers.get("Content-Type", "").lower().startswith("text/html"):
            break
        page = resp.read(2 * 1024 * 1024).decode("utf-8", "replace")
        resp.close()
        next_url = confirm_url(page, url)
        if not next_url:
            for cookie in jar:
                if cookie.name.startswith("download_warning"):
                    next_url = url + "&confirm=" + urllib.parse.quote(cookie.value)
        if not next_url:
            title = re.search(r"<title>(.*?)</title>", page, re.S | re.I)
            hint = f" ({html.unescape(title.group(1)).strip()})" if title else ""
            raise PosterError("Drive returned an HTML page without a download link" + hint)
        resp = opener.open(next_url, timeout=120)
    else:
        raise PosterError("Drive kept returning HTML after following the confirm link")

    total = int(resp.headers.get("Content-Length") or 0)
    if total > MAX_DOWNLOAD_BYTES:
        raise PosterError(f"file is {total} bytes, over the {MAX_DOWNLOAD_BYTES} byte limit")
    part = dest.with_name(dest.name + ".part")
    got, next_report, head = 0, 0.25, b""
    try:
        with resp, open(part, "wb") as fh:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                if not head:
                    head = chunk[:16]
                    if not looks_like(entry["type"], head):
                        raise PosterError(f"download is not a {entry['type']} (starts with {head[:8]!r})")
                got += len(chunk)
                if got > MAX_DOWNLOAD_BYTES:
                    raise PosterError("download exceeded the size limit")
                fh.write(chunk)
                if total > 20e6 and got / total >= next_report:
                    print(f"    {entry['id']}: {got / 1e6:.0f} / {total / 1e6:.0f} MB", flush=True)
                    next_report += 0.25
        if total and got != total:
            raise PosterError(f"truncated download: {got} of {total} bytes")
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    part.replace(dest)
    return "downloaded"


# ---------------------------------------------------------------- render

_SRGB = []


def to_srgb(img):
    """RGB copy of img, colour-managed via its embedded ICC profile when there is one."""
    icc = img.info.get("icc_profile")
    if icc and img.mode in ("RGB", "CMYK", "L"):
        try:
            if not _SRGB:
                _SRGB.append(ImageCms.createProfile("sRGB"))
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            return ImageCms.profileToProfile(img, src, _SRGB[0], outputMode="RGB")
        except Exception:  # broken / unsupported profile: fall back to a plain conversion
            pass
    if img.mode in ("RGBA", "LA", "P", "PA") or "transparency" in img.info:
        rgba = img.convert("RGBA")
        bg = Image.new("RGB", rgba.size, (0, 0, 0))
        bg.paste(rgba, mask=rgba.getchannel("A"))
        return bg
    return img.convert("RGB")


def render_pdf(path):
    import pymupdf

    with pymupdf.open(path) as doc:
        if doc.page_count < 1:
            raise PosterError("PDF has no pages")
        page = doc[0]
        rect = page.rect
        zoom = PDF_MIN_LONG_SIDE / max(rect.width, rect.height)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csRGB, alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    size = f"{rect.width / 72:.1f}x{rect.height / 72:.1f}in -> {img.width}x{img.height}"
    return img, size


def render_image(path):
    img = Image.open(path)
    w, h = img.size
    scale = LONG_SIDE / max(w, h)
    if scale < 1 and img.format == "JPEG":
        # let libjpeg decode at 1/2, 1/4 or 1/8 while staying >= the target size
        img.draft(img.mode, (int(w * scale) + 1, int(h * scale) + 1))
    icc = img.info.get("icc_profile")
    img = ImageOps.exif_transpose(img)
    if icc and "icc_profile" not in img.info:
        img.info["icc_profile"] = icc
    return to_srgb(img), f"{w}x{h}"


def fit_long_side(img):
    w, h = img.size
    scale = LONG_SIDE / max(w, h)
    if scale >= 1:
        return img  # never upscale
    return img.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS, reducing_gap=3.0)


def encode_jpeg(img):
    quality = QUALITY_START
    while True:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=quality, progressive=True, optimize=True, subsampling="4:2:0")
        data = buf.getvalue()
        if len(data) <= TARGET_BYTES or quality <= QUALITY_MIN:
            return data, quality
        quality = max(QUALITY_MIN, quality - QUALITY_STEP)


# ---------------------------------------------------------------- colours


def to_hex(rgb):
    return "#" + "".join(f"{max(0, min(255, round(c))):02X}" for c in rgb)


def clamp_value(rgb, lo=0.0, hi=1.0, factor=1.0):
    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
    v = min(hi, max(lo, v * factor))
    return tuple(c * 255 for c in colorsys.hsv_to_rgb(h, s, v))


def gradient_colours(img):
    """(dark, accent) RGB from an 8-colour median-cut of a thumbnail."""
    small = img.copy()
    small.thumbnail((128, 128))
    q = small.quantize(colors=8, method=Image.Quantize.MEDIANCUT)
    palette = q.getpalette()
    total = small.width * small.height
    swatches = []
    for count, idx in q.getcolors():
        rgb = tuple(palette[idx * 3 : idx * 3 + 3])
        _, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in rgb))
        swatches.append({"rgb": rgb, "share": count / total, "s": s, "v": v})

    darks = [x for x in swatches if x["v"] <= 0.35 and x["share"] >= 0.05]
    dark = max(darks, key=lambda x: x["share"]) if darks else min(swatches, key=lambda x: x["v"])

    rest = [x for x in swatches if x is not dark and x["share"] >= 0.02] or [dark]
    accent = max(rest, key=lambda x: x["s"] * (1 - abs(x["v"] - 0.6)) * x["share"] ** 0.5)
    if accent["s"] < 0.15:  # greyscale artwork: most common non-dark tone instead
        accent = max(rest, key=lambda x: x["share"])
    return clamp_value(dark["rgb"], hi=0.22), clamp_value(accent["rgb"], lo=0.35, hi=0.62)


def colour_fields(img):
    dark, accent = gradient_colours(img)
    return {
        "poster_color_from": to_hex(dark),
        "poster_color_to": to_hex(accent),
        "banner_color_from": to_hex(clamp_value(dark, factor=0.8)),
        "banner_color_to": to_hex(clamp_value(accent, hi=0.72, factor=1.15)),
    }


# ---------------------------------------------------------------- main


def parse_args():
    p = argparse.ArgumentParser(description="Import series posters from Google Drive into KBbox.")
    p.add_argument("--manifest", default=str(SCRIPT_DIR / "posters.manifest.json"))
    p.add_argument(
        "--work-dir",
        default=os.environ.get("POSTER_WORK_DIR") or str(Path(tempfile.gettempdir()) / "kbbox-posters"),
        help="where masters and resized posters are kept (must be outside the repo; env POSTER_WORK_DIR)",
    )
    p.add_argument("--only", metavar="ID", help="process just this series id")
    p.add_argument("--dry-run", action="store_true", help="download + render, but write nothing remote")
    p.add_argument("--force", action="store_true", help="re-upload even if the live poster is unchanged")
    return p.parse_args()


def process(entry, ctx):
    sid, st, sb, work = entry["id"], ctx["state"].setdefault(entry["id"], {}), ctx["sb"], ctx["work"]
    row = ctx["row"]
    src = work / f"{sid}{'.pdf' if entry['type'] == 'pdf' else '.img'}"
    how = download(entry, src, entry.get("bytes") or st.get("bytes"))
    st["bytes"] = src.stat().st_size
    print(f"[{sid}] {how} {src.name} ({st['bytes'] / 1e6:.1f} MB)", flush=True)

    img, row["src"] = render_pdf(src) if entry["type"] == "pdf" else render_image(src)
    img = fit_long_side(img)
    data, quality = encode_jpeg(img)
    out = work / "out" / f"{sid}.jpg"
    out.write_bytes(data)
    colours = colour_fields(img)
    digest = hashlib.sha256(data).hexdigest()
    row.update(out=f"{img.width}x{img.height}", kb=f"{len(data) / 1024:.0f}", q=str(quality))
    if len(data) > TARGET_BYTES:
        print(f"[{sid}] warning: {len(data) // 1024} KB at quality {QUALITY_MIN} (> 400 KB)")
    if max(img.size) < LONG_SIDE:
        print(f"[{sid}] note: master is only {img.width}x{img.height}; not upscaled")

    bucket, name = ctx["bucket"], f"{sid}.jpg"
    existing = sb.get_series(sid) if sb else None
    base_url = sb.public_url(bucket, name) if sb else f"<SUPABASE_URL>/storage/v1/object/public/{bucket}/{name}"
    live_same = (
        existing is not None
        and (existing.get("poster_image_uri") or "").split("?")[0] == base_url
        and st.get("sha256") == digest
    )
    upload = ctx["force"] or not live_same
    poster_uri = f"{base_url}?v={int(time.time())}" if upload else existing["poster_image_uri"]

    if existing is None:
        action = "insert"
        fields = {"id": sid, "title": entry["title"], **ctx["defaults"], **colours, "poster_image_uri": poster_uri}
        fields.update({k: entry[k] for k in ROW_KEYS if k in entry})
    else:
        fields = {"poster_image_uri": poster_uri} if upload else {}
        ours = st.get("colours")
        current = {k: existing.get(k) for k in COLOUR_KEYS}
        if ours and current == ours and colours != ours:
            fields.update(colours)  # still the importer's colours: refresh them
        elif ours and current != ours:
            print(f"[{sid}] colours were edited since the last import; leaving them")
        action = "update" if fields else "unchanged"

    if ctx["dry_run"]:
        row["action"] = action if action == "unchanged" else f"would {action}"
        if upload:
            print(f"[{sid}] would upload {bucket}/{name} ({len(data)} bytes)")
        if fields:
            shown = {k: v for k, v in fields.items() if k != "poster_image_uri"}
            print(f"[{sid}] would {action} series: {json.dumps(shown, ensure_ascii=False)}")
        return

    if upload:
        sb.upload(bucket, name, data, "image/jpeg")
    if action == "insert":
        sb.insert_series(fields)
    elif fields:
        sb.patch_series(sid, fields)
    st["sha256"] = digest
    if action == "insert" or any(k in fields for k in COLOUR_KEYS):
        st["colours"] = colours
    row["action"] = {"insert": "inserted", "update": "updated"}.get(action, "unchanged")
    if not upload:
        row["action"] += " (poster already live)"
    print(f"[{sid}] {row['action']}  {colours['poster_color_from']} -> {colours['poster_color_to']}", flush=True)


def main():
    args = parse_args()
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    entries = manifest["posters"]
    if args.only:
        entries = [e for e in entries if e["id"] == args.only]
        if not entries:
            sys.exit(f"--only {args.only}: not in {args.manifest}")
    for e in entries:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", e.get("id", "")) or e.get("type") not in ("image", "pdf"):
            sys.exit(f"bad manifest entry: {e!r}")

    work = Path(args.work_dir).resolve()
    if work == REPO_ROOT or REPO_ROOT in work.parents:
        sys.exit(f"--work-dir must be outside the repo ({REPO_ROOT})")
    (work / "out").mkdir(parents=True, exist_ok=True)
    state_path = work / "import-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}

    env = load_env(SCRIPT_DIR / ".env")
    sb = None
    if env.get("SUPABASE_URL") and env.get("SUPABASE_SERVICE_ROLE_KEY"):
        sb = Supabase(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    elif not args.dry_run:
        sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in scripts/.env (see scripts/.env.example).")

    ctx = {
        "state": state, "sb": sb, "work": work, "force": args.force, "dry_run": args.dry_run,
        "bucket": manifest.get("bucket", "series-posters"), "defaults": manifest.get("defaults", {}),
    }
    print(f"work dir: {work}" + ("  (dry run: no uploads or row writes)" if args.dry_run else ""))
    results, failures = [], 0
    for entry in entries:
        ctx["row"] = row = {"id": entry["id"], "src": "-", "out": "-", "kb": "-", "q": "-", "action": "-"}
        results.append(row)
        try:
            process(entry, ctx)
        except Exception as err:  # keep going; reported in the table
            failures += 1
            row["action"] = f"FAILED: {err}"
            print(f"[{entry['id']}] FAILED: {err}", file=sys.stderr, flush=True)
        finally:
            state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    cols = [("id", "id"), ("src", "source px"), ("out", "output px"), ("kb", "KB"), ("q", "q"), ("action", "result")]
    widths = [max(len(title), *(len(r[key]) for r in results)) for key, title in cols]
    print()
    print("  ".join(t.ljust(w) for (_, t), w in zip(cols, widths)).rstrip())
    print("  ".join("-" * w for w in widths))
    for r in results:
        print("  ".join(r[k].ljust(w) for (k, _), w in zip(cols, widths)).rstrip())
    print(f"\nresized posters: {work / 'out'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
