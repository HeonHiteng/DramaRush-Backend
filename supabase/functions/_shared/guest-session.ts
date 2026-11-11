/**
 * Device guests: one guest account per phone, so reinstalling the app (or
 * clearing its storage) brings back the same guest instead of a new one.
 *
 * The app sends a stable device key; the server turns it into
 *   device_hash = hex(HMAC-SHA256(secret, device_key))          → private.device_guests
 *   password    = base64url(HMAC-SHA256(secret, "pw:" + key)) + "Aa1!"  → never leaves the server
 *   email       = d-<device_hash[0..32]>-<random>@guest.kbbox.app (synthetic, never mailed)
 * and signs in as that account. Supabase anonymous users can't be signed in
 * again once their session is lost, which is why a device guest is an email
 * account with a server-derived password instead.
 *
 * The email carries a random suffix because a device can own several guest
 * accounts over time: when its guest links Google / WhatsApp it becomes a
 * member (and keeps its address), and the next guest of that device needs a
 * new one. guest_session_lookup returns the address of the device's current
 * guest, so the suffix never has to be derived.
 *
 * Kept free of Supabase/Deno specifics (web-standard APIs only) so it runs in
 * Deno and in the Node unit tests.
 */

export const GUEST_EMAIL_DOMAIN = "guest.kbbox.app";

/** Android ID (16 hex), iOS keychain UUID, web localStorage UUID, … */
const DEVICE_KEY = /^[A-Za-z0-9._-]{8,128}$/;

export function deviceKeyFrom(body: Record<string, unknown> | null): string | null {
  const key = body?.device_key;
  return typeof key === "string" && DEVICE_KEY.test(key) ? key : null;
}

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  if (!secret) throw new Error("missing guest device secret");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return toHex(await hmac(secret, message));
}

/**
 * Appended to the derived password so it always meets Supabase Auth's
 * strongest password policy (lower, upper, digit, symbol) whatever the
 * project setting; base64url alone has no symbol in ~1 of 4 cases.
 */
export const PASSWORD_SUFFIX = "Aa1!";

export interface DeviceCredentials {
  deviceHash: string;
  password: string;
}

export async function deviceCredentials(secret: string, deviceKey: string): Promise<DeviceCredentials> {
  return {
    deviceHash: await hmacHex(secret, deviceKey),
    password: toBase64Url(await hmac(secret, `pw:${deviceKey}`)) + PASSWORD_SUFFIX,
  };
}

/** The per-IP creation counter only ever sees this hash, never the address. */
export async function ipHash(secret: string, ip: string | null): Promise<string> {
  return hmacHex(secret, `ip:${ip ?? "unknown"}`);
}

/** Address for a new guest account of this device. */
export function guestEmail(deviceHash: string, suffix: string): string {
  return `d-${deviceHash.slice(0, 32)}-${suffix}@${GUEST_EMAIL_DOMAIN}`;
}

export function randomSuffix(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(4)));
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export interface GuestSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: string;
}

type StepError = { message: string } | null;

export interface GuestSessionSteps {
  /** guest_session_lookup RPC: the device's current guest (null once it linked an identity). */
  lookup: (deviceHash: string) => Promise<{ data: { userId: string; email: string } | null; error: StepError }>;
  /** guest_session_check_ip RPC: may this IP create another guest today? */
  checkIp: (ipHash: string) => Promise<{ allowed: boolean; error: StepError }>;
  /** auth.admin.createUser (email confirmed, user_metadata provider 'guest'). */
  createUser: (email: string, password: string) => Promise<{ userId: string | null; error: StepError }>;
  /** guest_session_register RPC; raises guest_limit / device_taken. */
  register: (deviceHash: string, userId: string, ipHash: string) => Promise<{ error: StepError }>;
  /** auth.admin.deleteUser, to drop an account that could not be registered. */
  deleteUser: (userId: string) => Promise<{ error: StepError }>;
  /** signInWithPassword with the anon key. */
  signIn: (email: string, password: string) => Promise<{ session: GuestSession | null; error: StepError }>;
}

export interface GuestSessionInput extends DeviceCredentials {
  ipHash: string;
  /** Address to use if a new account has to be created (guestEmail()). */
  newEmail: string;
}

export type GuestSessionStep = "lookup" | "check_ip" | "create" | "register" | "sign_in";

export type GuestSessionResult =
  | { ok: true; created: boolean; session: GuestSession }
  | { ok: false; status: 429; error: "guest_limit" }
  | { ok: false; status: 500; error: "server_error"; step: GuestSessionStep; message: string };

const fail = (step: GuestSessionStep, message: string): GuestSessionResult => ({
  ok: false,
  status: 500,
  error: "server_error",
  step,
  message,
});

const LIMIT: GuestSessionResult = { ok: false, status: 429, error: "guest_limit" };

async function signIn(
  steps: GuestSessionSteps,
  email: string,
  password: string,
  created: boolean,
): Promise<GuestSessionResult> {
  const { session, error } = await steps.signIn(email, password);
  // For an existing guest this means its password no longer matches the
  // derived one (e.g. it was changed through updateUser).
  if (error || !session) return fail("sign_in", error?.message ?? "no session");
  return { ok: true, created, session };
}

/**
 * Existing guest of this device → sign in. Otherwise (per-IP cap permitting)
 * create the account, register it for the device, then sign in. An account
 * that can't be registered is deleted again; if another request registered a
 * guest for the same device first, that one is used.
 */
export async function runGuestSession(input: GuestSessionInput, steps: GuestSessionSteps): Promise<GuestSessionResult> {
  const found = await steps.lookup(input.deviceHash);
  if (found.error) return fail("lookup", found.error.message);
  if (found.data) return signIn(steps, found.data.email, input.password, false);

  const ip = await steps.checkIp(input.ipHash);
  if (ip.error) return fail("check_ip", ip.error.message);
  if (!ip.allowed) return LIMIT;

  const createdUser = await steps.createUser(input.newEmail, input.password);
  if (createdUser.error || !createdUser.userId) return fail("create", createdUser.error?.message ?? "no user id");
  const userId = createdUser.userId;

  const registered = await steps.register(input.deviceHash, userId, input.ipHash);
  if (registered.error) {
    await steps.deleteUser(userId);
    const message = registered.error.message;
    if (message === "guest_limit") return LIMIT;
    if (message === "device_taken") {
      const winner = await steps.lookup(input.deviceHash);
      if (winner.error) return fail("lookup", winner.error.message);
      if (winner.data) return signIn(steps, winner.data.email, input.password, false);
    }
    return fail("register", message);
  }

  return signIn(steps, input.newEmail, input.password, true);
}
