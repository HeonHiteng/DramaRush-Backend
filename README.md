# DramaRush Backend (Supabase)

Postgres schema, Row Level Security, and seed data for the [DramaRush](https://github.com/HeonHiteng/DramaRush)
app. This is not a server you run yourself — it's the SQL that configures a [Supabase](https://supabase.com)
project, which provides the database, auth, and API.

## What's here

```
supabase/
  config.toml                          Supabase CLI project config
  migrations/
    20260802000001_content_tables.sql  series, episodes (public read-only)
    20260802000002_user_tables.sql     profiles, wallets, transactions, subscriptions,
                                        favorites, unlocks, watch_history, progress,
                                        recent_searches (owner-only)
    20260802000003_rls_policies.sql    Row Level Security for every table above
    20260802000004_functions.sql       handle_new_user() signup trigger,
                                        unlock_episode_with_coins(), redeem_ad_reward()
    20260802000005_seed_content.sql    the 8 mock series / 54 episodes from the app repo
    20260803000001_video_storage.sql   public 'episode-videos' storage bucket for real video files
scripts/
  add-episode.js                       uploads a video file + upserts its episodes row (see below)
  .env.example                         template for scripts/.env (service role key, gitignored)
```

## One-time setup

1. **Create a free Supabase project** at [supabase.com/dashboard](https://supabase.com/dashboard/projects)
   (New Project → pick a name/region/password). Wait for it to finish provisioning.

2. **Install the Supabase CLI** if you don't have it:
   ```bash
   npm install -g supabase
   ```

3. **Link this repo to your project** (from this folder):
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```
   The project ref is in your project's dashboard URL: `supabase.com/dashboard/project/<project-ref>`.

4. **Push the schema**:
   ```bash
   supabase db push
   ```
   This runs every file in `supabase/migrations/` in order, creating the tables, RLS policies,
   functions, and seeding the 8 mock series. Safe to re-run — the seed uses `on conflict do nothing`.

   *(No CLI? You can instead paste each migration file's contents, in order, into the Supabase
   dashboard's SQL Editor and run them one at a time.)*

5. **Get your API credentials** from Project Settings → API in the dashboard: the **Project URL**
   and the **anon/public key**. The app repo needs these as `EXPO_PUBLIC_SUPABASE_URL` and
   `EXPO_PUBLIC_SUPABASE_ANON_KEY` — see that repo's `.env.example`.

6. **Enable anonymous sign-ins** (used for "Continue as Guest"): Authentication → Sign In / Providers
   → toggle **Anonymous Sign-Ins** on.

## Optional: Google / Apple sign-in

The app ships with Google and Apple sign-in buttons wired to Supabase's OAuth flow, but they're
inert until you configure the providers:

- **Google**: create an OAuth Client ID in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
  (type: Web application), add the redirect URL Supabase gives you (Authentication → Providers →
  Google) as an authorized redirect URI, then paste the client ID/secret into that same Supabase
  provider screen.
- **Apple**: requires an active Apple Developer Program membership. Follow
  [Supabase's Apple provider guide](https://supabase.com/docs/guides/auth/social-login/auth-apple)
  to create a Services ID + key, then configure it the same way under Authentication → Providers →
  Apple. Note: Apple's App Store guidelines expect native Sign In with Apple (not just OAuth-in-a-
  browser) on iOS if other social logins are offered — treat this as a pre-launch follow-up, not
  required for development/testing.

Until configured, tapping those buttons in the app will surface Supabase's "provider not enabled"
error — expected, not a bug.

## Adding content (real videos)

`series` and `episodes` are public-read, no-client-write (enforced by RLS — see
`20260802000003_rls_policies.sql`). `episodes.video_uri` is just a plain URL — the app doesn't care
where it's hosted, only that it resolves to a playable `.mp4`. Video files are stored in a public
Supabase Storage bucket (`episode-videos`, created by `20260803000001_video_storage.sql`); uploads
are denied for regular clients by default (no insert policy on `storage.objects` for this bucket)
and only happen through `scripts/add-episode.js` using the service-role key, which bypasses RLS.

**One-time setup for the script:**
```bash
npm install                       # from this repo's root
cp scripts/.env.example scripts/.env
```
Fill in `scripts/.env` with your Project URL and **service_role** key (Project Settings → API —
not the anon key; this one bypasses RLS, so never commit it or use it in the app).

**Adding an episode:**
```bash
npm run add-episode -- \
  --series crimson-contract --number 9 --title "The Reckoning" \
  --file ./my-episode.mp4 --duration 620 --access coin --coin-price 20
```
This uploads the file to `episode-videos/<series>/ep<number>.mp4`, then upserts the matching row in
`episodes` (safe to re-run for the same `--series`/`--number` — it'll overwrite both the file and
the row). `--access` is one of `free` / `coin` / `subscriber` / `ad_unlock`; `--coin-price` is
required only for `coin`. Pass `--id <episode-id>` to override the auto-generated
`<series>-ep<number>` id.

Supabase's free tier caps individual file uploads at 50MB — compress episodes accordingly, or
upgrade the project plan if a clip needs to be larger.

For adding a brand-new **series** (not just an episode), there's no script yet — write a plain
`insert into public.series (...)` statement (see `20260802000005_seed_content.sql` for the column
shapes) and run it via the SQL Editor, same as the original seed data.

The app itself also has an in-app admin panel (`/admin` in the Expo app) for creating/editing
series and episodes, including uploading video files, from the browser using the signed-in
admin's own session — no service role key needed for day-to-day content work. This script remains
useful for bulk/scripted uploads.

**Granting admin access:** `is_admin` on `profiles` starts `false` for everyone and can only be
flipped via the Supabase SQL Editor (or another service-role/superuser session) — a trigger added
in `20260813000001_prevent_admin_self_escalation.sql` blocks any authenticated client request from
setting its own `is_admin`, closing a self-escalation hole that existed in the original
`admin_role` migration (RLS there only checked row ownership, not which column changed). To grant
the first admin, run in the SQL Editor:

```sql
update public.profiles
set is_admin = true
where user_id = (select id from auth.users where email = 'you@example.com');
```

(For a guest/anonymous account with no email, look up the id in the `auth.users` table by
`created_at` instead.) Once you're an admin, `/admin` becomes reachable from the app; you can
promote further admins the same way, or extend the admin UI to do it in-app later.

## Non-goals (for now)

- **Real payments.** No Stripe/RevenueCat/App Store IAP integration. Coin purchases and membership
  activation in the app are still simulated at the trigger level — tapping "Confirm purchase"
  writes directly to `wallets`/`transactions`/`subscriptions` without a real charge. Wiring a real
  payment processor is the natural next step once you have a merchant/App Store Connect account.
- **Native Apple Sign In** (see above).
- **Syncing device-local settings** (notifications toggle, playback quality, subtitles-by-default,
  language) — these intentionally stay in the app's local AsyncStorage, not this database.
- **A CMS/admin portal** for managing series/episodes — direct SQL only, for now.
