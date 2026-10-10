import { createClient, FunctionsHttpError } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configError =
  !url || !anonKey ? 'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy admin/.env.example to admin/.env.' : null;

/**
 * Public anon client. The signed-in admin's session (RLS + is_admin()) is
 * what authorizes writes; there is no service key in this app.
 */
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'keybox-admin-auth' },
});

/** Turns a Supabase / Edge Function error into a readable message. */
export async function errorMessage(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = await error.context.json().catch(() => null);
    return body?.error ?? `HTTP ${error.context.status}`;
  }
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}
