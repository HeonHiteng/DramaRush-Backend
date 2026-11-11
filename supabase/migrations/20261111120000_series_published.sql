-- Series take-down (下架): series get a published switch like episodes have.
--
-- * public.series.published (default true). The 8 demo/seed series are taken
--   down here; their rows and episodes stay (the demo videos on their episodes
--   are used by the smoke tests, tests/e2e and scripts/seed-demo-videos.js).
-- * RLS: anon / non-admin users only see published series, and only episodes
--   that are published AND belong to a published series. Admins see everything.
-- * Playback / unlocks: private.can_watch_as (behind can_watch and
--   authorize_playback) treats an episode of an unpublished series exactly like
--   an unpublished episode (false -> not_entitled). unlock_episode_with_coins /
--   redeem_ad_reward refuse them the same way ("episode % not found"), so nobody
--   is charged for an episode they can't watch.
-- * admin_dashboard_stats gains series_published ('series' still counts all).

-- ---------------------------------------------------------------------------
-- column + data fix
-- ---------------------------------------------------------------------------
alter table public.series add column if not exists published boolean not null default true;

update public.series set published = false
where id in (
  'crimson-contract', 'ever-after-glitch', 'heir-to-nowhere', 'midnight-ledger',
  'paper-moon-diner', 'static-bloom', 'understudys-revenge', 'varsity-hearts'
)
  and published;

-- ---------------------------------------------------------------------------
-- RLS: series
-- ---------------------------------------------------------------------------
drop policy if exists "series are publicly readable" on public.series;
drop policy if exists "anon can read published series" on public.series;
drop policy if exists "users can read published series, admins all" on public.series;

create policy "anon can read published series"
  on public.series for select
  to anon
  using (published);

create policy "users can read published series, admins all"
  on public.series for select
  to authenticated
  using (published or (select public.is_admin()));

-- ---------------------------------------------------------------------------
-- RLS: episodes (also require the parent series to be published). The exists
-- is a primary-key lookup on series per row, and series' own select policy
-- (published) applies inside it as well, so it can never widen visibility.
-- ---------------------------------------------------------------------------
drop policy if exists "anon can read published episodes" on public.episodes;
drop policy if exists "users can read published episodes, admins all" on public.episodes;

create policy "anon can read published episodes"
  on public.episodes for select
  to anon
  using (
    published
    and exists (select 1 from public.series s where s.id = episodes.series_id and s.published)
  );

create policy "users can read published episodes, admins all"
  on public.episodes for select
  to authenticated
  using (
    (published and exists (select 1 from public.series s where s.id = episodes.series_id and s.published))
    or (select public.is_admin())
  );

-- ---------------------------------------------------------------------------
-- can_watch_as: body as in 20261009160000_video_assets.sql, except the
-- episode must also belong to a published series.
-- ---------------------------------------------------------------------------
create or replace function private.can_watch_as(p_user_id uuid, p_episode_id text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_access public.episode_access;
  v_published boolean;
begin
  select e.access, e.published and s.published into v_access, v_published
  from public.episodes e
  join public.series s on s.id = e.series_id
  where e.id = p_episode_id;
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

-- ---------------------------------------------------------------------------
-- unlock_episode_with_coins: body as in 20261019120000_account_rules.sql,
-- except "and s.published".
-- ---------------------------------------------------------------------------
create or replace function public.unlock_episode_with_coins(p_episode_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_member();
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
  where e.id = p_episode_id and e.published and s.published;

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

revoke execute on function public.unlock_episode_with_coins(text) from public, anon;
grant execute on function public.unlock_episode_with_coins(text) to authenticated;

-- ---------------------------------------------------------------------------
-- redeem_ad_reward: body as in 20261020120000_device_guests.sql, except the
-- episode lookup joins series and requires s.published.
-- ---------------------------------------------------------------------------
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

  select e.access into v_access
  from public.episodes e
  join public.series s on s.id = e.series_id
  where e.id = p_episode_id and e.published and s.published;

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

revoke execute on function public.redeem_ad_reward(text) from public, anon;
grant execute on function public.redeem_ad_reward(text) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_dashboard_stats: body as in 20261020120000_device_guests.sql, plus
-- series_published.
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
begin
  perform private.require_admin();

  return jsonb_build_object(
    'series', (select count(*) from public.series),
    'series_published', (select count(*) from public.series where published),
    'episodes_total', (select count(*) from public.episodes),
    'episodes_published', (select count(*) from public.episodes where published),
    'videos_ready', (select count(*) from public.video_assets where status = 'ready'),
    'videos_processing', (select count(*) from public.video_assets where status in ('pending_upload', 'processing')),
    'videos_failed', (select count(*) from public.video_assets where status = 'error'),
    'stored_minutes', (select coalesce(round(sum(duration_sec) / 60.0, 1), 0) from public.video_assets where status = 'ready'),
    'users_total', (select count(*) from auth.users),
    'users_guest', (
      select count(*)
      from auth.users u
      left join public.profiles p on p.user_id = u.id
      where coalesce(u.is_anonymous, false) or p.provider = 'guest'
    ),
    'today_minutes', (select coalesce(minutes_viewed, 0) from public.stream_usage_daily where day = v_today),
    'usage_synced_at', (select synced_at from public.stream_usage_daily where day = v_today),
    'daily_minutes_budget', private.config_int('daily_minutes_budget', 0),
    'tokens_today', (
      select count(*) from public.playback_events
      where decision in ('granted', 'preview') and created_at >= v_today::timestamptz
    ),
    'open_abuse_flags', (
      select count(*) from public.abuse_flags
      where resolved_at is null and (blocks_playback_until is null or blocks_playback_until > now())
    )
  );
end;
$$;

revoke execute on function public.admin_dashboard_stats() from public, anon;
grant execute on function public.admin_dashboard_stats() to authenticated;
