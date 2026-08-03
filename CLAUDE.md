# DramaRush Backend — project context for Claude

This repo is Supabase migrations + a small Node tooling script for the
[DramaRush](../Login Testing) app (sibling repo, folder literally named `Login Testing`). There is
no server process here; the SQL configures a Supabase project (Postgres + Auth + Storage + API),
which is the actual backend. Pushed to `https://github.com/HeonHiteng/DramaRush-Backend`.

## Current state

Live Supabase project, all 6 migrations run successfully via the SQL Editor (pasted in order, no
Supabase CLI used — no migration history table tracking what's applied). Fully smoke-tested end to
end against the live app: guest/email auth, content loading, coin unlocks, ad-unlock rewards,
favorites, watch history, search, subscriptions, and Reset Prototype all verified working. Google
OAuth provider is configured and working (redirects to Google's real sign-in). Apple sign-in is not
set up (needs a paid Apple Developer account). Email confirmation is currently **off** (toggled off
deliberately for easier dev testing — no password-reset flow exists in the app yet either, so no
outbound email is triggered anywhere right now). Anonymous Sign-Ins is enabled.

**All 54 episodes still point at placeholder stock video URLs** (Big Buck Bunny, w3schools demo
clips, an MDN sample clip, recycled across episodes) — there is no real short-drama footage yet.
`scripts/add-episode.js` (added this session) is the pipeline for replacing them once real video
files exist; nobody has run it against the live project yet since there's no real content to test
with as of this writing.

## What's here

```
supabase/
  config.toml                          Supabase CLI project config (unused so far — SQL Editor path was used instead)
  migrations/
    20260802000001_content_tables.sql  series, episodes (public read-only)
    20260802000002_user_tables.sql     profiles, wallets, transactions, subscriptions,
                                        favorites, unlocks, watch_history, progress,
                                        recent_searches (owner-only via RLS)
    20260802000003_rls_policies.sql    Row Level Security for every table above
    20260802000004_functions.sql       handle_new_user() signup trigger,
                                        unlock_episode_with_coins(), redeem_ad_reward()
    20260802000005_seed_content.sql    the 8 mock series / 54 episodes, generated from the
                                        app repo's (now-deleted) src/data/seriesData.ts
    20260803000001_video_storage.sql   public 'episode-videos' storage bucket for real video files
scripts/
  add-episode.js                       uploads a local video file to the episode-videos bucket and
                                        upserts the matching episodes row, using the service role
                                        key (bypasses RLS) — see README "Adding content"
  .env.example                         template for scripts/.env (SUPABASE_URL +
                                        SUPABASE_SERVICE_ROLE_KEY, gitignored — never commit)
```

Table shapes mirror the app's Zustand store shapes 1:1 on purpose — see the app repo's `CLAUDE.md`
and `src/store/*.ts` for how they're consumed.

## If adding a new migration

Any future schema change should be a **new** numbered file (`20260803000002_whatever.sql` or
similar, timestamp-ordered), not an edit to an existing one — these have already been applied to
the live project by hand via the SQL Editor, so there's no migration history table tracking what's
been run. Give the user the new file's contents to paste into the SQL Editor the same way, or set
up `supabase link` + `supabase db push` properly if adopting the CLI going forward.

## Non-goals (see full README for rationale)

Real payments, native Apple Sign In, a CMS/admin portal for content (the add-episode script covers
"add one episode" only — adding a new series still needs a hand-written SQL insert), custom SMTP
(deferred — not blocking anything since email confirmation is off and no email-dependent features
exist yet), syncing device-local app settings here.
