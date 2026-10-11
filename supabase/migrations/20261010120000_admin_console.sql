-- Keybox: server side of the admin console (DramaRush-Backend/admin).
--
-- Admins already write series / episodes / posters through RLS and upload or
-- delete videos through the admin-video-* Edge Functions. This adds what the
-- console needs on top: reading/changing app_config, a dashboard summary,
-- abuse review, finding the account behind a leaked video's watermark code,
-- playback logs, and blocking playback manually.
--
-- Every function is SECURITY DEFINER with search_path = '', checks
-- is_admin() itself, and is not executable by anon.

-- ---------------------------------------------------------------------------
-- app_config: admins can read every row (users only see is_public rows).
-- ---------------------------------------------------------------------------
create policy "admins can read all config"
  on public.app_config for select
  to authenticated
  using (public.is_admin());

create function private.require_admin()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;
end;
$$;

-- Changes one setting. Only known keys, each with its own type and range.
create function public.admin_set_config(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_int_ranges constant jsonb := '{
    "starting_coins_guest":           [0, 100000],
    "starting_coins_member":          [0, 100000],
    "daily_mission_reward":           [0, 100000],
    "ad_unlocks_per_day":             [0, 1000],
    "playback_token_ttl_seconds":     [60, 86400],
    "playback_max_tokens_per_10min":  [1, 10000],
    "playback_max_episodes_per_hour": [1, 10000],
    "playback_block_minutes":         [1, 43200],
    "daily_minutes_budget":           [0, 1000000000]
  }';
  v_range jsonb;
  v_num numeric;
