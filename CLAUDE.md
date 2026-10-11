# Keybox Backend — project context for Claude

Backend for the **Keybox** short-drama app ("DramaRush" was a placeholder name; the folders and
GitHub repos `HeonHiteng/DramaRush` + `HeonHiteng/DramaRush-Backend` keep the old name). We own
this repo only; the app (`../DramaRush`, Expo) belongs to the app team — changes they need go in
`docs/frontend-api.md`, not into their repo.

## Live environment

- Supabase project **`keybox`**, ref `ogqagauogrzezfmveewk`, ap-southeast-1, org "DeepMiner-rain's
  Org". Reachable through the Supabase MCP. (The old prototype project lives in someone else's
  account and is no longer used.)
- All migrations in `supabase/migrations/` are applied; `supabase_migrations.schema_migrations`
  versions equal the filename timestamps. When applying a new migration via MCP
  `apply_migration`, afterwards `update supabase_migrations.schema_migrations set version =
  '<file timestamp>' where name = '<name>'` so the CLI stays in sync.
- Edge Functions deployed: playback-token, admin-video-upload, admin-video-delete (verify_jwt on);
  stream-webhook, stream-usage-sync (verify_jwt off — HMAC / Vault secret instead).
- Cloudflare Stream secrets are set with `scripts/cloudflare-setup.js` (see README); until they
  are, playback-token returns 500 after authorization and the webhook returns 503.

## Rules

- **Never edit an applied migration.** New change = new timestamped file.
- Clients must not write entitlement tables (wallets, transactions, subscriptions, unlocks,
  daily_mission_claims, video_assets). Add a `SECURITY DEFINER` function with
  `set search_path = ''`, `revoke execute … from public, anon`, grant to the right role.
- Every new table: enable RLS **and** `revoke all … from anon, authenticated` then grant only what
  is needed (Supabase grants everything by default).
- Internal helpers go in schema `private` (not exposed by PostgREST).
- No video URL or Stream UID may reach a client except via `playback-token`.
- Edge Function shared code (`supabase/functions/_shared/*.ts`) uses web-standard APIs only so it
  runs in Deno and in Node tests; keep `.ts` import extensions.
- After DB changes: run both `supabase/tests/*.sql` smoke tests (must end in
  `ALL_TESTS_PASSED`) and `get_advisors` (security). After function changes: `npm test`.

## Admin console

`admin/` is a standalone Vite + React app (English default, Chinese switch — strings in `src/lib/i18n.tsx`; typecheck with `npx tsc --noEmit`, never `tsc -b`, which writes .js into src) for the content team: bulk tus uploads, series
and episode management, costs/budget, abuse review. Install with `npm install --workspaces=false` inside
`admin/` (the D:\aiseahub root is an npm workspace). Preview config `keybox-admin` (port 5174) lives in
the root `.claude/launch.json`. Server side: `20261010120000_admin_console.sql` (`admin_*` RPCs, all
DEFINER + is_admin check) and the existing `admin-video-*` functions. No secrets in this app.

## Map

- Access model, setup, operations, app_config knobs: `README.md`.
- What the app calls: `docs/frontend-api.md`.
- Plan / progress log: `C:\Users\admin\.claude\plans\dramarush-backend-keybox-video-frontend-wobbly-riddle.md`.

## Not done yet

RevenueCat billing (simulate_* until then), AdMob server-side verification, Turnstile captcha,
dropping `episodes.video_uri` + the `episode-videos` bucket after the app migrates, Google OAuth on
the new project.
