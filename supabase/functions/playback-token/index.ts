/**
 * POST /functions/v1/playback-token   { "episode_id": "crimson-contract-ep4" }
 *
 * The only way the app can get a playable video URL. Verifies the caller,
 * asks the database (authorize_playback) whether they may watch — which also
 * enforces rate limits, abuse blocks and the daily cost budget — and only
 * then signs a short-lived Cloudflare Stream token locally.
 *
 * 200 { episode_id, hls_url, dash_url, thumbnail_url, expires_at, watermark_code }
 * 401 not_authenticated · 403 not_entitled · 404 unavailable
 * 429 rate_limited | blocked · 503 budget · 500 server_error
 */
import {
  clientIp,
  env,
  episodeIdFrom,
  errorResponse,
  getCaller,
  json,
  listEnv,
  preflight,
  readJson,
  serviceClient,
} from "../_shared/http.ts";
import { playbackUrls, signStreamToken } from "../_shared/stream-token.ts";

const DENIAL_STATUS: Record<string, number> = {
  not_entitled: 403,
  unavailable: 404,
  rate_limited: 429,
  blocked: 429,
  budget: 503,
};

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const admin = serviceClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("not_authenticated", 401);

    const episodeId = episodeIdFrom(await readJson(req));
    if (!episodeId) return errorResponse("bad_request", 400);

    const { data, error } = await admin.rpc("authorize_playback", {
      p_user_id: user.id,
      p_episode_id: episodeId,
      p_client_ip: clientIp(req),
      p_user_agent: req.headers.get("user-agent"),
    });
    if (error) {
      console.error("authorize_playback failed", error.message);
      return errorResponse("server_error", 500);
    }

    const decision = data as {
      allowed: boolean;
      reason?: string;
      provider_uid?: string;
      watermark_code?: string;
      ttl_seconds?: number;
    };
    if (!decision.allowed) {
      const reason = decision.reason ?? "not_entitled";
      return errorResponse(reason, DENIAL_STATUS[reason] ?? 403);
    }

    const { token, expiresAt } = await signStreamToken({
      uid: decision.provider_uid ?? "",
      key: { id: env("STREAM_SIGNING_KEY_ID"), jwkBase64: env("STREAM_SIGNING_JWK") },
      ttlSeconds: decision.ttl_seconds ?? 900,
      allowedCountries: listEnv("STREAM_ALLOWED_COUNTRIES"),
    });
    const urls = playbackUrls(env("CLOUDFLARE_STREAM_CUSTOMER_CODE"), token, expiresAt);

    return json({
      episode_id: episodeId,
      hls_url: urls.hlsUrl,
      dash_url: urls.dashUrl,
      thumbnail_url: urls.thumbnailUrl,
      expires_at: new Date(urls.expiresAt * 1000).toISOString(),
      watermark_code: decision.watermark_code ?? null,
    });
  } catch (err) {
    console.error("playback-token error", err instanceof Error ? err.message : err);
    return errorResponse("server_error", 500);
  }
});
