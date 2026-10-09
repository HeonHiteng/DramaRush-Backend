-- Keybox: episode videos move to Cloudflare Stream.
--
-- video_assets holds the Stream video ID for each episode. It is never
-- readable by normal users: the only way to play a video is the
-- playback-token Edge Function, which checks can_watch() and then signs a
-- short-lived Stream token. Writes come only from Edge Functions / scripts
-- using the service role key.
--
-- An episode can briefly have more than one asset (a replacement upload
-- while the old one is still live). Playback uses the newest 'ready' asset;
-- the stream-webhook function deletes older ones once a replacement is ready.

create type public.video_status as enum ('pending_upload', 'processing', 'ready', 'error');

create table public.video_assets (
  id uuid primary key default gen_random_uuid(),
  episode_id text not null references public.episodes (id) on delete cascade,
  provider text not null default 'cloudflare_stream' check (provider in ('cloudflare_stream')),
  -- Cloudflare Stream video UID: 32 lowercase hex chars.
  provider_uid text not null unique check (provider_uid ~ '^[0-9a-f]{32}$'),
  status public.video_status not null default 'pending_upload',
  duration_sec numeric,
  error_reason text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz
);

create index video_assets_episode_id_idx on public.video_assets (episode_id, ready_at desc nulls last);

alter table public.video_assets enable row level security;
revoke all on public.video_assets from anon, authenticated;
grant select on public.video_assets to authenticated;

-- Admins can see upload status in the admin UI; nobody else can read it.
create policy "admins can read video assets"
  on public.video_assets for select
  to authenticated
  using (public.is_admin());

-- The newest ready asset for an episode (null if none).
create function private.current_video(p_episode_id text)
returns public.video_assets
language sql
stable
set search_path = ''
as $$
  select *
  from public.video_assets
  where episode_id = p_episode_id and status = 'ready'
  order by ready_at desc nulls last, created_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- episodes: video_uri is no longer required (Stream episodes leave it null so
-- no playable URL ever reaches the client), and episodes get a published
-- switch so a half-uploaded episode isn't shown to users.
-- ---------------------------------------------------------------------------
alter table public.episodes alter column video_uri drop not null;

alter table public.episodes add column published boolean not null default false;
update public.episodes set published = true;

drop policy "episodes are publicly readable" on public.episodes;

create policy "anon can read published episodes"
  on public.episodes for select
  to anon
  using (published);

create policy "users can read published episodes, admins all"
  on public.episodes for select
  to authenticated
  using (published or public.is_admin());

-- An unpublished episode can't be watched or unlocked by normal users.
-- can_watch_as takes the user id explicitly so the playback-token function
-- (running with the service role) can ask on behalf of a verified user.
create function private.can_watch_as(p_user_id uuid, p_episode_id text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_access public.episode_access;
  v_published boolean;
begin
  select access, published into v_access, v_published from public.episodes where id = p_episode_id;
  if not found or not v_published then
    return false;
  end if;

  if v_access = 'free' then
    return true;
  end if;

  if p_user_id is null then
    return false;
  end if;

  if exists (select 1 from public.unlocks where user_id = p_user_id and episode_id = p_episode_id) then
    return true;
  end if;

  return v_access = 'subscriber' and private.has_active_subscription(p_user_id);
end;
$$;

create or replace function public.can_watch(p_episode_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_watch_as(auth.uid(), p_episode_id);
$$;

-- Playback always requires a session (guests are anonymous sessions), so anon
-- has no reason to call can_watch.
revoke execute on function public.can_watch(text) from public, anon;
grant execute on function public.can_watch(text) to authenticated;

-- Keep the unlock RPCs from charging for an episode users can't see.
create or replace function public.unlock_episode_with_coins(p_episode_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_price integer;
  v_access public.episode_access;
  v_series_title text;
  v_episode_number integer;
  v_balance integer;
begin
  if exists (select 1 from public.unlocks where user_id = v_user_id and episode_id = p_episode_id) then
    return true;
  end if;

  select e.coin_price, e.access, e.number, s.title
    into v_price, v_access, v_episode_number, v_series_title
  from public.episodes e
  join public.series s on s.id = e.series_id
  where e.id = p_episode_id and e.published;

  if not found then
    raise exception 'episode % not found', p_episode_id;
  end if;

  if v_access <> 'coin' or v_price is null then
    raise exception 'episode % is not a coin-unlock episode', p_episode_id;
  end if;

  select balance into v_balance from public.wallets where user_id = v_user_id for update;

  if v_balance is null or v_balance < v_price then
    return false;
  end if;

  update public.wallets set balance = balance - v_price, updated_at = now() where user_id = v_user_id;

  insert into public.unlocks (user_id, episode_id) values (v_user_id, p_episode_id);

  insert into public.transactions (user_id, type, label, amount)
  values (v_user_id, 'unlock', format('Unlocked %s · EP%s', v_series_title, v_episode_number), -v_price);

  return true;
end;
$$;

create or replace function public.redeem_ad_reward(p_episode_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_access public.episode_access;
  v_today integer;
begin
  if exists (select 1 from public.unlocks where user_id = v_user_id and episode_id = p_episode_id) then
    return true;
  end if;

  select access into v_access from public.episodes where id = p_episode_id and published;

  if not found then
    raise exception 'episode % not found', p_episode_id;
  end if;

  if v_access <> 'ad_unlock' then
    raise exception 'episode % is not an ad-unlock episode', p_episode_id;
  end if;

  select count(*) into v_today
  from public.unlocks u
  join public.episodes e on e.id = u.episode_id
  where u.user_id = v_user_id
    and e.access = 'ad_unlock'
    and u.created_at >= date_trunc('day', now());

  if v_today >= private.config_int('ad_unlocks_per_day', 20) then
    return false;
  end if;

  insert into public.unlocks (user_id, episode_id) values (v_user_id, p_episode_id);

  insert into public.transactions (user_id, type, label, amount)
  values (v_user_id, 'reward', 'Unlocked via rewarded ad', 0);

  return true;
end;
$$;
