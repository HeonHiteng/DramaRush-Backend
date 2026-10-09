-- Keybox: the playback gate.
--
-- authorize_playback() is called ONLY by the playback-token Edge Function
-- (service role), after it has verified the caller's JWT. In one place it
-- decides whether a Stream token may be signed:
--   1. account not temporarily blocked for abuse
--   2. can_watch (free / unlocked / active membership, episode published)
--   3. a ready Stream video exists
--   4. cost guard: daily delivered-minutes budget (stream_usage_daily,
--      filled hourly by the stream-usage-sync function)
--   5. per-user rate limits (anti-scraping); breaching them blocks playback
--      for a while and records an abuse flag for admins to review
-- Every decision is logged to playback_events.

insert into public.app_config (key, value, is_public, description) values
  ('playback_token_ttl_seconds', '900', false, 'Lifetime of a signed Stream token. The app fetches a new one when it expires.'),
  ('playback_max_tokens_per_10min', '60', false, 'Max tokens one user may get in 10 minutes before being blocked.'),
  ('playback_max_episodes_per_hour', '80', false, 'Max distinct episodes one user may start per hour before being blocked.'),
  ('playback_block_minutes', '60', false, 'How long playback stays blocked after a rate-limit breach.'),
  ('daily_minutes_budget', '0', false, 'Max Stream minutes delivered per UTC day. 0 = no budget. At budget_soft_ratio free episodes stop; at 100% free and ad-unlock episodes stop.'),
  ('budget_soft_ratio', '0.8', false, 'Fraction of daily_minutes_budget at which free episodes stop being served.');

