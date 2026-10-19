-- KBbox account rules (2026-10-19 user-logic audit).
--
-- Guest accounts are free to create, so until now every guest was a small
-- liability: 50 free coins, a daily mission, ad unlocks and unlimited free
-- episodes. And a real account's bonus was paid by handle_new_user, which a
-- guest who later linked Google / WhatsApp never went through. New rules:
--
--   * Every new account starts with 0 coins (starting_coins_* are now 0).
--   * The welcome bonus (welcome_bonus_coins, 150) is paid when a real
--     identity (Google, phone, Apple, email) is attached to an account —
--     at sign-up or when a guest links one — at most once per account and at
--     most once per identity, ever (deleting the account and signing up again
--     with the same Google account / phone number gives nothing).
--   * Guests can only preview free episodes: guest_preview_seconds (15) per
--     token, guest_previews_per_day (20) tokens per UTC day. Coin unlocks, ad
--     unlocks, the daily mission and simulated purchases / memberships raise
--     'account_required' for guests.
--   * The membership bonus is paid at most once per billing period (no more
--     subscribe → cancel → subscribe farming). Cancelling keeps access until
--     renews_at; an hourly job switches expired memberships off.
--   * Profiles follow the account when a guest links an identity (provider +
--     the name Google sends), and the 'Keybox → KBbox' naming stays.
--   * Account deletion: the delete-account Edge Function archives the
--     watermark code (private.deleted_accounts) and then deletes the user.
--
-- Supersedes the never-applied draft 20261016120000_profile_on_guest_upgrade:
-- linkIdentity does not copy Google's name into user_metadata (it only lives
-- in auth.identities.identity_data), so the profile is synced from
-- auth.identities instead.

-- ---------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public, description) values
  ('welcome_bonus_coins', '150', true, 'Coins paid once when a real identity (Google / phone / Apple / email) is attached to an account. Once per account and once per identity, ever.'),
  ('guest_preview_seconds', '15', true, 'Guests may preview this many seconds of a free episode per playback token.'),
  ('guest_previews_per_day', '20', true, 'Max preview tokens one guest account may get per UTC day.')
on conflict (key) do nothing;

-- Keys kept so old tooling keeps working; the value is no longer read.
update public.app_config
set value = '0', updated_at = now(),
    description = 'Unused since 20261019120000: every account starts with 0 coins; see welcome_bonus_coins.'
where key in ('starting_coins_guest', 'starting_coins_member');

-- Existing guests got 50 coins under the old rules; guests now hold 0.
update public.wallets w
set balance = 0, updated_at = now()
from auth.users u
where u.id = w.user_id
  and coalesce(u.is_anonymous, false)
  and w.balance <> 0;

-- ---------------------------------------------------------------------------
-- 2. Sign-up: every account starts with 0 coins. Same as 20261014120000
--    otherwise (provider / display name / public code / subscription row).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
  v_avatar_seed text;
  v_provider text;
begin
  v_provider := coalesce(
    new.raw_user_meta_data ->> 'provider',
    case when new.is_anonymous then 'guest' end,
    new.raw_app_meta_data ->> 'provider',
    'email'
  );
  v_display_name := coalesce(
    nullif(btrim(left(new.raw_user_meta_data ->> 'display_name', 40)), ''),
    nullif(btrim(left(new.raw_user_meta_data ->> 'full_name', 40)), ''),
    nullif(btrim(left(new.raw_user_meta_data ->> 'name', 40)), ''),
    case when v_provider = 'guest' then 'Guest Viewer' else 'KBbox Member' end
  );
  v_avatar_seed := coalesce(new.raw_user_meta_data ->> 'avatar_seed', v_display_name);

  insert into public.profiles (user_id, display_name, avatar_seed, provider, public_code)
  values (new.id, v_display_name, v_avatar_seed, v_provider, private.new_public_code())
  on conflict (user_id) do nothing;

  -- Coins only arrive through the welcome bonus (auth.identities trigger below).
  insert into public.wallets (user_id, balance)
  values (new.id, 0)
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id, is_active)
  values (new.id, false)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Was only used by reset_my_data (which now resets to 0 itself); kept so
