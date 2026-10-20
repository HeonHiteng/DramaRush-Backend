/**
 * Account deletion steps, kept free of Supabase/Deno specifics so the order
 * can be unit-tested: archive the watermark code first (a leak recorded
 * before deletion must stay traceable), and only delete the auth user once
 * the archive row is written. If archiving fails nothing is deleted.
 */
export interface DeleteAccountSteps {
  /** Writes private.deleted_accounts (archive_deleted_account RPC). */
  archive: (userId: string) => Promise<{ error: { message: string } | null }>;
  /** Deletes the auth user; every per-user row cascades. */
  deleteUser: (userId: string) => Promise<{ error: { message: string } | null }>;
}

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; step: "archive" | "delete"; message: string };

export async function deleteAccount(userId: string, steps: DeleteAccountSteps): Promise<DeleteAccountResult> {
  const archived = await steps.archive(userId);
  if (archived.error) return { ok: false, step: "archive", message: archived.error.message };

  const deleted = await steps.deleteUser(userId);
  if (deleted.error) return { ok: false, step: "delete", message: deleted.error.message };

  return { ok: true };
}