create function private.config_numeric(p_key text, p_default numeric)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce((select (value #>> '{}')::numeric from public.app_config where key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.playback_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  episode_id text not null references public.episodes (id) on delete cascade,
  decision text not null check (decision in ('granted', 'not_entitled', 'unavailable', 'rate_limited', 'blocked', 'budget')),
  client_ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create index playback_events_user_created_idx on public.playback_events (user_id, created_at desc);
create index playback_events_created_idx on public.playback_events (created_at);

create table public.abuse_flags (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null,
  details jsonb not null default '{}',
  blocks_playback_until timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null
);

create index abuse_flags_user_idx on public.abuse_flags (user_id, created_at desc);

create table public.stream_usage_daily (
  day date primary key,
  minutes_viewed numeric not null default 0,
  synced_at timestamptz not null default now()
);

alter table public.playback_events enable row level security;
alter table public.abuse_flags enable row level security;
alter table public.stream_usage_daily enable row level security;

revoke all on public.playback_events, public.abuse_flags, public.stream_usage_daily from anon, authenticated;
grant select on public.playback_events, public.abuse_flags, public.stream_usage_daily to authenticated;

create policy "admins can read playback events"
  on public.playback_events for select
  to authenticated
  using (public.is_admin());

create policy "admins can read abuse flags"
  on public.abuse_flags for select
  to authenticated
  using (public.is_admin());

create policy "admins can read stream usage"
  on public.stream_usage_daily for select
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- authorize_playback
-- ---------------------------------------------------------------------------
create function private.log_playback(p_user_id uuid, p_episode_id text, p_decision text, p_ip text, p_ua text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_ip inet;
begin
  begin
    v_ip := nullif(p_ip, '')::inet;
  exception when others then
    v_ip := null;
  end;

  insert into public.playback_events (user_id, episode_id, decision, client_ip, user_agent)
  values (p_user_id, p_episode_id, p_decision, v_ip, left(p_ua, 300));
end;
$$;

create function public.authorize_playback(
  p_user_id uuid,
  p_episode_id text,
  p_client_ip text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access public.episode_access;
  v_asset public.video_assets;
  v_budget integer := private.config_int('daily_minutes_budget', 0);
  v_used numeric;
  v_recent_tokens integer;
  v_recent_episodes integer;
  v_seen_this_hour boolean;
  v_code text;
begin
  if p_user_id is null or not exists (select 1 from public.episodes where id = p_episode_id) then
    return jsonb_build_object('allowed', false, 'reason', 'not_entitled');
  end if;

  -- 1. temporarily blocked?
  if exists (
    select 1 from public.abuse_flags
    where user_id = p_user_id and resolved_at is null and blocks_playback_until > now()
  ) then
    perform private.log_playback(p_user_id, p_episode_id, 'blocked', p_client_ip, p_user_agent);
    return jsonb_build_object('allowed', false, 'reason', 'blocked');
  end if;

  -- 2. entitled?
  if not private.can_watch_as(p_user_id, p_episode_id) then
    perform private.log_playback(p_user_id, p_episode_id, 'not_entitled', p_client_ip, p_user_agent);
    return jsonb_build_object('allowed', false, 'reason', 'not_entitled');
  end if;

  -- 3. video ready?
  v_asset := private.current_video(p_episode_id);
  if v_asset.id is null then
    perform private.log_playback(p_user_id, p_episode_id, 'unavailable', p_client_ip, p_user_agent);
    return jsonb_build_object('allowed', false, 'reason', 'unavailable');
  end if;

  -- 4. cost guard
  if v_budget > 0 then
    select access into v_access from public.episodes where id = p_episode_id;
    select coalesce((select minutes_viewed from public.stream_usage_daily where day = (now() at time zone 'utc')::date), 0)
      into v_used;

    if (v_used >= v_budget and v_access in ('free', 'ad_unlock'))
      or (v_used >= v_budget * private.config_numeric('budget_soft_ratio', 0.8) and v_access = 'free') then
      perform private.log_playback(p_user_id, p_episode_id, 'budget', p_client_ip, p_user_agent);
      return jsonb_build_object('allowed', false, 'reason', 'budget');
    end if;
  end if;

  -- 5. rate limits (only granted tokens count)
  select count(*) into v_recent_tokens
  from public.playback_events
  where user_id = p_user_id and decision = 'granted' and created_at > now() - interval '10 minutes';

  select count(distinct episode_id), bool_or(episode_id = p_episode_id)
    into v_recent_episodes, v_seen_this_hour
  from public.playback_events
  where user_id = p_user_id and decision = 'granted' and created_at > now() - interval '1 hour';

  if v_recent_tokens >= private.config_int('playback_max_tokens_per_10min', 60)
    or (not coalesce(v_seen_this_hour, false)
        and v_recent_episodes >= private.config_int('playback_max_episodes_per_hour', 80)) then
    insert into public.abuse_flags (user_id, reason, details, blocks_playback_until)
    values (
      p_user_id,
      'playback_rate_limit',
      jsonb_build_object('tokens_10min', v_recent_tokens, 'episodes_1h', v_recent_episodes, 'client_ip', p_client_ip),
      now() + make_interval(mins => private.config_int('playback_block_minutes', 60))
    );
    perform private.log_playback(p_user_id, p_episode_id, 'rate_limited', p_client_ip, p_user_agent);
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited');
  end if;

  perform private.log_playback(p_user_id, p_episode_id, 'granted', p_client_ip, p_user_agent);

  select public_code into v_code from public.profiles where user_id = p_user_id;

  return jsonb_build_object(
    'allowed', true,
    'provider', v_asset.provider,
    'provider_uid', v_asset.provider_uid,
    'duration_sec', v_asset.duration_sec,
    'watermark_code', v_code,
    'ttl_seconds', private.config_int('playback_token_ttl_seconds', 900)
  );
end;
$$;

revoke execute on function public.authorize_playback(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.authorize_playback(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Admin: clear a block early.
-- ---------------------------------------------------------------------------
create function public.admin_resolve_abuse_flag(p_flag_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;

  update public.abuse_flags
  set resolved_at = now(), resolved_by = auth.uid(), blocks_playback_until = least(blocks_playback_until, now())
  where id = p_flag_id;
end;
$$;

revoke execute on function public.admin_resolve_abuse_flag(bigint) from public, anon;
grant execute on function public.admin_resolve_abuse_flag(bigint) to authenticated;

-- Written by the stream-usage-sync function (service role).
create function public.record_stream_usage(p_day date, p_minutes numeric)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.stream_usage_daily (day, minutes_viewed, synced_at)
  values (p_day, p_minutes, now())
  on conflict (day) do update set minutes_viewed = excluded.minutes_viewed, synced_at = now();
$$;

revoke execute on function public.record_stream_usage(date, numeric) from public, anon, authenticated;
grant execute on function public.record_stream_usage(date, numeric) to service_role;
