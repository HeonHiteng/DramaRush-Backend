/**
 * POST /functions/v1/admin-video-upload   (admins only)
 *   { "episode_id": "...", "mode": "basic" | "tus", "file_size": 123, "file_name": "ep04.mp4",
 *     "max_duration_seconds": 600 }
 *
 * Creates a one-time Cloudflare Stream upload URL for an episode and records
 * the pending video in video_assets. The browser / script then uploads the
 * file straight to Cloudflare (our API token never leaves the server).
 *   basic: single multipart POST to upload_url, form field "file", max 200MB
 *   tus:   resumable upload to upload_url (any tus client)
 * Every video requires signed URLs, gets the Keybox watermark if configured,
 * and is only playable through playback-token. When Cloudflare finishes
 * processing, stream-webhook marks it ready.
 *
 * 200 { asset_id, uid, upload_url, mode }
 * 401 not_authenticated · 403 admin_only · 400 bad_request · 404 episode_not_found
 */
import {
  env,
  episodeIdFrom,
  errorResponse,
  getCaller,
  isAdmin,
  json,
  listEnv,
  optionalEnv,
  preflight,
  readJson,
  serviceClient,
} from "../_shared/http.ts";
import {
  BASIC_UPLOAD_MAX_BYTES,
  createBasicUpload,
  createTusUpload,
  type StreamApiConfig,
} from "../_shared/cloudflare-stream.ts";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const admin = serviceClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("not_authenticated", 401);
    if (!(await isAdmin(req))) return errorResponse("admin_only", 403);

    const body = await readJson(req);
    const episodeId = episodeIdFrom(body);
    if (!episodeId) return errorResponse("bad_request", 400);

    const fileSize = typeof body?.file_size === "number" ? body.file_size : undefined;
    const mode = body?.mode === "tus" || (fileSize !== undefined && fileSize > BASIC_UPLOAD_MAX_BYTES) ? "tus" : "basic";
    if (mode === "tus" && fileSize === undefined) return errorResponse("bad_request", 400);
    const maxDuration = typeof body?.max_duration_seconds === "number" ? body.max_duration_seconds : undefined;

    const { data: episode } = await admin.from("episodes").select("id").eq("id", episodeId).maybeSingle();
    if (!episode) return errorResponse("episode_not_found", 404);

    const cfg: StreamApiConfig = {
      accountId: env("CLOUDFLARE_ACCOUNT_ID"),
      apiToken: env("CLOUDFLARE_STREAM_API_TOKEN"),
    };
    const uploadOpts = {
      name: episodeId,
      maxDurationSeconds: maxDuration,
      watermarkUid: optionalEnv("STREAM_WATERMARK_UID"),
      allowedOrigins: listEnv("STREAM_ALLOWED_ORIGINS"),
      creator: user.id,
    };
    const { uploadUrl, uid } = mode === "tus"
      ? await createTusUpload(cfg, { ...uploadOpts, fileSize: fileSize! })
      : await createBasicUpload(cfg, uploadOpts);

    const { data: asset, error } = await admin
      .from("video_assets")
      .insert({ episode_id: episodeId, provider_uid: uid, status: "pending_upload", created_by: user.id })
      .select("id")
      .single();
    if (error) {
      console.error("video_assets insert failed", error.message);
      return errorResponse("server_error", 500);
    }

    return json({ asset_id: asset.id, uid, upload_url: uploadUrl, mode });
  } catch (err) {
    console.error("admin-video-upload error", err instanceof Error ? err.message : err);
    return errorResponse("server_error", 500);
  }
});