begin
  perform private.require_admin();

  if p_key = 'simulated_payments' then
    if jsonb_typeof(p_value) <> 'boolean' then
      raise exception 'invalid_value: % must be true or false', p_key;
    end if;
  elsif p_key = 'budget_soft_ratio' then
    if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric not between 0.1 and 1 then
      raise exception 'invalid_value: % must be a number between 0.1 and 1', p_key;
    end if;
  elsif v_int_ranges ? p_key then
    v_range := v_int_ranges -> p_key;
    if jsonb_typeof(p_value) <> 'number' then
      raise exception 'invalid_value: % must be a whole number', p_key;
    end if;
    v_num := (p_value #>> '{}')::numeric;
    if v_num <> trunc(v_num) or v_num < (v_range ->> 0)::numeric or v_num > (v_range ->> 1)::numeric then
      raise exception 'invalid_value: % must be a whole number between % and %', p_key, v_range ->> 0, v_range ->> 1;
    end if;
  else
    raise exception 'unknown_setting: %', p_key;
  end if;

  update public.app_config set value = p_value, updated_at = now() where key = p_key;
  if not found then
    raise exception 'unknown_setting: %', p_key;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dashboard summary.
-- ---------------------------------------------------------------------------
create function public.admin_dashboard_stats()
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
    'episodes_total', (select count(*) from public.episodes),
    'episodes_published', (select count(*) from public.episodes where published),
    'videos_ready', (select count(*) from public.video_assets where status = 'ready'),
    'videos_processing', (select count(*) from public.video_assets where status in ('pending_upload', 'processing')),
    'videos_failed', (select count(*) from public.video_assets where status = 'error'),
    'stored_minutes', (select coalesce(round(sum(duration_sec) / 60.0, 1), 0) from public.video_assets where status = 'ready'),
    'users_total', (select count(*) from auth.users),
    'users_guest', (select count(*) from auth.users where is_anonymous),
    'today_minutes', (select coalesce(minutes_viewed, 0) from public.stream_usage_daily where day = v_today),
    'usage_synced_at', (select synced_at from public.stream_usage_daily where day = v_today),
    'daily_minutes_budget', private.config_int('daily_minutes_budget', 0),
    'tokens_today', (
      select count(*) from public.playback_events
      where decision = 'granted' and created_at >= v_today::timestamptz
    ),
    'open_abuse_flags', (
      select count(*) from public.abuse_flags
      where resolved_at is null and (blocks_playback_until is null or blocks_playback_until > now())
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Abuse review.
-- ---------------------------------------------------------------------------
create function public.admin_list_abuse_flags(p_open_only boolean default true, p_limit integer default 100)
returns table (
  id bigint,
  user_id uuid,
  reason text,
  details jsonb,
  created_at timestamptz,
  blocks_playback_until timestamptz,
  resolved_at timestamptz,
  display_name text,
  public_code text,
  email text,
  is_anonymous boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();

  return query
  select f.id, f.user_id, f.reason, f.details, f.created_at, f.blocks_playback_until, f.resolved_at,
         p.display_name, p.public_code, u.email::text, coalesce(u.is_anonymous, false)
  from public.abuse_flags f
  left join public.profiles p on p.user_id = f.user_id
  left join auth.users u on u.id = f.user_id
  where not p_open_only
     or (f.resolved_at is null and (f.blocks_playback_until is null or f.blocks_playback_until > now()))
  order by f.created_at desc
  limit least(greatest(p_limit, 1), 500);
end;
$$;

-- Manual playback block (e.g. an account caught leaking videos).
create function public.admin_block_user(p_user_id uuid, p_minutes integer, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform private.require_admin();
  if p_minutes is null or p_minutes < 1 or p_minutes > 525600 then
    raise exception 'invalid_value: minutes must be between 1 and 525600';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'user_not_found';
  end if;

  insert into public.abuse_flags (user_id, reason, details, blocks_playback_until)
  values (
    p_user_id,
    'manual_block',
    jsonb_build_object('note', left(coalesce(p_reason, ''), 500), 'by', auth.uid()),
    now() + make_interval(mins => p_minutes)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Find an account: by watermark code (exact, case-insensitive) or email.
-- ---------------------------------------------------------------------------
create function public.admin_find_user(p_query text)
returns table (
  user_id uuid,
  display_name text,
  public_code text,
  email text,
  is_anonymous boolean,
  is_admin boolean,
  created_at timestamptz,
  balance integer,
  is_member boolean,
  member_until timestamptz,
  unlock_count bigint,
  blocked_until timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := btrim(coalesce(p_query, ''));
begin
  perform private.require_admin();
  if length(v_q) < 3 then
    raise exception 'invalid_value: enter a watermark code or at least 3 characters of an email';
  end if;

  return query
  select p.user_id, p.display_name, p.public_code, u.email::text, coalesce(u.is_anonymous, false), p.is_admin,
         u.created_at, w.balance,
         private.has_active_subscription(p.user_id), s.renews_at,
         (select count(*) from public.unlocks x where x.user_id = p.user_id),
         (select max(f.blocks_playback_until) from public.abuse_flags f
           where f.user_id = p.user_id and f.resolved_at is null and f.blocks_playback_until > now())
  from public.profiles p
  join auth.users u on u.id = p.user_id
  left join public.wallets w on w.user_id = p.user_id
  left join public.subscriptions s on s.user_id = p.user_id
  where p.public_code = upper(v_q)
     or u.email ilike '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by (p.public_code = upper(v_q)) desc, u.created_at desc
  limit 50;
end;
$$;

-- ---------------------------------------------------------------------------
-- Playback log (optionally for one account).
-- ---------------------------------------------------------------------------
create function public.admin_playback_events(p_user_id uuid default null, p_limit integer default 100)
returns table (
  id bigint,
  created_at timestamptz,
  user_id uuid,
  public_code text,
  episode_id text,
  episode_number integer,
  series_title text,
  decision text,
  client_ip text,
  user_agent text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();

  return query
  select e.id, e.created_at, e.user_id, p.public_code, e.episode_id, ep.number, s.title,
         e.decision, host(e.client_ip), e.user_agent
  from public.playback_events e
  left join public.profiles p on p.user_id = e.user_id
  left join public.episodes ep on ep.id = e.episode_id
  left join public.series s on s.id = ep.series_id
  where p_user_id is null or e.user_id = p_user_id
  order by e.created_at desc
  limit least(greatest(p_limit, 1), 500);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  public.admin_set_config(text, jsonb),
  public.admin_dashboard_stats(),
  public.admin_list_abuse_flags(boolean, integer),
  public.admin_block_user(uuid, integer, text),
  public.admin_find_user(text),
  public.admin_playback_events(uuid, integer)
from public, anon;

grant execute on function
  public.admin_set_config(text, jsonb),
  public.admin_dashboard_stats(),
  public.admin_list_abuse_flags(boolean, integer),
  public.admin_block_user(uuid, integer, text),
  public.admin_find_user(text),
  public.admin_playback_events(uuid, integer)
to authenticated;
