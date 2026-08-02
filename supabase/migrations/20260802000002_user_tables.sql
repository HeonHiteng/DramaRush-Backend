-- DramaRush per-user data tables. Each mirrors the shape of an existing
-- client-side Zustand store slice in the app repo (src/store/*.ts), so the
-- app-side data-access rewrite is close to 1:1.
--
-- Deliberately NOT included here (see backend README "Non-goals"): payment
-- processing tables (no Stripe/RevenueCat integration yet), and device-local
-- settings (notifications/playback/language prefs stay in AsyncStorage only).

create extension if not exists "pgcrypto";

-- profiles: mirrors src/types/user.ts MockUser (minus id/createdAt, which
-- come from auth.users itself).
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_seed text not null,
  provider text not null, -- 'guest' | 'email' | 'google' | 'apple'
  created_at timestamptz not null default now()
);

-- wallets: mirrors src/store/walletStore.ts `balance`.
create table public.wallets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance integer not null default 150,
  updated_at timestamptz not null default now()
);

-- transactions: mirrors src/types/wallet.ts Transaction.
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('purchase', 'unlock', 'bonus', 'reward', 'reset')),
  label text not null,
  amount integer not null,
  created_at timestamptz not null default now()
);

create index transactions_user_id_created_at_idx on public.transactions (user_id, created_at desc);

-- subscriptions: mirrors src/store/subscriptionStore.ts.
create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  is_active boolean not null default false,
  plan_id text check (plan_id in ('monthly', 'annual')),
  started_at timestamptz,
  renews_at timestamptz
);

-- favorites: mirrors src/store/libraryStore.ts `favoriteSeriesIds`.
create table public.favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  series_id text not null references public.series (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, series_id)
);

-- unlocks: mirrors src/store/libraryStore.ts `unlockedEpisodeIds`.
create table public.unlocks (
  user_id uuid not null references auth.users (id) on delete cascade,
  episode_id text not null references public.episodes (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, episode_id)
);

-- watch_history: mirrors src/store/libraryStore.ts HistoryEntry. Primary key
-- on (user_id, episode_id) matches recordHistory()'s de-dupe-by-episode
-- behavior — re-watching just bumps watched_at via upsert.
create table public.watch_history (
  user_id uuid not null references auth.users (id) on delete cascade,
  episode_id text not null references public.episodes (id) on delete cascade,
  series_id text not null references public.series (id) on delete cascade,
  watched_at timestamptz not null default now(),
  primary key (user_id, episode_id)
);

create index watch_history_user_id_watched_at_idx on public.watch_history (user_id, watched_at desc);

-- progress: mirrors src/store/libraryStore.ts EpisodeProgress.
create table public.progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  episode_id text not null references public.episodes (id) on delete cascade,
  position_sec numeric not null default 0,
  duration_sec numeric not null default 0,
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, episode_id)
);

-- recent_searches: mirrors src/store/searchStore.ts `recentSearches`. Capped
-- to the last 10 per user by the app (same slice(0, 10) behavior as today),
-- not enforced in the schema.
create table public.recent_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  query text not null,
  created_at timestamptz not null default now()
);

create index recent_searches_user_id_created_at_idx on public.recent_searches (user_id, created_at desc);
