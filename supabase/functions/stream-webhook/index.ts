/**
 * Cloudflare Stream webhook (deployed with verify_jwt = false; authenticity
 * comes from the Webhook-Signature HMAC instead).
 *
 * When a video finishes processing:
 *   ready -> video_assets.status = ready, episode duration and picture size
 *            (video_width/height) filled in, and any
 *            older video for the same episode is deleted from Cloudflare
 *   error -> video_assets.status = error with the reason
 * Videos we don't know about (e.g. uploaded by hand in the dashboard) are
 * acknowledged and ignored.
 */
import { env, json, optionalEnv, serviceClient } from "../_shared/http.ts";
import { verifyWebhookSignature } from "../_shared/webhook-signature.ts";
import { deleteVideo, type StreamApiConfig } from "../_shared/cloudflare-stream.ts";
import { STREAM_UID_RE } from "../_shared/stream-token.ts";
import { videoDimensions } from "../_shared/video-dimensions.ts";

interface StreamWebhookBody {
  uid?: string;
  readyToStream?: boolean;
  duration?: number;
  input?: { width?: number; height?: number };
  status?: { state?: string; errorReasonCode?: string; errReasonCode?: string; errorReasonText?: string };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();
  if (rawBody.length > 64 * 1024) return json({ error: "too_large" }, 413);

  const secret = optionalEnv("STREAM_WEBHOOK_SECRET");
  if (!secret) {
    console.error("STREAM_WEBHOOK_SECRET is not set");
    return json({ error: "not_configured" }, 503); // Cloudflare retries later
  }

  const valid = await verifyWebhookSignature(req.headers.get("Webhook-Signature"), rawBody, secret);
  if (!valid) return json({ error: "bad_signature" }, 401);

  let body: StreamWebhookBody;
  try {
    body = JSON.parse(rawBody) as StreamWebhookBody;
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const uid = body.uid ?? "";
  if (!STREAM_UID_RE.test(uid)) return json({ error: "bad_request" }, 400);

  const admin = serviceClient();
  const { data: asset, error: findError } = await admin
    .from("video_assets")
    .select("id, episode_id")
    .eq("provider_uid", uid)
    .maybeSingle();
  if (findError) {
    console.error("lookup failed", findError.message);
    return json({ error: "server_error" }, 500); // Cloudflare will retry
  }
  if (!asset) return json({ ok: true, ignored: true });

  const state = body.status?.state;
  const now = new Date().toISOString();

  if (state === "ready" || (body.readyToStream && state !== "error")) {
    const duration = typeof body.duration === "number" && body.duration > 0 ? body.duration : null;
    const size = videoDimensions(body);

    const { error } = await admin
      .from("video_assets")
      .update({
        status: "ready",
        duration_sec: duration,
        width: size?.width ?? null,
        height: size?.height ?? null,
        error_reason: null,
        ready_at: now,
        updated_at: now,
      })
      .eq("id", asset.id);
    if (error) {
      console.error("mark ready failed", error.message);
      return json({ error: "server_error" }, 500);
    }

    // The app picks letterboxing vs. full-bleed from the episode's picture size.
    const episodePatch: Record<string, number> = {};
    if (duration !== null) episodePatch.duration_sec = Math.round(duration);
    if (size) Object.assign(episodePatch, { video_width: size.width, video_height: size.height });
    if (Object.keys(episodePatch).length > 0) {
      await admin.from("episodes").update(episodePatch).eq("id", asset.episode_id);
    }

    // Replace: remove older ready/failed videos of this episode. In-flight
    // uploads (pending/processing) are left alone.
    const { data: old } = await admin
      .from("video_assets")
      .select("id, provider_uid")
      .eq("episode_id", asset.episode_id)
      .neq("id", asset.id)
      .in("status", ["ready", "error"]);

    if (old && old.length > 0) {
      const cfg: StreamApiConfig = {
        accountId: env("CLOUDFLARE_ACCOUNT_ID"),
        apiToken: env("CLOUDFLARE_STREAM_API_TOKEN"),
      };
      for (const row of old) {
        try {
          await deleteVideo(cfg, row.provider_uid);
          await admin.from("video_assets").delete().eq("id", row.id);
        } catch (err) {
          // Not fatal: the new video is live; the old one can be removed later
          // with admin-video-delete.
          console.error("could not delete superseded video", row.provider_uid, err instanceof Error ? err.message : err);
        }
      }
    }
    return json({ ok: true, status: "ready" });
  }

  if (state === "error") {
    const reason = body.status?.errorReasonCode ?? body.status?.errReasonCode ?? body.status?.errorReasonText ?? "unknown";
    await admin
      .from("video_assets")
      .update({ status: "error", error_reason: String(reason).slice(0, 200), updated_at: now })
      .eq("id", asset.id);
    return json({ ok: true, status: "error" });
  }

  await admin.from("video_assets").update({ status: "processing", updated_at: now }).eq("id", asset.id);
  return json({ ok: true, status: "processing" });
});
