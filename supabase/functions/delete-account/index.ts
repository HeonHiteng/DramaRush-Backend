/**
 * POST /functions/v1/delete-account   (no body)
 *
 * Deletes the caller's own account (store requirement). Guests may call it
 * too — it simply removes the guest. The watermark code is archived in
 * private.deleted_accounts first, then the auth user is deleted and every
 * per-user row (profile, wallet, unlocks, history, …) cascades. Welcome-bonus
 * records survive (user_id set null), so signing up again with the same
 * Google account or phone number earns no second bonus.
 *
 * After 200 the app should drop its local session (supabase.auth.signOut
 * with scope 'local'); the old access token is rejected from now on.
 *
 * 200 { deleted: true } · 401 not_authenticated · 500 server_error
 */
import { errorResponse, getCaller, json, preflight, serviceClient } from "../_shared/http.ts";
import { deleteAccount } from "../_shared/delete-account.ts";

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  try {
    const admin = serviceClient();
    const user = await getCaller(req, admin);
    if (!user) return errorResponse("not_authenticated", 401);

    const result = await deleteAccount(user.id, {
      archive: async (userId) => {
        const { error } = await admin.rpc("archive_deleted_account", { p_user_id: userId });
        return { error };
      },
      deleteUser: async (userId) => {
        const { error } = await admin.auth.admin.deleteUser(userId);
        return { error };
      },
    });

    if (!result.ok) {
      console.error(`delete-account ${result.step} failed`, result.message);
      return errorResponse("server_error", 500);
    }
    return json({ deleted: true });
  } catch (err) {
    console.error("delete-account error", err instanceof Error ? err.message : err);
    return errorResponse("server_error", 500);
  }
});
