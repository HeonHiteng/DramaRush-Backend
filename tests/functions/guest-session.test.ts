import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  deviceCredentials,
  deviceKeyFrom,
  guestEmail,
  hmacHex,
  ipHash,
  randomSuffix,
  runGuestSession,
  toBase64Url,
  type GuestSession,
  type GuestSessionInput,
  type GuestSessionSteps,
} from "../../supabase/functions/_shared/guest-session.ts";

const SECRET = "test-guest-device-secret";
const KEY = "a1b2c3d4e5f60718";

// ------------------------------------------------------------- derivation

test("HMAC-SHA256 matches RFC 4231 test case 2", async () => {
  assert.equal(
    await hmacHex("Jefe", "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

test("device hash and password match an independent HMAC", async () => {
  const c = await deviceCredentials(SECRET, KEY);
  assert.equal(c.deviceHash, createHmac("sha256", SECRET).update(KEY).digest("hex"));
  assert.equal(c.password, createHmac("sha256", SECRET).update(`pw:${KEY}`).digest("base64url") + "Aa1!");
  assert.match(c.deviceHash, /^[0-9a-f]{64}$/);
  // lower, upper, digit and symbol always present (strictest Supabase password policy)
  assert.match(c.password, /^[A-Za-z0-9_-]{43}Aa1!$/);
});

test("credentials are stable per key and differ between keys and secrets", async () => {
  const a = await deviceCredentials(SECRET, KEY);
  assert.deepEqual(await deviceCredentials(SECRET, KEY), a);
  assert.notEqual((await deviceCredentials(SECRET, `${KEY}x`)).deviceHash, a.deviceHash);
  assert.notEqual((await deviceCredentials("other-secret", KEY)).deviceHash, a.deviceHash);
  assert.notEqual(a.password, a.deviceHash);
});

test("an empty secret is refused", async () => {
  await assert.rejects(deviceCredentials("", KEY), /secret/);
});

test("ip hash is keyed and prefixed", async () => {
  assert.equal(await ipHash(SECRET, "203.0.113.7"), createHmac("sha256", SECRET).update("ip:203.0.113.7").digest("hex"));
  assert.equal(await ipHash(SECRET, null), createHmac("sha256", SECRET).update("ip:unknown").digest("hex"));
});

test("guest email: hash prefix, random suffix, synthetic domain", async () => {
  const { deviceHash } = await deviceCredentials(SECRET, KEY);
  const suffix = randomSuffix();
  assert.match(suffix, /^[0-9a-f]{8}$/);
  assert.notEqual(randomSuffix(), suffix);
  assert.equal(guestEmail(deviceHash, suffix), `d-${deviceHash.slice(0, 32)}-${suffix}@guest.kbbox.app`);
});

test("base64url has no padding or +/", () => {
  assert.equal(toBase64Url(new Uint8Array([0xfb, 0xff, 0xfe])), "-__-");
  assert.equal(toBase64Url(new Uint8Array([0x66])), "Zg");
});

test("device key validation", () => {
  assert.equal(deviceKeyFrom({ device_key: KEY }), KEY);
  const uuid = "6f1c2a0e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.equal(deviceKeyFrom({ device_key: uuid }), uuid);
  assert.equal(deviceKeyFrom({ device_key: "x".repeat(128) }), "x".repeat(128));
  assert.equal(deviceKeyFrom({ device_key: "x".repeat(8) }), "x".repeat(8));
  for (const bad of ["short", "x".repeat(7), "x".repeat(129), "has space 123", "semi;colon12", "ünïcode-key", 12345678, null]) {
    assert.equal(deviceKeyFrom({ device_key: bad }), null, String(bad));
  }
  assert.equal(deviceKeyFrom({}), null);
  assert.equal(deviceKeyFrom(null), null);
});

// ------------------------------------------------------------- flow

const INPUT: GuestSessionInput = {
  deviceHash: "a".repeat(64),
  password: "derived-password",
  ipHash: "b".repeat(64),
  newEmail: "d-new@guest.kbbox.app",
};
const NEW_ID = "11111111-1111-1111-1111-111111111111";
const OLD_ID = "22222222-2222-2222-2222-222222222222";
const OLD = { userId: OLD_ID, email: "d-old@guest.kbbox.app" };

function session(userId: string): GuestSession {
  return { access_token: `at-${userId}`, refresh_token: `rt-${userId}`, expires_in: 3600, user_id: userId };
}

interface Fake {
  existing?: { userId: string; email: string } | null;
  afterRace?: { userId: string; email: string } | null;
  lookupError?: string;
  allowed?: boolean;
  createError?: string;
  registerError?: string;
  signInError?: string;
}

function steps(f: Fake = {}) {
  const calls: string[] = [];
  let lookups = 0;
  const s: GuestSessionSteps = {
    lookup: async (hash) => {
      calls.push(`lookup:${hash.slice(0, 4)}`);
      lookups++;
      if (f.lookupError) return { data: null, error: { message: f.lookupError } };
      return { data: (lookups === 1 ? f.existing : f.afterRace) ?? null, error: null };
    },
    checkIp: async (hash) => {
      calls.push(`checkIp:${hash.slice(0, 4)}`);
      return { allowed: f.allowed ?? true, error: null };
    },
    createUser: async (email, password) => {
      calls.push(`create:${email}:${password}`);
      return f.createError ? { userId: null, error: { message: f.createError } } : { userId: NEW_ID, error: null };
    },
    register: async (hash, userId, ip) => {
      calls.push(`register:${hash.slice(0, 4)}:${userId}:${ip.slice(0, 4)}`);
      return { error: f.registerError ? { message: f.registerError } : null };
    },
    deleteUser: async (userId) => {
      calls.push(`delete:${userId}`);
      return { error: null };
    },
    signIn: async (email, password) => {
      calls.push(`signIn:${email}:${password}`);
      if (f.signInError) return { session: null, error: { message: f.signInError } };
      return { session: session(email === INPUT.newEmail ? NEW_ID : OLD_ID), error: null };
    },
  };
  return { s, calls };
}

test("existing device guest: signs in with its stored email, creates nothing", async () => {
  const { s, calls } = steps({ existing: OLD });
  assert.deepEqual(await runGuestSession(INPUT, s), { ok: true, created: false, session: session(OLD_ID) });
  assert.deepEqual(calls, ["lookup:aaaa", "signIn:d-old@guest.kbbox.app:derived-password"]);
});

test("new device: checks the IP cap, creates, registers, then signs in", async () => {
  const { s, calls } = steps();
  assert.deepEqual(await runGuestSession(INPUT, s), { ok: true, created: true, session: session(NEW_ID) });
  assert.deepEqual(calls, [
    "lookup:aaaa",
    "checkIp:bbbb",
    "create:d-new@guest.kbbox.app:derived-password",
    `register:aaaa:${NEW_ID}:bbbb`,
    "signIn:d-new@guest.kbbox.app:derived-password",
  ]);
});

test("IP over the daily cap: 429 and no account is created", async () => {
  const { s, calls } = steps({ allowed: false });
  assert.deepEqual(await runGuestSession(INPUT, s), { ok: false, status: 429, error: "guest_limit" });
  assert.deepEqual(calls, ["lookup:aaaa", "checkIp:bbbb"]);
});

test("cap reached between check and register: the new account is deleted, 429", async () => {
  const { s, calls } = steps({ registerError: "guest_limit" });
  assert.deepEqual(await runGuestSession(INPUT, s), { ok: false, status: 429, error: "guest_limit" });
  assert.equal(calls.at(-1), `delete:${NEW_ID}`);
  assert.ok(!calls.some((c) => c.startsWith("signIn")));
});

test("two first launches racing: the loser deletes its account and signs in as the winner", async () => {
  const { s, calls } = steps({ registerError: "device_taken", afterRace: OLD });
  assert.deepEqual(await runGuestSession(INPUT, s), { ok: true, created: false, session: session(OLD_ID) });
  assert.deepEqual(calls.slice(-3), [`delete:${NEW_ID}`, "lookup:aaaa", "signIn:d-old@guest.kbbox.app:derived-password"]);
});

test("any other register failure: account deleted, 500", async () => {
  const { s, calls } = steps({ registerError: "boom" });
  assert.deepEqual(await runGuestSession(INPUT, s), {
    ok: false,
    status: 500,
    error: "server_error",
    step: "register",
    message: "boom",
  });
  assert.equal(calls.at(-1), `delete:${NEW_ID}`);
});

test("existing guest whose password no longer matches: 500 at sign_in, nothing created", async () => {
  const { s, calls } = steps({ existing: OLD, signInError: "Invalid login credentials" });
  assert.deepEqual(await runGuestSession(INPUT, s), {
    ok: false,
    status: 500,
    error: "server_error",
    step: "sign_in",
    message: "Invalid login credentials",
  });
  assert.ok(!calls.some((c) => c.startsWith("create")));
});

test("lookup and create failures are reported with their step", async () => {
  const a = await runGuestSession(INPUT, steps({ lookupError: "db down" }).s);
  assert.deepEqual(a, { ok: false, status: 500, error: "server_error", step: "lookup", message: "db down" });
  const { s, calls } = steps({ createError: "email exists" });
  const b = await runGuestSession(INPUT, s);
  assert.deepEqual(b, { ok: false, status: 500, error: "server_error", step: "create", message: "email exists" });
  assert.ok(!calls.some((c) => c.startsWith("register")));
});
