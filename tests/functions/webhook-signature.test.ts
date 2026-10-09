import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSignature, MAX_AGE_SECONDS, verifyWebhookSignature } from "../../supabase/functions/_shared/webhook-signature.ts";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ uid: "0123456789abcdef0123456789abcdef", readyToStream: true, status: { state: "ready" } });
const NOW = 1_800_000_000;

async function header(time: number, body = BODY, secret = SECRET) {
  return `time=${time},sig1=${await computeSignature(secret, time, body)}`;
}

test("accepts a correctly signed, fresh delivery", async () => {
  assert.equal(await verifyWebhookSignature(await header(NOW), BODY, SECRET, NOW), true);
});

test("matches an independently computed HMAC (Cloudflare's documented format)", async () => {
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");
  assert.equal(await verifyWebhookSignature(`time=${NOW},sig1=${sig}`, BODY, SECRET, NOW), true);
});

test("rejects a tampered body", async () => {
  assert.equal(await verifyWebhookSignature(await header(NOW), BODY.replace("ready", "error"), SECRET, NOW), false);
});

test("rejects the wrong secret", async () => {
  assert.equal(await verifyWebhookSignature(await header(NOW, BODY, "other"), BODY, SECRET, NOW), false);
});

test("rejects stale or future timestamps (replay)", async () => {
  const old = NOW - MAX_AGE_SECONDS - 1;
  assert.equal(await verifyWebhookSignature(await header(old), BODY, SECRET, NOW), false);
  const future = NOW + MAX_AGE_SECONDS + 1;
  assert.equal(await verifyWebhookSignature(await header(future), BODY, SECRET, NOW), false);
});

test("rejects missing or malformed headers and an empty secret", async () => {
  assert.equal(await verifyWebhookSignature(null, BODY, SECRET, NOW), false);
  assert.equal(await verifyWebhookSignature("garbage", BODY, SECRET, NOW), false);
  assert.equal(await verifyWebhookSignature(`time=${NOW},sig1=zz`, BODY, SECRET, NOW), false);
  assert.equal(await verifyWebhookSignature(await header(NOW), BODY, "", NOW), false);
});
