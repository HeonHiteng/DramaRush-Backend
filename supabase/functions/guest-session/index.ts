/**
 * POST /functions/v1/guest-session   { "device_key": "<8–128 chars of A-Z a-z 0-9 . _ ->" }
 *
 * Signs the app in as this device's guest account, creating it on first use,
 * so a reinstall brings back the same guest (favorites, history, ad
 * unlocks). No JWT needed (verify_jwt = false): the caller is identified
 * by the device key alone, and at most guest_new_per_ip_per_day new guests
 * may be created per IP per UTC day (Turnstile to follow).
 *
 * The app then calls supabase.auth.setSession({ access_token, refresh_token })
 * and falls back to signInAnonymously() if this function fails.
 * See _shared/guest-session.ts for how key, hash, email and password relate.
 *
 * 200 { access_token, refresh_token, expires_in, user_id, created }
 * 400 bad_request · 429 guest_limit · 500 server_error
 */
import { anonClient, clientIp, env, errorResponse, json, preflight, readJson, serviceClient } from "../_shared/http.ts";
import {
  deviceCredentials,
  deviceKeyFrom,
  guestEmail,
  ipHash,
  randomSuffix,
  runGuestSession,
} from "../_shared/guest-session.ts";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const deviceKey = deviceKeyFrom(await readJson(req));
    if (!deviceKey) return errorResponse("bad_request", 400);

    const secret = env("GUEST_DEVICE_SECRET");
    const credentials = await deviceCredentials(secret, deviceKey);
    const admin = serviceClient();

    const result = await runGuestSession(
      {
        ...credentials,
        ipHash: await ipHash(secret, clientIp(req)),
        newEmail: guestEmail(credentials.deviceHash, randomSuffix()),
      },
      {
        lookup: async (deviceHash) => {
          const { data, error } = await admin.rpc("guest_session_lookup", { p_device_hash: deviceHash });
          const row = Array.isArray(data) ? data[0] : null;
          return { data: row ? { userId: row.user_id, email: row.email } : null, error };
        },
        checkIp: async (hash) => {
          const { data, error } = await admin.rpc("guest_session_check_ip", { p_ip_hash: hash });
          return { allowed: data === true, error };
        },
        createUser: async (email, password) => {
          const { data, error } = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { provider: "guest", display_name: "Guest Viewer", device: true },
          });
          return { userId: data?.user?.id ?? null, error };
        },
        register: async (deviceHash, userId, hash) => {
          const { error } = await admin.rpc("guest_session_register", {
            p_device_hash: deviceHash,
            p_user_id: userId,
            p_ip_hash: hash,
          });
          return { error };
        },
        deleteUser: async (userId) => {
          const { error } = await admin.auth.admin.deleteUser(userId);
          if (error) console.error("guest-session: could not delete unregistered guest", userId, error.message);
          return { error };
        },
        signIn: async (email, password) => {
          const { data, error } = await anonClient().auth.signInWithPassword({ email, password });
          const s = data?.session;
          return {
            session: s
              ? { access_token: s.access_token, refresh_token: s.refresh_token, expires_in: s.expires_in, user_id: s.user.id }
              : null,
            error,
          };
        },
      },
    );

    if (!result.ok) {
      if (result.status === 429) return errorResponse(result.error, 429);
      console.error(`guest-session ${result.step} failed`, result.message);
      return errorResponse("server_error", 500);
    }
    return json({ ...result.session, created: result.created });
  } catch (err) {
    console.error("guest-session error", err instanceof Error ? err.message : err);
    return errorResponse("server_error", 500);
  }
});
