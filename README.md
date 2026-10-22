# KBbox Backend (Supabase + Cloudflare Stream)

Backend for the [KBbox](https://github.com/HeonHiteng/DramaRush) vertical short-drama app (renamed from
"Keybox" on 2026-10-14; the Supabase project, Vercel URL and `keybox://` scheme keep the old name)
(the app repo is still named `DramaRush`, the old placeholder name). There is no server to run:

- **Supabase** — Postgres schema, Row Level Security, auth, and Edge Functions (`supabase/`).
- **Cloudflare Stream** — stores and streams every episode video. Videos require signed URLs; the
  only way to get one is the `playback-token` Edge Function, after the database has checked that
  the caller may watch.

The app team's integration guide is **[docs/frontend-api.md](docs/frontend-api.md)**.

Live project: `keybox` — ref `ogqagauogrzezfmveewk`, region ap-southeast-1 (Singapore).

## How access control works

```
app ──playback-token(episode_id)──▶ Edge Function ──authorize_playback()──▶ Postgres
                                         │   blocked? entitled? video ready? budget? rate limit?
                                         ▼
                         signs a 15-min Stream token locally (RS256 signing key)
                                         ▼
app ◀── hls_url (customer-xxx.cloudflarestream.com/<token>/manifest/video.m3u8) + watermark code
```

- Clients can only **read** wallets, transactions, unlocks, subscriptions. Every change goes
  through `SECURITY DEFINER` functions (`unlock_episode_with_coins`, `redeem_ad_reward`,
  `claim_daily_mission`, `simulate_*`, …) — see `20261009150000_lock_down_entitlements.sql`.
- Stream video IDs live in `video_assets`, which normal users cannot read at all.
- `authorize_playback` logs every decision (`playback_events`), rate-limits per user and
  temporarily blocks scrapers (`abuse_flags`), and enforces a daily delivered-minutes budget.
- Every video gets the Keybox logo burned in (Cloudflare watermark profile); the app overlays the
  viewer's `public_code`, so a leaked screen recording points to an account.
- No DRM: a paying user with tools can still save an episode they are entitled to while its token
  is valid. The layers above make bulk scraping hard and leaks traceable.

## User rules

Since `20261019120000_account_rules.sql` and `20261020120000_device_guests.sql` (details for the
app: `docs/frontend-api.md` §2/§3/§5):

- **Guests** — `private.is_guest()`: anonymous sessions *and* device guests — have 0 coins, watch
  **free** episodes in full and may **unlock ad episodes** (`redeem_ad_reward`, same daily cap).
  Coin / subscriber episodes give playback-token 403 `account_required`; coin unlocks, the daily
  mission and (simulated) purchases / memberships raise `account_required`.
- **One guest per phone.** The app signs guests in through the `guest-session` Edge Function with a
  stable device key. The function keeps one guest account per device (`private.device_guests`,
  keyed by HMAC(`GUEST_DEVICE_SECRET`, key)): an email account with a synthetic
  `d-…@guest.kbbox.app` address, a server-derived password and profile provider `guest`, so a
  reinstall signs back into the same guest. At most `guest_new_per_ip_per_day` (20) new device
  guests per IP per UTC day (429 `guest_limit`). The synthetic address never counts as an
  identity (no welcome bonus). Once the guest links Google / a phone it is a member like any other
  and the device gets a fresh guest next time it needs one. `signInAnonymously` stays the app's
  fallback.
- **Every account starts with 0 coins.** The welcome bonus (`welcome_bonus_coins`, 150) is paid by
  a trigger on `auth.identities` when Google / phone / Apple / email is attached (sign-up or a
  guest linking it): once per account and once per identity ever
  (`private.welcome_bonus_grants`, which survives account deletion). Accounts that existed
  before the migration are marked as already paid.
- Profiles follow the link: `provider` from Supabase, the Google name replaces a default name.
- **Membership:** the plan bonus is paid at most once per billing period; cancelling keeps access
  until `renews_at`; the `keybox-expire-subscriptions` cron job switches expired rows off hourly.
- **Account deletion:** the `delete-account` Edge Function archives the watermark code in
  `private.deleted_accounts`, then deletes the auth user (everything per-user cascades).

## What's here

