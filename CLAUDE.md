# DramaRush Backend — project context for Claude

This repo is SQL only — Supabase migrations, RLS policies, functions, and seed data for the
[DramaRush](../Login Testing) app (sibling repo, folder literally named `Login Testing`). There is
no server process here; the SQL configures a Supabase project (Postgres + Auth + API), which is the
actual backend.

## Current state

The user has a live Supabase project. All 5 migrations in `supabase/migrations/` have been run
successfully (via the SQL Editor, pasted in order — no Supabase CLI used), and Anonymous Sign-Ins
is enabled. The app repo's `.env` is already pointed at this project. This repo itself has not been
pushed to GitHub yet (local-only, one commit: `c6cb3bc`).

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
```

Table shapes mirror the app's Zustand store shapes 1:1 on purpose — see the app repo's `CLAUDE.md`
and `src/store/*.ts` for how they're consumed.

## If adding a new migration

Any future schema change should be a **new** numbered file (`20260803000001_whatever.sql` or
similar, timestamp-ordered), not an edit to an existing one — these have already been applied to
the live project by hand via the SQL Editor, so there's no migration history table tracking what's
been run. Give the user the new file's contents to paste into the SQL Editor the same way, or set
up `supabase link` + `supabase db push` properly if adopting the CLI going forward.

## Non-goals (see full README for rationale)

Real payments, native Apple Sign In, a CMS/admin portal for content, syncing device-local app
settings here.