-- nothing that still references it breaks.
create or replace function private.starting_coins(p_user_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select 0;
$$;

revoke execute on function private.starting_coins(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Profile sync when a real identity is attached.
--
-- Anonymous users have no auth.identities rows (checked on the live project),
-- so a new identity row is the reliable "this is a real account now" signal:
-- it covers new sign-ups, a guest linking Google (linkIdentity) and a guest
-- verifying a phone number (phone_change). GoTrue's order of internal writes
-- while linking (identity insert vs. is_anonymous / app_metadata update) is
-- not documented, so the same idempotent sync also runs when auth.users
-- becomes non-anonymous or its app_metadata / phone changes.
-- ---------------------------------------------------------------------------
create function private.sync_profile_from_auth(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_anonymous boolean;
  v_app_provider text;
  v_provider text;
  v_name text;
  v_old_provider text;
  v_old_name text;
  v_new_provider text;
  v_new_name text;
begin
  select coalesce(u.is_anonymous, false), nullif(u.raw_app_meta_data ->> 'provider', '')
    into v_is_anonymous, v_app_provider
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

  -- Supabase's app_metadata provider, else the first identity attached.
  v_provider := coalesce(
    case when v_app_provider not in ('anonymous', 'guest') then v_app_provider end,
    (select i.provider from auth.identities i
     where i.user_id = p_user_id
     order by i.created_at nulls last, i.id
     limit 1)
  );

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
  ) n
  where n.name is not null
  order by (n.provider = v_provider) desc nulls last, n.created_at nulls last, n.id
  limit 1;

  -- Nothing to go on (no app_metadata provider, no identity yet): keep it.
  v_new_provider := coalesce(v_provider, v_old_provider);

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

-- ---------------------------------------------------------------------------
-- 4. Welcome bonus: once per account, once per identity.
--
-- One row per identity that has ever been attached to a non-guest account.
-- provider_id is the identity's stable key: the provider subject for OAuth
-- (Google / Apple `sub`), the digits of the number for phone and the
-- lower-cased address for email — GoTrue uses the user's uuid as provider_id
-- for phone / email identities, which would change with every new account.
-- coins = what this row paid: the first identity of an account pays the
-- bonus, later identities of the same account are recorded with 0 so they
-- can't earn a second bonus on another account. Rows survive account
-- deletion (user_id becomes null), which is what makes "once per identity,
-- ever" hold.
-- ---------------------------------------------------------------------------
create table private.welcome_bonus_grants (
  provider text not null,
  provider_id text not null,
  user_id uuid references auth.users (id) on delete set null,
  coins integer not null default 0 check (coins >= 0),
  granted_at timestamptz not null default now(),
  primary key (provider, provider_id)
);

-- At most one paying row per account (belt and braces for the check in
-- grant_welcome_bonus).
create unique index welcome_bonus_grants_one_bonus_per_user
  on private.welcome_bonus_grants (user_id)
  where user_id is not null and coins > 0;

create index welcome_bonus_grants_user_idx on private.welcome_bonus_grants (user_id);

alter table private.welcome_bonus_grants enable row level security;
revoke all on private.welcome_bonus_grants from public, anon, authenticated;

create function private.identity_key(
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
    when 'email' then nullif(lower(btrim(coalesce(nullif(p_identity_data ->> 'email', ''), p_user_email, ''))), '')
    else nullif(btrim(p_provider_id), '')
  end;
$$;

revoke execute on function private.identity_key(text, text, jsonb, text, text) from public, anon, authenticated;

-- Returns the coins paid by this call (0 if nothing new). Idempotent: safe to
-- call from every trigger below, in any order.
create function private.grant_welcome_bonus(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_anonymous boolean;
  v_phone text;
  v_email text;
  v_amount integer := greatest(private.config_int('welcome_bonus_coins', 150), 0);
  v_settled boolean;
  v_paid integer := 0;
  v_key text;
  r record;
begin
  select coalesce(u.is_anonymous, false), u.phone::text, u.email::text
    into v_is_anonymous, v_phone, v_email
  from auth.users u
  where u.id = p_user_id;

  -- Guests never get it (an identity row can exist briefly before the guest
  -- flips to non-anonymous; the auth.users trigger retries then).
  if not found or v_is_anonymous then
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

-- Existing accounts already got their sign-up coins under the old rules: mark
-- every non-guest account as settled and record its identities, so neither
-- the account nor (after deleting it) its identities can collect the bonus.
-- Guests (anonymous) get the bonus when they link an identity.
insert into private.welcome_bonus_grants (provider, provider_id, user_id, coins)
select 'legacy', u.id::text, u.id, 0
from auth.users u
where not coalesce(u.is_anonymous, false)
on conflict (provider, provider_id) do nothing;

insert into private.welcome_bonus_grants (provider, provider_id, user_id, coins)
select i.provider, k.key, u.id, 0
from auth.users u
join auth.identities i on i.user_id = u.id
cross join lateral (
  select private.identity_key(i.provider, i.provider_id, i.identity_data, u.phone::text, u.email::text) as key
) k
where not coalesce(u.is_anonymous, false)
  and i.provider in ('google', 'phone', 'apple', 'email')
  and k.key is not null
on conflict (provider, provider_id) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Triggers on auth tables. They must never block a sign-in, so a failure
--    is logged as a warning instead of aborting GoTrue's transaction.
-- ---------------------------------------------------------------------------
create function private.on_auth_identity_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.sync_profile_from_auth(new.user_id);
    perform private.grant_welcome_bonus(new.user_id);
  exception when others then
    raise warning 'on_auth_identity_created(%): %', new.user_id, sqlerrm;
  end;
  return null;
end;
$$;

create function private.on_auth_user_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.sync_profile_from_auth(new.id);
    perform private.grant_welcome_bonus(new.id);
  exception when others then
    raise warning 'on_auth_user_changed(%): %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke execute on function private.on_auth_identity_created() from public, anon, authenticated;
revoke execute on function private.on_auth_user_changed() from public, anon, authenticated;

create trigger on_auth_identity_created
  after insert on auth.identities
  for each row
  execute function private.on_auth_identity_created();

-- "update of" also fires when GoTrue rewrites app_metadata unchanged on every
-- OAuth sign-in; the when clause skips those.
create trigger on_auth_user_changed
  after update of is_anonymous, raw_app_meta_data, phone on auth.users
  for each row
  when (
    not new.is_anonymous
    and (
      old.is_anonymous
      or old.raw_app_meta_data is distinct from new.raw_app_meta_data
      or old.phone is distinct from new.phone
    )
  )
  execute function private.on_auth_user_changed();

-- Guests who upgraded before this migration (live: one account still shows
-- provider 'guest' / 'Guest Viewer'). Profile only: they are marked settled
-- above, so no coins.
do $$
declare
  v_id uuid;
begin
  for v_id in
    select p.user_id
    from public.profiles p
    join auth.users u on u.id = p.user_id
    where not coalesce(u.is_anonymous, false)
      and (p.provider = 'guest' or p.display_name = 'Guest Viewer')
  loop
    perform private.sync_profile_from_auth(v_id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Guests can't earn or spend: account_required.
-- ---------------------------------------------------------------------------
create function private.require_member()
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
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_user_id), true) then
    raise exception 'account_required';
  end if;
  return v_user_id;
end;
$$;

revoke execute on function private.require_member() from public, anon, authenticated;

-- Body as in 20261009160000, except require_member.
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

-- Body as in 20261009160000, except require_member.
create or replace function public.redeem_ad_reward(p_episode_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_member();
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

-- Body as in 20261009150000, except require_member.
create or replace function public.claim_daily_mission()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_member();
  v_reward integer := private.config_int('daily_mission_reward', 20);
begin
  insert into public.daily_mission_claims (user_id, claim_date, coins_awarded)
  values (v_user_id, current_date, v_reward)
  on conflict (user_id, claim_date) do nothing;

  if not found then
    return 0;
  end if;

  update public.wallets
  set balance = balance + v_reward, updated_at = now()
  where user_id = v_user_id;

  insert into public.transactions (user_id, type, label, amount)
  values (v_user_id, 'reward', 'Daily mission: watched a rewarded ad', v_reward);

  return v_reward;
end;
$$;

-- Body as in 20261009150000, except require_member.
create or replace function public.simulate_purchase(p_package_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_member();
  v_pkg public.coin_packages;
  v_balance integer;
begin
  perform private.require_simulated_payments();

  select * into v_pkg from public.coin_packages where id = p_package_id and active;
  if not found then
    raise exception 'package % not found', p_package_id;
  end if;

  update public.wallets
  set balance = balance + v_pkg.coins + v_pkg.bonus_coins, updated_at = now()
  where user_id = v_user_id
  returning balance into v_balance;

  insert into public.transactions (user_id, type, label, amount)
  values (
    v_user_id, 'purchase',
    format('Purchased %s coins ($%s)', v_pkg.coins, to_char(v_pkg.price_usd, 'FM999990.00')),
    v_pkg.coins + v_pkg.bonus_coins
  );

  return v_balance;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Membership: bonus once per billing period, cancel keeps access until
--    renews_at, hourly expiry.
-- ---------------------------------------------------------------------------
alter table public.subscriptions
  add column bonus_granted_at timestamptz,
  add column cancelled_at timestamptz;

comment on column public.subscriptions.bonus_granted_at is 'When the plan bonus coins were last paid; at most once per billing period.';
comment on column public.subscriptions.cancelled_at is 'Set by cancel_subscription. Access continues until renews_at, then the hourly job sets is_active = false.';

-- Activates (or switches / resumes) the caller's membership. The plan bonus
-- is only paid when no membership is running and none was paid within the
-- last billing period. Returns the updated subscriptions row.
create or replace function public.simulate_subscribe(p_plan_id text)
returns public.subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_member();
  v_plan public.subscription_plans;
  v_prev public.subscriptions;
  v_sub public.subscriptions;
  v_grant boolean;
begin
  perform private.require_simulated_payments();

  select * into v_plan from public.subscription_plans where id = p_plan_id and active;
  if not found then
    raise exception 'plan % not found', p_plan_id;
  end if;

  -- Lock the row so two quick taps can't both pass the bonus check.
  select * into v_prev from public.subscriptions where user_id = v_user_id for update;

  v_grant := v_plan.bonus_coins > 0
    and not coalesce(v_prev.is_active and (v_prev.renews_at is null or v_prev.renews_at > now()), false)
    and (v_prev.bonus_granted_at is null or v_prev.bonus_granted_at < now() - v_plan.billing_period);

  insert into public.subscriptions as s
    (user_id, is_active, plan_id, started_at, renews_at, cancelled_at, bonus_granted_at)
  values
    (v_user_id, true, v_plan.id, now(), now() + v_plan.billing_period, null, case when v_grant then now() end)
  on conflict (user_id) do update
    set is_active = true,
        plan_id = excluded.plan_id,
        started_at = excluded.started_at,
        renews_at = excluded.renews_at,
        cancelled_at = null,
        bonus_granted_at = case when v_grant then now() else s.bonus_granted_at end
  returning * into v_sub;

  if v_grant then
    update public.wallets
    set balance = balance + v_plan.bonus_coins, updated_at = now()
    where user_id = v_user_id;

    insert into public.transactions (user_id, type, label, amount)
    values (v_user_id, 'bonus', format('%s bonus', v_plan.title), v_plan.bonus_coins);
  end if;

  return v_sub;
end;
$$;

-- Marks the membership cancelled; it stays usable until renews_at.
create or replace function public.cancel_subscription()
returns public.subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_sub public.subscriptions;
begin
  perform private.require_simulated_payments();

  update public.subscriptions
  set cancelled_at = coalesce(cancelled_at, now())
  where user_id = v_user_id and is_active
  returning * into v_sub;

  if not found then
    select * into v_sub from public.subscriptions where user_id = v_user_id;
  end if;

  return v_sub;
end;
$$;

-- has_active_subscription already ignores expired rows; this keeps is_active
-- honest for the app, admin views and the bonus check above.
create function private.expire_subscriptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.subscriptions
  set is_active = false
  where is_active and renews_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function private.expire_subscriptions() from public, anon, authenticated;

select cron.schedule('keybox-expire-subscriptions', '11 * * * *', 'select private.expire_subscriptions()');

-- "Reset Prototype": as in 20261009150000, but the balance goes to 0 (not a
-- starting balance picked by the current is_anonymous, which let an upgraded
-- guest reset into member coins) and the membership bookkeeping is cleared.
-- Welcome-bonus records are kept, so a reset can't earn the bonus again.
create or replace function public.reset_my_data()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
begin
  perform private.require_simulated_payments();

  delete from public.favorites where user_id = v_user_id;
  delete from public.unlocks where user_id = v_user_id;
  delete from public.watch_history where user_id = v_user_id;
  delete from public.progress where user_id = v_user_id;
  delete from public.recent_searches where user_id = v_user_id;
  delete from public.transactions where user_id = v_user_id;
  delete from public.daily_mission_claims where user_id = v_user_id;

  update public.wallets
  set balance = 0, updated_at = now()
  where user_id = v_user_id;

  update public.subscriptions
  set is_active = false, plan_id = null, started_at = null, renews_at = null,
      bonus_granted_at = null, cancelled_at = null
  where user_id = v_user_id;
end;
$$;

-- Same grants as 20261009150000 (create or replace keeps them; restated so
-- this file alone shows who may call what).
revoke execute on function
  public.unlock_episode_with_coins(text),
  public.redeem_ad_reward(text),
  public.claim_daily_mission(),
  public.simulate_purchase(text),
  public.simulate_subscribe(text),
  public.cancel_subscription(),
  public.reset_my_data()
from public, anon;

grant execute on function
  public.unlock_episode_with_coins(text),
  public.redeem_ad_reward(text),
  public.claim_daily_mission(),
  public.simulate_purchase(text),
  public.simulate_subscribe(text),
  public.cancel_subscription(),
  public.reset_my_data()
to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Playback: guests get short previews of free episodes only.
-- ---------------------------------------------------------------------------

-- The inline check from 20261009170000 is auto-named; find it by definition
-- rather than trusting the generated name.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.playback_events'::regclass
      and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) like '%decision%'
  loop
    execute format('alter table public.playback_events drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.playback_events
  add constraint playback_events_decision_check
  check (decision in ('granted', 'preview', 'not_entitled', 'account_required', 'unavailable', 'rate_limited', 'blocked', 'budget'));

-- As in 20261009170000, plus:
--   * unknown user → not_entitled (nothing to log against)
--   * guests: only published free episodes, at most guest_previews_per_day
--     per UTC day, otherwise account_required; a granted guest token is
--     logged as 'preview' and returns preview_seconds, with a token lifetime
--     of preview_seconds + 15 s (slack for slow networks)
--   * rate limits count both 'granted' and 'preview'
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
  v_published boolean;
  v_asset public.video_assets;
  v_budget integer := private.config_int('daily_minutes_budget', 0);
  v_used numeric;
  v_recent_tokens integer;
  v_recent_episodes integer;
  v_seen_this_hour boolean;
  v_previews_today integer;
  v_preview_seconds integer;
  v_code text;
begin
  select access, published into v_access, v_published from public.episodes where id = p_episode_id;
  if p_user_id is null or not found then
    return jsonb_build_object('allowed', false, 'reason', 'not_entitled');
  end if;

  select coalesce(u.is_anonymous, false) into v_is_guest from auth.users u where u.id = p_user_id;
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

  -- 1b. guests: free-episode previews only, capped per day
  if v_is_guest then
    if v_access <> 'free' or not v_published then
      perform private.log_playback(p_user_id, p_episode_id, 'account_required', p_client_ip, p_user_agent);
      return jsonb_build_object('allowed', false, 'reason', 'account_required');
    end if;

    select count(*) into v_previews_today
    from public.playback_events
    where user_id = p_user_id
      and decision = 'preview'
      and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';

    if v_previews_today >= private.config_int('guest_previews_per_day', 20) then
      perform private.log_playback(p_user_id, p_episode_id, 'account_required', p_client_ip, p_user_agent);
      return jsonb_build_object('allowed', false, 'reason', 'account_required');
    end if;
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
  where user_id = p_user_id and decision in ('granted', 'preview') and created_at > now() - interval '10 minutes';

  select count(distinct episode_id), bool_or(episode_id = p_episode_id)
    into v_recent_episodes, v_seen_this_hour
  from public.playback_events
  where user_id = p_user_id and decision in ('granted', 'preview') and created_at > now() - interval '1 hour';

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

  if v_is_guest then
    v_preview_seconds := private.config_int('guest_preview_seconds', 15);
    perform private.log_playback(p_user_id, p_episode_id, 'preview', p_client_ip, p_user_agent);
    return jsonb_build_object(
      'allowed', true,
      'provider', v_asset.provider,
      'provider_uid', v_asset.provider_uid,
      'duration_sec', v_asset.duration_sec,
      'watermark_code', v_code,
      'preview_seconds', v_preview_seconds,
      'ttl_seconds', v_preview_seconds + 15
    );
  end if;

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

-- ---------------------------------------------------------------------------
-- 9. Account deletion (delete-account Edge Function, service role).
--
-- The watermark code must stay traceable after the account is gone (a leak
-- recorded before deletion still points somewhere), so it is archived first;
-- then the function deletes the auth user and every per-user row cascades.
-- ---------------------------------------------------------------------------
create table private.deleted_accounts (
  user_id uuid primary key,
  public_code text,
  provider text,
  created_at timestamptz,
  deleted_at timestamptz not null default now(),
  open_abuse_flags integer not null default 0
);

create index deleted_accounts_public_code_idx on private.deleted_accounts (public_code);

alter table private.deleted_accounts enable row level security;
revoke all on private.deleted_accounts from public, anon, authenticated;

-- In public (not private) because PostgREST only exposes public; executable
-- by service_role only.
create function public.archive_deleted_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.deleted_accounts (user_id, public_code, provider, created_at, open_abuse_flags)
  select u.id, p.public_code, p.provider, u.created_at,
         (select count(*) from public.abuse_flags f where f.user_id = u.id and f.resolved_at is null)::integer
  from auth.users u
  left join public.profiles p on p.user_id = u.id
  where u.id = p_user_id
  on conflict (user_id) do update
    set public_code = excluded.public_code,
        provider = excluded.provider,
        created_at = excluded.created_at,
        open_abuse_flags = excluded.open_abuse_flags,
        deleted_at = now();

  if not found then
    raise exception 'user_not_found';
  end if;
end;
$$;

revoke execute on function public.archive_deleted_account(uuid) from public, anon, authenticated;
grant execute on function public.archive_deleted_account(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Admin console: the new settings are editable (body as in
--     20261010120000 plus three keys).
-- ---------------------------------------------------------------------------
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
    "guest_preview_seconds":          [5, 600],
    "guest_previews_per_day":         [0, 1000],
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

-- Dashboard "tokens today" should include guest previews (they are billed
-- like any other playback). Body as in 20261010120000 otherwise.
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
    'users_guest', (select count(*) from auth.users where is_anonymous),
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
