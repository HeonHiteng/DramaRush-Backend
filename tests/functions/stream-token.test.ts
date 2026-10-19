import { test } from "node:test";
import assert from "node:assert/strict";
import { playbackUrls, signStreamToken } from "../../supabase/functions/_shared/stream-token.ts";

const UID = "0123456789abcdef0123456789abcdef";

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  // Same shape as Cloudflare's POST /stream/keys response: base64 of the JWK JSON.
  return { publicKey: pair.publicKey, key: { id: "test-key-id", jwkBase64: btoa(JSON.stringify(jwk)) } };
}

function decodePart(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
}

function bytesFromBase64Url(part: string): Uint8Array {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

test("signs a verifiable RS256 token with the expected claims", async () => {
  const { publicKey, key } = await makeKey();
  const now = 1_800_000_000_000;
  const { token, expiresAt } = await signStreamToken({ uid: UID, key, ttlSeconds: 900, now: () => now });

  const [h, p, s] = token.split(".");
  assert.deepEqual(decodePart(h), { alg: "RS256", kid: "test-key-id" });
  const payload = decodePart(p);
  assert.equal(payload.sub, UID);
  assert.equal(payload.kid, "test-key-id");
  assert.equal(payload.exp, now / 1000 + 900);
  assert.equal(payload.nbf, now / 1000 - 30);
  assert.equal(payload.accessRules, undefined);
  assert.equal(expiresAt, now / 1000 + 900);

  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    bytesFromBase64Url(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert.ok(ok, "signature verifies with the public key");
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "base64url, no padding");
});

test("clamps ttl to Cloudflare's 24h maximum and a 20s minimum", async () => {
  const { key } = await makeKey();
  const now = 1_800_000_000_000;
  const long = await signStreamToken({ uid: UID, key, ttlSeconds: 999_999, now: () => now });
  assert.equal(long.expiresAt, now / 1000 + 24 * 3600);
  const short = await signStreamToken({ uid: UID, key, ttlSeconds: 1, now: () => now });
  assert.equal(short.expiresAt, now / 1000 + 20);
});

test("adds country allow + block-all rules when countries are configured", async () => {
  const { key } = await makeKey();
  const { token } = await signStreamToken({ uid: UID, key, ttlSeconds: 900, allowedCountries: ["MY", "SG", "bad", "usa"] });
  const payload = decodePart(token.split(".")[1]);
  assert.deepEqual(payload.accessRules, [
    { type: "ip.geoip.country", action: "allow", country: ["MY", "SG"] },
    { type: "any", action: "block" },
  ]);
});

test("rejects malformed uids and missing keys", async () => {
  const { key } = await makeKey();
  await assert.rejects(signStreamToken({ uid: "../etc", key, ttlSeconds: 900 }), /invalid stream uid/);
  await assert.rejects(signStreamToken({ uid: UID, key: { id: "", jwkBase64: "" }, ttlSeconds: 900 }), /missing signing key/);
});

test("builds playback urls only for a valid customer code", () => {
  const urls = playbackUrls("customer-abc123", "aaa.bbb.ccc", 1);
  assert.equal(urls.hlsUrl, "https://customer-abc123.cloudflarestream.com/aaa.bbb.ccc/manifest/video.m3u8");
  assert.equal(urls.dashUrl, "https://customer-abc123.cloudflarestream.com/aaa.bbb.ccc/manifest/video.mpd");
  assert.equal(urls.thumbnailUrl, "https://customer-abc123.cloudflarestream.com/aaa.bbb.ccc/thumbnails/thumbnail.jpg");
  assert.throws(() => playbackUrls("evil.com/x", "aaa.bbb.ccc", 1), /invalid customer code/);
  assert.throws(() => playbackUrls("customer-abc123", "a/b", 1), /invalid token/);
});
