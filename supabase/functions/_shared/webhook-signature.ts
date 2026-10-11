/**
 * Verifies Cloudflare Stream webhook signatures.
 *
 * Header: `Webhook-Signature: time=<unix seconds>,sig1=<hex>`
 * sig1 = hex(HMAC-SHA256(secret, `${time}.${rawBody}`))
 * https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/
 */

/** Reject deliveries older than this (replay protection). */
export const MAX_AGE_SECONDS = 15 * 60;

function parseHeader(header: string): { time: number; sig: string } | null {
  let time = NaN;
  let sig = "";
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === "time") time = Number(value);
    if (name === "sig1") sig = value.toLowerCase();
  }
  if (!Number.isInteger(time) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  return { time, sig };
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function computeSignature(secret: string, time: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${time}.${rawBody}`)));
}

export async function verifyWebhookSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  const parsed = parseHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.time) > MAX_AGE_SECONDS) return false;
  const expected = await computeSignature(secret, parsed.time, rawBody);
  return constantTimeEqual(expected, parsed.sig);
}
