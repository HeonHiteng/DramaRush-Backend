-- Row Level Security. Content tables are public-read/no-write from clients.
-- Every per-user table is readable/writable only by its owning auth.uid().

-- Content: public read, no client writes (no insert/update/delete policy = denied).
alter table public.series enable row level security;
alter table public.episodes enable row level security;

create policy "series are publicly readable"
  on public.series for select
  to anon, authenticated
  using (true);

create policy "episodes are publicly readable"
  on public.episodes for select
  to anon, authenticated
  using (true);

-- profiles: owner can read/update their own row. Inserted by handle_new_user()
-- (see 20260802000004_functions.sql), not directly by the client.
alter table public.profiles enable row level security;

create policy "users can read their own profile"
  on public.profiles for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- wallets: owner can read/update (balance changes go through the app's
-- store actions; unlock_episode_with_coins() also updates this under RLS
-- since it runs SECURITY INVOKER as the calling user).
alter table public.wallets enable row level security;

create policy "users can read their own wallet"
  on public.wallets for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can update their own wallet"
  on public.wallets for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- transactions: append-only ledger. Owner can read and insert, never
-- update/delete a past entry.
alter table public.transactions enable row level security;

create policy "users can read their own transactions"
  on public.transactions for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can insert their own transactions"
  on public.transactions for insert
  to authenticated
  with check (auth.uid() = user_id);

-- subscriptions: owner can read/update.
alter table public.subscriptions enable row level security;

create policy "users can read their own subscription"
  on public.subscriptions for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can update their own subscription"
  on public.subscriptions for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- favorites: owner has full read/write (toggle = insert or delete).
alter table public.favorites enable row level security;

create policy "users can manage their own favorites"
  on public.favorites for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- unlocks: owner can read; inserts normally go through
-- unlock_episode_with_coins() / redeem_ad_reward(), but a direct insert
-- policy is kept for free/already-unlocked bookkeeping edge cases (e.g.
-- Demo Controls' "Unlock All Episodes").
alter table public.unlocks enable row level security;

create policy "users can manage their own unlocks"
  on public.unlocks for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- watch_history: owner has full read/write (record, remove one, clear all).
alter table public.watch_history enable row level security;

create policy "users can manage their own watch history"
  on public.watch_history for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- progress: owner has full read/write (upsert on every timeUpdate tick).
alter table public.progress enable row level security;

create policy "users can manage their own progress"
  on public.progress for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- recent_searches: owner has full read/write (insert, clear all).
alter table public.recent_searches enable row level security;

create policy "users can manage their own recent searches"
  on public.recent_searches for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
