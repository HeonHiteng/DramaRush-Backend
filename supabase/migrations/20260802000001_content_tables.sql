-- DramaRush content tables: series and episodes.
-- Public read-only catalog. No client-side writes — content is managed via
-- migrations/seed data for now; a future admin tool would write here with the
-- service role key, not the anon/public client.

create type public.series_status as enum ('ongoing', 'completed');
create type public.episode_access as enum ('free', 'coin', 'subscriber', 'ad_unlock');

create table public.series (
  id text primary key,
  title text not null,
  synopsis text not null,
  genres text[] not null default '{}',
  rating numeric(2, 1) not null,
  status public.series_status not null,
  language text not null,
  poster_color_from text not null,
  poster_color_to text not null,
  banner_color_from text not null,
  banner_color_to text not null,
  cast_members jsonb not null default '[]', -- [{ "name": string, "role": string }]
  popularity integer not null default 0,
  is_new boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.episodes (
  id text primary key,
  series_id text not null references public.series (id) on delete cascade,
  number integer not null,
  title text not null,
  duration_sec integer not null,
  video_uri text not null,
  access public.episode_access not null,
  coin_price integer,
  created_at timestamptz not null default now(),
  unique (series_id, number),
  constraint coin_price_required_for_coin_episodes check (
    (access = 'coin' and coin_price is not null) or (access != 'coin')
  )
);

create index episodes_series_id_idx on public.episodes (series_id);
