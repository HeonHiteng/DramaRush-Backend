// Shared helpers for the Keybox operator scripts (run on an admin's machine,
// never shipped to the app). Secrets come from scripts/.env (gitignored).
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

export const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

config({ path: join(SCRIPTS_DIR, '.env') });

/** `--key value` pairs and bare `--flag`s. */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key.slice(2)] = true;
    } else {
      args[key.slice(2)] = next;
      i++;
    }
  }
  return args;
}

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.error(`Missing ${missing.join(', ')} in scripts/.env (see scripts/.env.example).`);
    process.exit(1);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}

/** Service-role client: bypasses RLS. Only for these admin scripts. */
export function serviceClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export function streamConfig() {
  const env = requireEnv('CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_STREAM_API_TOKEN');
  return { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_STREAM_API_TOKEN };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
