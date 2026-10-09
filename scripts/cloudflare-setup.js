// One-time Cloudflare Stream setup for a Keybox Supabase project.
//
//   npm run cloudflare-setup -- --customer-code customer-xxxxxxxx \
//     [--watermark ./keybox-logo.png] [--countries MY,SG] [--origins keybox.app,*.keybox.app]
//     [--skip-key] [--skip-webhook]
//
// Needs in scripts/.env: SUPABASE_URL, CLOUDFLARE_ACCOUNT_ID,
// CLOUDFLARE_STREAM_API_TOKEN (Stream:Edit) and optionally
// CLOUDFLARE_ANALYTICS_API_TOKEN (Account Analytics:Read, for the cost guard).
//
// It creates, via the Cloudflare API:
//   * a Stream signing key (playback tokens are signed locally with it)
//   * a watermark profile from your logo PNG (burned into every upload)
//   * the account's Stream webhook -> <SUPABASE_URL>/functions/v1/stream-webhook
// and writes every Edge Function secret to scripts/.secrets/function-secrets.env
// (gitignored). Then set them on the project with ONE of:
//   npx supabase secrets set --env-file scripts/.secrets/function-secrets.env --project-ref <ref>
//   Supabase dashboard -> Edge Functions -> Secrets (paste each line)
//
// Re-running keeps values it doesn't regenerate. Note: Cloudflare allows only
// ONE webhook per account, so --skip-webhook if this account's webhook is
// already used by something else.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SCRIPTS_DIR, parseArgs, requireEnv } from './lib.js';

const SECRETS_DIR = join(SCRIPTS_DIR, '.secrets');
const SECRETS_FILE = join(SECRETS_DIR, 'function-secrets.env');

async function cf(env, method, path, body, isForm = false) {
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` };
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream${path}`, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.success === false) {
    const msg = (payload.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${msg}`);
  }
  return payload.result;
}

async function readExisting() {
  try {
    const text = await readFile(SECRETS_FILE, 'utf8');
    return Object.fromEntries(
      text.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = requireEnv('SUPABASE_URL', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_STREAM_API_TOKEN');
  const secrets = await readExisting();

  const customerCode = args['customer-code'] || secrets.CLOUDFLARE_STREAM_CUSTOMER_CODE;
  if (!customerCode || !/^customer-[a-z0-9]+$/.test(customerCode)) {
    console.error('Pass --customer-code customer-xxxx (Cloudflare dashboard -> Stream -> any video\'s URL shows it).');
    process.exit(1);
  }

  secrets.CLOUDFLARE_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
  secrets.CLOUDFLARE_STREAM_API_TOKEN = env.CLOUDFLARE_STREAM_API_TOKEN;
  secrets.CLOUDFLARE_STREAM_CUSTOMER_CODE = customerCode;
  if (process.env.CLOUDFLARE_ANALYTICS_API_TOKEN) secrets.CLOUDFLARE_ANALYTICS_API_TOKEN = process.env.CLOUDFLARE_ANALYTICS_API_TOKEN;
  if (args.countries) secrets.STREAM_ALLOWED_COUNTRIES = String(args.countries).toUpperCase();
  if (args.origins) secrets.STREAM_ALLOWED_ORIGINS = String(args.origins);

  if (!args['skip-key']) {
    const key = await cf(env, 'POST', '/keys');
    secrets.STREAM_SIGNING_KEY_ID = key.id;
    secrets.STREAM_SIGNING_JWK = key.jwk;
    console.log(`✓ Signing key created: ${key.id}`);
  }

  if (args.watermark) {
    const form = new FormData();
    form.append('file', new Blob([await readFile(args.watermark)], { type: 'image/png' }), basename(args.watermark));
    form.append('name', 'Keybox');
    form.append('opacity', '0.6');
    form.append('padding', '0.04');
    form.append('scale', '0.12');
    form.append('position', 'upperRight');
    const wm = await cf(env, 'POST', '/watermarks', form, true);
    secrets.STREAM_WATERMARK_UID = wm.uid;
    console.log(`✓ Watermark profile created: ${wm.uid}  (also add STREAM_WATERMARK_UID=${wm.uid} to scripts/.env for upload-series)`);
  }

  if (!args['skip-webhook']) {
    const notificationUrl = `${env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/stream-webhook`;
    const hook = await cf(env, 'PUT', '/webhook', { notificationUrl });
    secrets.STREAM_WEBHOOK_SECRET = hook.secret;
    console.log(`✓ Webhook set: ${notificationUrl}`);
  }

  await mkdir(SECRETS_DIR, { recursive: true });
  const lines = Object.entries(secrets).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`);
  await writeFile(SECRETS_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });

  const ref = new URL(env.SUPABASE_URL).hostname.split('.')[0];
  console.log(`\nWrote ${lines.length} secrets to scripts/.secrets/function-secrets.env (gitignored — never commit or share it).`);
  console.log('Set them on the project:');
  console.log(`  npx supabase secrets set --env-file scripts/.secrets/function-secrets.env --project-ref ${ref}`);
  console.log('or paste each line into: Supabase dashboard -> Edge Functions -> Secrets');
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
