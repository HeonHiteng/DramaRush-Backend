/**
 * Signs Cloudflare Stream playback tokens locally (RS256) with a Stream
 * signing key, so playback never calls the Cloudflare API (no rate limit, no
 * API token on the playback path).
 *
 * Web-standard APIs only (crypto.subtle, atob, TextEncoder): runs in Supabase
 * Edge Functions (Deno) and in Node for unit tests.
 */

/** Cloudflare Stream video UID: 32 lowercase hex chars (same check as video_assets.provider_uid). */
export const STREAM_UID_RE = /^[0-9a-f]{32}$/;

/** Player hostname prefix, e.g. customer-abc123. Checked before it goes into a URL. */
export const CUSTOMER_CODE_RE = /^customer-[a-z0-9]+$/;

/** Cloudflare caps token lifetime at 24h. */
const MAX_TTL_SECONDS = 24 * 3600;
const MIN_TTL_SECONDS = 60;

export interface SigningKey {
  /** Key id returned by POST /stream/keys. */
  id: string;
  /** The `jwk` field returned by POST /stream/keys: base64 of the JWK JSON. */
  jwkBase64: string;
}

export interface SignOptions {
  uid: string;
  key: SigningKey;
  ttlSeconds: number;
  /** ISO 3166-1 alpha-2 codes. When set, playback from any other country is blocked. */
  allowedCountries?: string[];
  /** Injected in tests. */
  now?: () => number;
}

export interface PlaybackUrls {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
  hlsUrl: string;
  dashUrl: string;
  thumbnailUrl: string;
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlFromJson(value: unknown): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importSigningKey(key: SigningKey): Promise<CryptoKey> {
  const cacheKey = `${key.id}:${key.jwkBase64.length}`;
  let cached = keyCache.get(cacheKey);
  if (!cached) {
    const jwk = JSON.parse(atob(key.jwkBase64)) as JsonWebKey;
    cached = crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    // Don't cache a failed import forever.
    cached.catch(() => keyCache.delete(cacheKey));
    keyCache.set(cacheKey, cached);
  }
  return cached;
}

export async function signStreamToken(opts: SignOptions): Promise<{ token: string; expiresAt: number }> {
  if (!STREAM_UID_RE.test(opts.uid)) throw new Error("invalid stream uid");
  if (!opts.key.id || !opts.key.jwkBase64) throw new Error("missing signing key");

  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const ttl = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(opts.ttlSeconds)));
  const expiresAt = now + ttl;

  const header = { alg: "RS256", kid: opts.key.id };
  const payload: Record<string, unknown> = {
    sub: opts.uid,
    kid: opts.key.id,
    exp: expiresAt,
    // Small allowance for clock skew between us and Cloudflare.
    nbf: now - 30,
  };

  const countries = (opts.allowedCountries ?? []).filter((c) => /^[A-Z]{2}$/.test(c));
  if (countries.length > 0) {
    // First matching rule wins: allow the listed countries, block everything else.
    payload.accessRules = [
      { type: "ip.geoip.country", action: "allow", country: countries },
      { type: "any", action: "block" },
    ];
  }

  const unsigned = `${base64UrlFromJson(header)}.${base64UrlFromJson(payload)}`;
  const cryptoKey = await importSigningKey(opts.key);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );

  return { token: `${unsigned}.${base64UrlFromBytes(new Uint8Array(signature))}`, expiresAt };
}

export function playbackUrls(customerCode: string, token: string, expiresAt: number): PlaybackUrls {
  if (!CUSTOMER_CODE_RE.test(customerCode)) throw new Error("invalid customer code");
  if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new Error("invalid token");
  const base = `https://${customerCode}.cloudflarestream.com/${token}`;
  return {
    token,
    expiresAt,
    hlsUrl: `${base}/manifest/video.m3u8`,
    dashUrl: `${base}/manifest/video.mpd`,
    thumbnailUrl: `${base}/thumbnails/thumbnail.jpg`,
  };
}