```
supabase/
  config.toml
  migrations/
    20260802000001…20260813000001     original schema (content, users, RLS, RPCs, seed,
                                        admin role, posters, daily mission, admin-escalation fix)
    20261009150000_lock_down_entitlements.sql   server-only writes for coins/unlocks/membership,
                                        app_config, coin_packages, subscription_plans,
                                        simulated purchase RPCs, profiles.public_code
    20261009160000_video_assets.sql    video_assets (Stream IDs), episodes.published, can_watch
    20261009170000_playback_guard.sql  authorize_playback, playback_events, abuse_flags,
                                        stream_usage_daily, cost guard
    20261009180000_scheduled_jobs.sql  pg_cron: hourly usage sync, daily log pruning
    …
    20261019120000_account_rules.sql   0 starting coins, welcome bonus per identity, guest
                                        account_required, membership bonus once
                                        per period + expiry job, deleted-account archive
    20261020120000_device_guests.sql   one guest account per device (guest-session),
                                        private.is_guest() = anonymous or provider 'guest',
                                        guests: free + ad episodes in full
  functions/
    _shared/                           http helpers, Stream API client, token signing, webhook HMAC
    playback-token/                    the only source of playable URLs
    delete-account/                    the caller deletes their own account (guests too)
    guest-session/                     device key → the device's guest session (no JWT; per-IP cap)
    admin-video-upload/                one-time Cloudflare upload URL for an episode (admins)
    admin-video-delete/                remove videos from Cloudflare + DB (admins)
    stream-webhook/                    Cloudflare "video ready/error" callback (HMAC-verified)
    stream-usage-sync/                 hourly: minutes delivered → stream_usage_daily
  tests/                               SQL smoke tests (run as postgres; they roll back)
scripts/
  cloudflare-setup.js                  one-time: signing key, watermark, webhook, secrets file
  upload-series.js                     bulk upload a folder of episodes (resumable)
  add-poster.js                        upload a series poster (public bucket)
  backfill-video-dimensions.js         one-off: picture size for videos uploaded before 2026-10-12
tests/                                 unit tests (node --test)
docs/frontend-api.md                   what the app must call / change
```

## Setup (new project)

1. **Database.** Apply every file in `supabase/migrations/` in order
   (`supabase link --project-ref <ref>` then `supabase db push`, or the Supabase MCP / SQL Editor).
   The live project's `supabase_migrations.schema_migrations` versions match these filenames.
2. **Auth.** Authentication → Sign In / Providers → enable **Anonymous Sign-Ins** (guest mode).
3. **Cloudflare.** Enable Stream on the Cloudflare account (a separate account for Keybox is
   recommended: Stream allows only one webhook per account). Create API tokens:
   - *Stream: Edit* → `CLOUDFLARE_STREAM_API_TOKEN`
   - *Account Analytics: Read* → `CLOUDFLARE_ANALYTICS_API_TOKEN` (cost guard)
4. **Scripts env.** `cp scripts/.env.example scripts/.env` and fill it in (service role key —
   never commit). `npm install` (Node ≥ 22.18).
5. **Cloudflare objects + secrets.**
   ```bash
   npm run cloudflare-setup -- --customer-code customer-xxxx --watermark ./keybox-logo.png
   npx supabase secrets set --env-file scripts/.secrets/function-secrets.env --project-ref <ref>
   ```
   Optional: `--countries MY,SG` (token geo-restriction), `--origins keybox.app,*.keybox.app`.
   Plus `GUEST_DEVICE_SECRET` for `guest-session` (a long random string, e.g.
   `openssl rand -base64 48`; set it once and never change it — every device guest's hash and
   password derive from it, so a new value strands every existing device guest):
   `npx supabase secrets set GUEST_DEVICE_SECRET=… --project-ref <ref>`.
6. **Functions.** Deploy everything in `supabase/functions/` (`supabase functions deploy`, or the
   MCP). `config.toml` sets which ones skip JWT verification.
7. **Cron.** Set `app_config.functions_base_url` to `https://<ref>.supabase.co/functions/v1`
   (done for the live project). The cron secret is generated in Vault by the migration.
8. **First admin** (SQL Editor):
   ```sql
   update public.profiles set is_admin = true
   where user_id = (select id from auth.users where email = 'you@example.com' and email_confirmed_at is not null);
   ```

## Admin console (`admin/`)

A desktop web app for the content team (Vite + React). English by default; the **EN | 中文** switch
(sidebar, and top-right of the sign-in page) changes the language and is remembered per browser.
All UI text lives in `admin/src/lib/i18n.tsx`; a test fails if Chinese is hard-coded anywhere else.

- **总览** — series/episodes/videos, storage minutes, today's delivered minutes vs budget, open abuse flags.
- **剧集与上传** — create/edit series (poster upload), and per series: **bulk upload** (drop a folder of
  `ep01.mp4…`, set the paywall rule — first N free, listed episodes ad-unlock, rest coins or members —
  then 2 resumable tus uploads at a time with progress; auto-publish when Cloudflare finishes),
  episode table (publish toggle, edit title/paywall, replace or upload a video, delete).
- **成本与预算** — 30-day delivered minutes chart with estimated cost, storage cost, and every
  `app_config` knob (budget, rate limits, starting coins, simulated payments).
- **异常与日志** — open abuse flags with one-click unblock, **find the account behind a watermark
  code** (or an email), its playback log, and manual playback blocks.

