import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteAccount, type DeleteAccountSteps } from "../../supabase/functions/_shared/delete-account.ts";

const USER = "11111111-2222-3333-4444-555555555555";

function steps(fail?: "archive" | "delete") {
  const calls: string[] = [];
  const s: DeleteAccountSteps = {
    archive: async (id) => {
      calls.push(`archive:${id}`);
      return { error: fail === "archive" ? { message: "boom" } : null };
    },
    deleteUser: async (id) => {
      calls.push(`delete:${id}`);
      return { error: fail === "delete" ? { message: "gone wrong" } : null };
    },
  };
  return { s, calls };
}

test("archives the account before deleting it", async () => {
  const { s, calls } = steps();
  assert.deepEqual(await deleteAccount(USER, s), { ok: true });
  assert.deepEqual(calls, [`archive:${USER}`, `delete:${USER}`]);
});

test("does not delete the user when archiving fails", async () => {
  const { s, calls } = steps("archive");
  assert.deepEqual(await deleteAccount(USER, s), { ok: false, step: "archive", message: "boom" });
  assert.deepEqual(calls, [`archive:${USER}`]);
});

test("reports a failed auth deletion", async () => {
  const { s } = steps("delete");
  assert.deepEqual(await deleteAccount(USER, s), { ok: false, step: "delete", message: "gone wrong" });
});
