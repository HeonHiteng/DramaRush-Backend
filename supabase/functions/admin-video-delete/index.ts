/**
 * POST /functions/v1/admin-video-delete   (admins only)
 *   { "episode_id": "..." }   delete every video of an episode
 *   { "asset_id": "<uuid>" }  delete one video (e.g. a failed upload)
 *
 * Deletes the video from Cloudflare first, then the video_assets row, so we
 * never lose track of a video that is still stored (and billed). Call this
 * before deleting an episode — deleting the episode row alone would leave the
 * Cloudflare video orphaned.
 *
 * 200 { deleted, failed }
 */
import { env, episodeIdFrom, errorResponse, getCaller, isAdmin, json, preflight, readJson, serviceClient } from "../_shared/http.ts";
import { deleteVideo, type StreamApiConfig } from "../_shared/cloudflare-stream.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    const assetId = typeof body?.asset_id === "string" && UUID_RE.test(body.asset_id) ? body.asset_id : null;
    if (!episodeId && !assetId) return errorResponse("bad_request", 400);

    let query = admin.from("video_assets").select("id, provider_uid");
    query = assetId ? query.eq("id", assetId) : query.eq("episode_id", episodeId!);
    const { data: rows, error } = await query;
    if (error) return errorResponse("server_error", 500);

    const cfg: StreamApiConfig = {
      accountId: env("CLOUDFLARE_ACCOUNT_ID"),
      apiToken: env("CLOUDFLARE_STREAM_API_TOKEN"),
    };

    let deleted = 0;
    const failed: string[] = [];
    for (const row of rows ?? []) {
      try {
        await deleteVideo(cfg, row.provider_uid);
        await admin.from("video_assets").delete().eq("id", row.id);
        deleted++;
      } catch (err) {
        console.error("delete failed", row.provider_uid, err instanceof Error ? err.message : err);
        failed.push(row.id);
      }
    }

    return json({ deleted, failed });
  } catch (err) {
    console.error("admin-video-delete error", err instanceof Error ? err.message : err);
    return errorResponse("server_error", 500);
  }
});