Sign-in is passwordless: enter the email, open the one-time link (Supabase magic link, PKCE — open it in
the same browser). The form never creates accounts and does not reveal which emails exist. Only accounts
with `profiles.is_admin = true` get in; everyone else is signed out immediately, and the database enforces the same through RLS and the `admin_*` RPCs
(`20261010120000_admin_console.sql`). The app holds only the public anon key.

```bash
cd admin
npm install --workspaces=false   # the repo root is an npm workspace; keep admin standalone
cp .env.example .env             # Supabase URL + anon key (public values)
npm run dev                      # http://localhost:5174
npm test                         # episode file matching, paywall rules, cost maths
npm run build                    # static site in admin/dist (deploy anywhere, e.g. Vercel)
```

**Hosted:** https://keybox-backend.vercel.app (Vercel project `keybox-backend`, team "Rain's projects",
not Git-connected). Redeploy from `admin/` with `npx vercel deploy --prod`; the build reads the public
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from the project's environment variables. The site URL
must be listed in Supabase → Authentication → URL Configuration → Redirect URLs, or sign-in links
fall back to the Site URL.

Make someone an admin: create the account (Supabase dashboard → Authentication → Add user, no password
needed, tick *Auto Confirm User*), then run the SQL under "First admin" above with their email. The
site's URL (e.g. `http://localhost:5174`, later the deployed domain) must be in Authentication → URL
Configuration → Redirect URLs. Supabase's built-in mailer only sends a few emails per hour; set up
custom SMTP before more people use it.

## Adding content

**A whole series** (folder of `ep01.mp4`, `ep02.mp4`, …; the series row must exist):
```bash
npm run upload-series -- --series crimson-contract --dir "D:/videos/crimson" \
  --access "1-5:free,6-8:ad_unlock,9-:coin:20" --publish
```
Resumable: re-run the same command after an interruption. `--publish` waits for Cloudflare to
finish and publishes ready episodes. `--replace` re-uploads episodes that already have a video.

**Single episodes** from the app's `/admin` screens (uses `admin-video-upload`).

**Demo videos for development:** `npm run seed-demo-videos` attaches a 10-second sample clip
(through the normal signed/webhook path) to every published episode that has no video. The live
project's 54 seed episodes have them. Real uploads replace them automatically.

**New series:** insert into `public.series` (admin UI or SQL; see the seed for column shapes).
Posters: `npm run add-poster -- --series <id> --file poster.jpg`.

## Operating it

All knobs are rows in `public.app_config` (change with SQL, takes effect immediately):

| key | default | |
|---|---|---|
| `simulated_payments` | `true` | turn **off** before launch (disables `simulate_*`, `reset_my_data`, `demo_*`) |
| `starting_coins_guest` / `_member` | 0 / 0 | no longer read — every account starts with 0 coins |
| `welcome_bonus_coins` | 150 | paid once per account / per identity when Google, phone, Apple or email is attached |
| `guest_new_per_ip_per_day` | 20 | new device guests (`guest-session`) per client IP per UTC day; then 429 `guest_limit` (not public) |
| `daily_mission_reward` | 20 | |
| `ad_unlocks_per_day` | 20 | until ads are verified server-side |
| `playback_token_ttl_seconds` | 900 | |
| `playback_max_tokens_per_10min` | 60 | breach → playback blocked + `abuse_flags` row |
| `playback_max_episodes_per_hour` | 80 | |
| `playback_block_minutes` | 60 | |
| `daily_minutes_budget` | 0 (off) | Stream minutes/day; at `budget_soft_ratio` (0.8) free episodes stop, at 100% free + ad-unlock stop; paid keep playing |

Cost reference (Cloudflare Stream): storage $5 / 1,000 min / month, delivery $1 / 1,000 min
delivered (buffering counts), encoding free.

Watch: `abuse_flags` (clear with `admin_resolve_abuse_flag`), `playback_events`,
`stream_usage_daily`, `video_assets` where `status = 'error'`.

## Tests

```bash
npm test                         # unit tests: token signing, webhook HMAC, Stream API client, tus upload
```
SQL smoke tests: run `supabase/tests/*.sql` as `postgres` (SQL Editor / MCP). Each ends with
`ALL_TESTS_PASSED` raised as an error so everything rolls back.

## Not done yet

- Real App Store / Google Play billing (RevenueCat webhook) — purchases are simulated server-side.
- Server-side ad verification (AdMob SSV) for `redeem_ad_reward` / daily mission.
- Cloudflare Turnstile captcha on guest sign-in (`guest-session` + anonymous; needs app support).
- Dropping `episodes.video_uri` and the old public `episode-videos` bucket once the app has
  switched to `playback-token`.
- Native Apple Sign In; Google OAuth on the new project.
