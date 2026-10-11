/**
 * Cloudflare Stream management API (upload URLs, delete). Needs the Stream
 * API token, so only admin functions and the webhook use this — never the
 * playback path. Adapted from aiseahub官网/src/lib/server/stream.ts.
 *
 * Web-standard APIs only; config and fetch are passed in so it can be tested.
 */
import { STREAM_UID_RE } from "./stream-token.ts";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const REQUEST_TIMEOUT_MS = 15_000;

/** Basic (single POST) uploads are limited to 200MB by Cloudflare; above that use tus. */
export const BASIC_UPLOAD_MAX_BYTES = 200 * 1024 ** 2;
export const MAX_UPLOAD_BYTES = 30 * 1024 ** 3;

/** Short dramas: 1–10 minutes per episode; leave headroom. Uploads longer than this fail. */
const DEFAULT_MAX_DURATION_SECONDS = 30 * 60;
const MIN_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 4 * 3600;

export interface StreamApiConfig {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
}

export interface UploadOptions {
  /** Shown in the Cloudflare dashboard; we use the episode id. */
  name: string;
  maxDurationSeconds?: number;
  /** Watermark profile uid (Keybox logo burned into the video). */
  watermarkUid?: string;
  /** Origins allowed to embed the video (web). Empty = any. */
  allowedOrigins?: string[];
  /** Free-form creator id (we use the admin's user id). Max 64 chars. */
  creator?: string;
}

export class StreamApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "StreamApiError";
    this.status = status;
  }
}

function accountUrl(cfg: StreamApiConfig, path: string): string {
  return `${API_BASE}/${encodeURIComponent(cfg.accountId)}/stream${path}`;
}

function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "episode-video";
}

function clampDuration(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return DEFAULT_MAX_DURATION_SECONDS;
  return Math.min(MAX_DURATION_SECONDS, Math.max(MIN_DURATION_SECONDS, Math.round(seconds)));
}

function isCloudflareUploadUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      (u.hostname.endsWith(".cloudflarestream.com") || u.hostname.endsWith(".videodelivery.net") ||
        u.hostname === "upload.cloudflarestream.com")
    );
  } catch {
    return false;
  }
}

function cleanOrigins(origins: string[] | undefined): string[] {
  return (origins ?? []).map((o) => o.trim()).filter((o) => /^[a-z0-9*.:-]+$/i.test(o));
}

/**
 * One-time URL for a single multipart POST upload (form field `file`), up to
 * 200MB. Simplest option for the admin web UI.
 */
export async function createBasicUpload(
  cfg: StreamApiConfig,
  opts: UploadOptions,
): Promise<{ uploadUrl: string; uid: string }> {
  const body: Record<string, unknown> = {
    maxDurationSeconds: clampDuration(opts.maxDurationSeconds),
    requireSignedURLs: true,
    meta: { name: cleanName(opts.name) },
  };
  if (opts.creator) body.creator = opts.creator.slice(0, 64);
  if (opts.watermarkUid) body.watermark = { uid: opts.watermarkUid };
  const origins = cleanOrigins(opts.allowedOrigins);
  if (origins.length > 0) body.allowedOrigins = origins;

  const res = await (cfg.fetch ?? fetch)(accountUrl(cfg, "/direct_upload"), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new StreamApiError(`direct_upload failed: HTTP ${res.status} ${text.slice(0, 300)}`, 502);

  let result: { uploadURL?: string; uid?: string } = {};
  try {
    result = (JSON.parse(text) as { result?: typeof result }).result ?? {};
  } catch {
    /* handled below */
  }
  const uploadUrl = result.uploadURL ?? "";
  const uid = result.uid ?? "";
  if (!isCloudflareUploadUrl(uploadUrl)) throw new StreamApiError("direct_upload: unexpected upload url", 502);
  if (!STREAM_UID_RE.test(uid)) throw new StreamApiError("direct_upload: invalid video id", 502);
  return { uploadUrl, uid };
}

/** One-time resumable (tus) upload URL, for files over 200MB or flaky networks. */
export async function createTusUpload(
  cfg: StreamApiConfig,
  opts: UploadOptions & { fileSize: number },
): Promise<{ uploadUrl: string; uid: string }> {
  if (!Number.isInteger(opts.fileSize) || opts.fileSize <= 0 || opts.fileSize > MAX_UPLOAD_BYTES) {
    throw new StreamApiError("invalid file size", 400);
  }

  const metadata = [
    `maxdurationseconds ${base64Utf8(String(clampDuration(opts.maxDurationSeconds)))}`,
    "requiresignedurls",
    `name ${base64Utf8(cleanName(opts.name))}`,
  ];
  if (opts.watermarkUid) metadata.push(`watermark ${base64Utf8(opts.watermarkUid)}`);
  const origins = cleanOrigins(opts.allowedOrigins);
  if (origins.length > 0) metadata.push(`allowedorigins ${base64Utf8(origins.join(","))}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiToken}`,
    "Tus-Resumable": "1.0.0",
    "Upload-Length": String(opts.fileSize),
    "Upload-Metadata": metadata.join(","),
  };
  if (opts.creator) headers["Upload-Creator"] = opts.creator.slice(0, 64);

  const res = await (cfg.fetch ?? fetch)(accountUrl(cfg, "?direct_user=true"), {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status !== 201) {
    const text = await res.text().catch(() => "");
    throw new StreamApiError(`tus create failed: HTTP ${res.status} ${text.slice(0, 300)}`, 502);
  }

  const uploadUrl = res.headers.get("Location") ?? "";
  if (!isCloudflareUploadUrl(uploadUrl)) throw new StreamApiError("tus create: unexpected upload url", 502);

  const uid =
    res.headers.get("stream-media-id") ?? new URL(uploadUrl).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!STREAM_UID_RE.test(uid)) throw new StreamApiError("tus create: invalid video id", 502);
  return { uploadUrl, uid };
}

/** Deletes a video. A video that is already gone counts as success. */
export async function deleteVideo(cfg: StreamApiConfig, uid: string): Promise<void> {
  if (!STREAM_UID_RE.test(uid)) throw new StreamApiError("invalid video id", 400);
  const res = await (cfg.fetch ?? fetch)(accountUrl(cfg, `/${uid}`), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${cfg.apiToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok || res.status === 404) return;
  const text = await res.text().catch(() => "");
  throw new StreamApiError(`delete failed: HTTP ${res.status} ${text.slice(0, 300)}`, 502);
}
