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

## Content updates

`series` and `episodes` are public-read, no-client-write (enforced by RLS — see
`20260802000003_rls_policies.sql`). To add or edit content today, write SQL against those tables
using the Supabase dashboard's SQL Editor or Table Editor (which uses your service-role
credentials, bypassing RLS). A proper admin tool is listed as a production follow-up in the app
repo's README.

## Non-goals (for now)

- **Real payments.** No Stripe/RevenueCat/App Store IAP integration. Coin purchases and membership
  activation in the app are still simulated at the trigger level — tapping "Confirm purchase"
  writes directly to `wallets`/`transactions`/`subscriptions` without a real charge. Wiring a real
  payment processor is the natural next step once you have a merchant/App Store Connect account.
- **Native Apple Sign In** (see above).
- **Syncing device-local settings** (notifications toggle, playback quality, subtitles-by-default,
  language) — these intentionally stay in the app's local AsyncStorage, not this database.
- **A CMS/admin portal** for managing series/episodes — direct SQL only, for now.
