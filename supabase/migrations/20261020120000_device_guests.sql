-- KBbox device guests: one guest account per phone (2026-10-20 guest flow).
--
-- Until now a guest was a Supabase anonymous user. Those have no credential
-- that can sign them in again, so reinstalling the app or clearing its
-- storage produced a brand-new guest (favorites, history and unlocks gone,
-- one more account in the table). Now the app first calls the
-- guest-session Edge Function with a stable device key; it signs the app in
-- as that device's guest account, creating it on first use:
--
--   * a device guest is an ordinary email account with a synthetic address
--     d-<hash>-<random>@guest.kbbox.app and a password derived on the server
--     from the device key (never sent to the app), created with
--     user_metadata { provider: 'guest', display_name: 'Guest Viewer' } —
--     handle_new_user already turns that into a 'guest' profile with 0 coins;
--   * private.device_guests maps HMAC(device key) to the device's current
--     guest; private.guest_session_log caps new device guests per IP per UTC
--     day (guest_new_per_ip_per_day);
--   * "guest" now means private.is_guest(): anonymous OR profiles.provider =
--     'guest'. Every rule that looked at auth.users.is_anonymous uses it
--     (require_member, authorize_playback, grant_welcome_bonus, admin views);
--   * new guest rule (replaces the 15-second previews of 20261019120000):
--     guests watch free episodes in full and may unlock ad episodes
--     (redeem_ad_reward); coin / subscriber episodes, coins, membership and
--     the daily mission need an account (account_required). The settings
--     guest_preview_seconds / guest_previews_per_day are removed;
--   * the synthetic address is never an identity: identity_key ignores it (no
--     welcome bonus) and sync_profile_from_auth ignores it when picking the
--     provider, so a device guest stays 'guest' until it links Google / a
--     phone number — then provider becomes google / phone, is_guest turns
--     false and the welcome bonus is paid once, exactly as for anonymous
--     guests.
--
-- Existing anonymous guests are not migrated; they stay guests through
-- is_anonymous. signInAnonymously remains the app's fallback.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public, description) values
  ('guest_new_per_ip_per_day', '20', false, 'Max new device guests (guest-session Edge Function) per client IP per UTC day; above it guest-session returns 429 guest_limit.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Who is a guest
-- ---------------------------------------------------------------------------

-- The synthetic address of a device guest (guest-session). Never a real
-- mailbox, never an identity.
create function private.is_device_guest_email(p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(lower(btrim(p_email)) like '%@guest.kbbox.app', false);
$$;

revoke execute on function private.is_device_guest_email(text) from public, anon, authenticated;

-- Anonymous users and device guests (provider 'guest' until a real identity
-- is linked). False for an unknown user — callers that must treat a missing
-- account as a guest (require_member) check existence themselves.
create function private.is_guest(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select coalesce(u.is_anonymous, false) or coalesce(p.provider = 'guest', false)
     from auth.users u
     left join public.profiles p on p.user_id = u.id
     where u.id = p_user_id),
    false
  );
$$;

revoke execute on function private.is_guest(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Device → guest account, and the per-IP creation counter
-- ---------------------------------------------------------------------------

-- device_hash = hex(HMAC-SHA256(GUEST_DEVICE_SECRET, device key)); the raw
-- key never reaches the database. One row per device, pointing at its
-- current guest. When that guest links an identity the row stays until the
-- device needs a guest again, then guest_session_register re-points it.
-- Deleting the account deletes the row (the next launch gets a new guest).
create table private.device_guests (
  device_hash text primary key check (device_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index device_guests_user_idx on private.device_guests (user_id);

alter table private.device_guests enable row level security;
revoke all on private.device_guests from public, anon, authenticated;

-- ip_hash = hex(HMAC-SHA256(secret, 'ip:' + client IP)); day is the UTC day.
create table private.guest_session_log (
  ip_hash text not null,
  day date not null,
  created integer not null default 0 check (created >= 0),
  primary key (ip_hash, day)
);

alter table private.guest_session_log enable row level security;
revoke all on private.guest_session_log from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The synthetic address is not an identity
-- ---------------------------------------------------------------------------

-- As in 20261019120000, except an email identity with a device-guest address
-- has no key (null = "not an identity": no welcome bonus, no grant row).
create or replace function private.identity_key(
  p_provider text,
  p_provider_id text,
  p_identity_data jsonb,
  p_user_phone text,
  p_user_email text
)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_provider
    when 'phone' then nullif(regexp_replace(coalesce(nullif(p_identity_data ->> 'phone', ''), p_user_phone, ''), '\D', '', 'g'), '')
    when 'email' then (
      select e.address
      from (select nullif(lower(btrim(coalesce(nullif(p_identity_data ->> 'email', ''), p_user_email, ''))), '') as address) e
      where not private.is_device_guest_email(e.address)
    )
    else nullif(btrim(p_provider_id), '')
  end;
$$;

revoke execute on function private.identity_key(text, text, jsonb, text, text) from public, anon, authenticated;

-- As in 20261019120000, plus device guests: GoTrue gives them app_metadata
-- provider 'email' and an email identity for the synthetic address; both are
-- ignored when picking the provider. A device guest with no other identity
-- keeps provider 'guest' and its name untouched. Still skipped while the
-- user is anonymous (a device guest never is, so it always runs for them).
create or replace function private.sync_profile_from_auth(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_anonymous boolean;
  v_app_provider text;
  v_email text;
  v_provider text;
  v_name text;
  v_old_provider text;
  v_old_name text;
  v_new_provider text;
  v_new_name text;
begin
  select coalesce(u.is_anonymous, false), nullif(u.raw_app_meta_data ->> 'provider', ''), u.email::text
    into v_is_anonymous, v_app_provider, v_email
  from auth.users u
  where u.id = p_user_id;

  -- Still a guest (e.g. the identity row was written before is_anonymous
  -- flipped): leave it; the auth.users trigger calls this again.
  if not found or v_is_anonymous then
    return;
  end if;

  select p.provider, p.display_name into v_old_provider, v_old_name
  from public.profiles p
  where p.user_id = p_user_id;
  if not found then
    return;
  end if;

  -- A device guest's 'email' provider is its synthetic address, not a choice
  -- the user made.
  if v_app_provider = 'email' and private.is_device_guest_email(v_email) then
    v_app_provider := null;
  end if;

  -- Supabase's app_metadata provider, else the first real identity attached.
  v_provider := coalesce(
    case when v_app_provider not in ('anonymous', 'guest') then v_app_provider end,
    (select i.provider from auth.identities i
     where i.user_id = p_user_id
       and not (i.provider = 'email'
                and private.is_device_guest_email(coalesce(nullif(i.identity_data ->> 'email', ''), v_email)))
     order by i.created_at nulls last, i.id
     limit 1)
  );

  -- Nothing to go on (no app_metadata provider, no identity yet): keep it.
  v_new_provider := coalesce(v_provider, v_old_provider);

  -- A device guest that hasn't linked anything yet stays exactly as it is
  -- ('Guest Viewer' must not become 'KBbox Member').
  if v_new_provider = 'guest' then
    return;
  end if;

  -- The name Google / Apple send (identity_data.full_name / name), preferring
  -- the identity of the account's provider.
  select n.name into v_name
  from (
    select coalesce(
             nullif(btrim(left(btrim(i.identity_data ->> 'full_name'), 40)), ''),
             nullif(btrim(left(btrim(i.identity_data ->> 'name'), 40)), '')
           ) as name,
           i.provider,
           i.created_at,
           i.id
    from auth.identities i
    where i.user_id = p_user_id
      and not (i.provider = 'email'
               and private.is_device_guest_email(coalesce(nullif(i.identity_data ->> 'email', ''), v_email)))
  ) n
  where n.name is not null
  order by (n.provider = v_provider) desc nulls last, n.created_at nulls last, n.id
  limit 1;

  -- Only default names are replaced; a name the user chose is kept.
  -- 'KBbox Member' counts as a default too: if is_anonymous flips before the
  -- Google identity row exists, the first pass falls back to 'KBbox Member'
  -- and the identity pass must still be able to apply Google's name.
  v_new_name := case
    when v_name is not null and v_old_name in ('Guest Viewer', 'KBbox Member') then v_name
    when v_old_name = 'Guest Viewer' then 'KBbox Member'
    else v_old_name
  end;

  if v_new_provider is distinct from v_old_provider or v_new_name is distinct from v_old_name then
    update public.profiles
    set provider = v_new_provider, display_name = v_new_name
    where user_id = p_user_id;
  end if;
end;
$$;

revoke execute on function private.sync_profile_from_auth(uuid) from public, anon, authenticated;

-- As in 20261019120000, except "guest" = private.is_guest (device guests
-- included). The triggers call sync_profile_from_auth first, so when a
-- device guest links Google its provider is already 'google' here and the
-- bonus is paid in the same trigger run.
create or replace function private.grant_welcome_bonus(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_guest boolean;
  v_phone text;
  v_email text;
  v_amount integer := greatest(private.config_int('welcome_bonus_coins', 150), 0);
  v_settled boolean;
  v_paid integer := 0;
  v_key text;
  r record;
begin
  select private.is_guest(u.id), u.phone::text, u.email::text
    into v_is_guest, v_phone, v_email
  from auth.users u
  where u.id = p_user_id;

  -- Guests never get it (an identity row can exist briefly before the guest
  -- flips to non-anonymous, or before a device guest's profile switches to
  -- the linked provider; the other trigger retries then).
  if not found or v_is_guest then
    return 0;
  end if;

  -- Serialise concurrent calls for the same account.
  perform 1 from public.wallets where user_id = p_user_id for update;

  -- Any row for this account (paying or not, or the pre-existing-account
  -- marker from the backfill) means its bonus is settled.
  v_settled := exists (select 1 from private.welcome_bonus_grants where user_id = p_user_id);

  for r in
    select i.provider, i.provider_id, i.identity_data
    from auth.identities i
    where i.user_id = p_user_id
      and i.provider in ('google', 'phone', 'apple', 'email')
    order by i.created_at nulls last, i.id
  loop
    v_key := private.identity_key(r.provider, r.provider_id, r.identity_data, v_phone, v_email);
    -- e.g. a phone identity whose number isn't written yet: skip, a later
    -- trigger run (auth.users phone update) records it.
    continue when v_key is null;

    insert into private.welcome_bonus_grants (provider, provider_id, user_id, coins)
    values (r.provider, v_key, p_user_id, case when v_settled then 0 else v_amount end)
    on conflict (provider, provider_id) do nothing;

    -- Not found = this identity was already used (by this or a deleted
    -- account): it pays nothing, the next identity may.
    if found and not v_settled then
      v_settled := true;
      v_paid := v_amount;
    end if;
  end loop;

  if v_paid > 0 then
    update public.wallets
    set balance = balance + v_paid, updated_at = now()
    where user_id = p_user_id;

    insert into public.transactions (user_id, type, label, amount)
    values (p_user_id, 'bonus', 'Welcome bonus', v_paid);
  end if;

  return v_paid;
end;
$$;

revoke execute on function private.grant_welcome_bonus(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Guests can't earn or spend: account_required (device guests too).
-- ---------------------------------------------------------------------------
create or replace function private.require_member()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
begin
  -- A missing auth.users row (deleted account, old JWT) counts as a guest.
  if coalesce((select private.is_guest(u.id) from auth.users u where u.id = v_user_id), true) then
    raise exception 'account_required';
  end if;
  return v_user_id;
end;
$$;

revoke execute on function private.require_member() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Guests watch free episodes in full and may unlock ad episodes.
--
-- Replaces the 15-second guest previews of 20261019120000: guests go through
-- the normal path (can_watch_as → 'granted', playback_token_ttl_seconds).
-- What a guest can't watch is told apart so the app shows the right thing:
-- an ad_unlock episode → not_entitled (offer the ad, redeem_ad_reward works
-- for guests now), a coin / subscriber episode → account_required (link an
-- account). Members unchanged. Rate limits count 'granted' only again; old
-- 'preview' rows stay valid in playback_events but no new ones are written.
-- ---------------------------------------------------------------------------
delete from public.app_config where key in ('guest_preview_seconds', 'guest_previews_per_day');

create or replace function public.authorize_playback(
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
  v_is_guest boolean;
  v_access public.episode_access;
  v_asset public.video_assets;
  v_budget integer := private.config_int('daily_minutes_budget', 0);
  v_used numeric;
  v_recent_tokens integer;
  v_recent_episodes integer;
  v_seen_this_hour boolean;
  v_code text;
begin
  select access into v_access from public.episodes where id = p_episode_id;
  if p_user_id is null or not found then
    return jsonb_build_object('allowed', false, 'reason', 'not_entitled');
  end if;

  select private.is_guest(u.id) into v_is_guest from auth.users u where u.id = p_user_id;
  if not found then
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

  -- 2. entitled? (guests: coin / subscriber episodes need an account; an
  --    ad_unlock episode they haven't unlocked is a normal not_entitled)
  if not private.can_watch_as(p_user_id, p_episode_id) then
    if v_is_guest and v_access in ('coin', 'subscriber') then
      perform private.log_playback(p_user_id, p_episode_id, 'account_required', p_client_ip, p_user_agent);
      return jsonb_build_object('allowed', false, 'reason', 'account_required');
    end if;
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
    select coalesce((select minutes_viewed from public.stream_usage_daily where day = (now() at time zone 'utc')::date), 0)
      into v_used;

    if (v_used >= v_budget and v_access in ('free', 'ad_unlock'))
      or (v_used >= v_budget * private.config_numeric('budget_soft_ratio', 0.8) and v_access = 'free') then
      perform private.log_playback(p_user_id, p_episode_id, 'budget', p_client_ip, p_user_agent);
      return jsonb_build_object('allowed', false, 'reason', 'budget');
    end if;
  end if;

  -- 5. rate limits (only tokens actually handed out count)
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

  select public_code into v_code from public.profiles where user_id = p_user_id;

  perform private.log_playback(p_user_id, p_episode_id, 'granted', p_client_ip, p_user_agent);

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

-- Ad unlocks are open to guests (any signed-in user; daily cap unchanged).
-- Body as in 20261019120000 except require_user instead of require_member.
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

revoke execute on function public.redeem_ad_reward(text) from public, anon;
grant execute on function public.redeem_ad_reward(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. guest-session Edge Function (service role only). In public because
--    PostgREST only exposes public.
-- ---------------------------------------------------------------------------

-- The device's current guest and its sign-in address, or no row if the
-- device has none or its guest has since linked an identity (that account is
-- a member now and must not be handed out by device key).
create function public.guest_session_lookup(p_device_hash text)
returns table (user_id uuid, email text)
language sql
volatile
security definer
set search_path = ''
as $$
  with hit as (
    update private.device_guests d
    set last_seen_at = now()
    where d.device_hash = p_device_hash
      and private.is_guest(d.user_id)
    returning d.user_id
  )
  select h.user_id, u.email::text
  from hit h
  join auth.users u on u.id = h.user_id;
$$;

-- May this IP create another device guest today? Asked before the auth user
-- is created; guest_session_register enforces the same cap.
create function public.guest_session_check_ip(p_ip_hash text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select l.created
     from private.guest_session_log l
     where l.ip_hash = p_ip_hash and l.day = (now() at time zone 'utc')::date),
    0
  ) < private.config_int('guest_new_per_ip_per_day', 20);
$$;

-- Records a just-created guest as the device's guest and counts it against
-- the IP. Raises
--   guest_limit  — the IP already created guest_new_per_ip_per_day today
--   device_taken — another request registered a guest for this device first
--   not_guest    — p_user_id is not (or no longer) a guest
-- The Edge Function deletes the auth user it created when this raises.
create function public.guest_session_register(p_device_hash text, p_user_id uuid, p_ip_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_created integer;
  v_current uuid;
begin
  if p_device_hash is null or p_device_hash !~ '^[0-9a-f]{64}$'
     or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_value: device_hash and ip_hash must be hex SHA-256';
  end if;

  if not private.is_guest(p_user_id) then
    raise exception 'not_guest';
  end if;

  -- One registration per device at a time (two first launches racing).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('guest_session:' || p_device_hash, 0));

  select d.user_id into v_current from private.device_guests d where d.device_hash = p_device_hash;
  if found and v_current = p_user_id then
    return; -- already registered: nothing to count
  end if;
  if found and private.is_guest(v_current) then
    raise exception 'device_taken';
  end if;

  insert into private.guest_session_log (ip_hash, day) values (p_ip_hash, v_day)
  on conflict (ip_hash, day) do nothing;

  select l.created into v_created
  from private.guest_session_log l
  where l.ip_hash = p_ip_hash and l.day = v_day
  for update;

  if v_created >= private.config_int('guest_new_per_ip_per_day', 20) then
    raise exception 'guest_limit';
  end if;

  insert into private.device_guests (device_hash, user_id)
  values (p_device_hash, p_user_id)
  on conflict (device_hash) do update
    set user_id = excluded.user_id, created_at = now(), last_seen_at = now();

  update private.guest_session_log l
  set created = l.created + 1
  where l.ip_hash = p_ip_hash and l.day = v_day;
end;
$$;

revoke execute on function
  public.guest_session_lookup(text),
  public.guest_session_check_ip(text),
  public.guest_session_register(text, uuid, text)
from public, anon, authenticated;

grant execute on function
  public.guest_session_lookup(text),
  public.guest_session_check_ip(text),
  public.guest_session_register(text, uuid, text)
to service_role;

-- The counter is only needed for today; keep a week for looking into abuse.
select cron.schedule(
  'keybox-prune-guest-session-log',
  '29 3 * * *',
  $$delete from private.guest_session_log where day < (now() at time zone 'utc')::date - 7$$
);

-- ---------------------------------------------------------------------------
-- 8. Admin console
-- ---------------------------------------------------------------------------

-- Body as in 20261019120000 plus guest_new_per_ip_per_day, minus the removed
-- guest_preview_seconds / guest_previews_per_day.
create or replace function public.admin_set_config(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_int_ranges constant jsonb := '{
    "starting_coins_guest":           [0, 100000],
    "starting_coins_member":          [0, 100000],
    "welcome_bonus_coins":            [0, 100000],
    "guest_new_per_ip_per_day":       [0, 10000],
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

revoke execute on function public.admin_set_config(text, jsonb) from public, anon;
grant execute on function public.admin_set_config(text, jsonb) to authenticated;

-- Body as in 20261019120000, except users_guest counts device guests too.
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

-- Bodies as in 20261010120000, except the is_anonymous column (name kept for
-- the console) is private.is_guest, so device guests show as guests rather
-- than by their synthetic address.
create or replace function public.admin_list_abuse_flags(p_open_only boolean default true, p_limit integer default 100)
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
         p.display_name, p.public_code, u.email::text, private.is_guest(f.user_id)
  from public.abuse_flags f
  left join public.profiles p on p.user_id = f.user_id
  left join auth.users u on u.id = f.user_id
  where not p_open_only
     or (f.resolved_at is null and (f.blocks_playback_until is null or f.blocks_playback_until > now()))
  order by f.created_at desc
  limit least(greatest(p_limit, 1), 500);
end;
$$;

create or replace function public.admin_find_user(p_query text)
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
  select p.user_id, p.display_name, p.public_code, u.email::text, private.is_guest(p.user_id), p.is_admin,
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

revoke execute on function
  public.admin_list_abuse_flags(boolean, integer),
  public.admin_find_user(text)
from public, anon;

grant execute on function
  public.admin_list_abuse_flags(boolean, integer),
  public.admin_find_user(text)
to authenticated;
