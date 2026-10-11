-- Keybox: move every entitlement-changing write behind SECURITY DEFINER
-- functions. Until now clients could write their own wallet balance,
-- subscription, unlocks and transactions directly (see the policies in
-- 20260802000003_rls_policies.sql and 20260803000004_daily_mission.sql), so
-- the paywall only existed in the app. Video protection (signed playback
-- tokens) is meaningless unless the server is the only one that can grant
-- access, so this has to land first.
--
-- After this migration clients can only READ wallets / transactions /
-- subscriptions / unlocks / daily_mission_claims. Every change goes through:
--   unlock_episode_with_coins, redeem_ad_reward, claim_daily_mission,
--   simulate_purchase, simulate_subscribe, cancel_subscription,
--   reset_my_data, demo_set_balance, demo_set_all_unlocked.
-- The simulate_* / reset / demo_* functions only work while
-- app_config.simulated_payments is true (no real payment processor yet).

-- ---------------------------------------------------------------------------
-- private schema: internal helpers, not exposed through the REST API.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- app_config: server-side switches and limits. Rows with is_public = true are
-- readable by the app (e.g. so it can hide fake purchase buttons).
-- ---------------------------------------------------------------------------
create table public.app_config (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default false,
  description text,
  updated_at timestamptz not null default now()
);

alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;
grant select on public.app_config to anon, authenticated;

create policy "public config is readable"
  on public.app_config for select
  to anon, authenticated
  using (is_public);

insert into public.app_config (key, value, is_public, description) values
  ('simulated_payments', 'true', true, 'Allow simulate_purchase / simulate_subscribe / reset_my_data / demo_*. Turn off before launch.'),
  ('starting_coins_guest', '50', false, 'Coins given to a new anonymous (guest) account. Kept low because guest accounts are free to create.'),
  ('starting_coins_member', '150', false, 'Coins given to a new email / OAuth account.'),
  ('daily_mission_reward', '20', true, 'Coins awarded by claim_daily_mission().'),
  ('ad_unlocks_per_day', '20', true, 'Max episodes one user can unlock via rewarded ads per UTC day.');

create function private.config_int(p_key text, p_default integer)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((select (value #>> '{}')::integer from public.app_config where key = p_key), p_default);
$$;

create function private.config_bool(p_key text, p_default boolean)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select (value #>> '{}')::boolean from public.app_config where key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------
-- Catalog of coin packages and membership plans. Previously hardcoded in the
-- app (src/data/wallet.ts); the server now decides what a purchase grants.
-- store_product_id is for the future App Store / Google Play integration.
-- ---------------------------------------------------------------------------
create table public.coin_packages (
  id text primary key,
  coins integer not null check (coins > 0),
  bonus_coins integer not null default 0 check (bonus_coins >= 0),
  price_usd numeric(10, 2) not null check (price_usd >= 0),
  badge text,
  store_product_id text unique,
  sort_order integer not null default 0,
  active boolean not null default true
);

create table public.subscription_plans (
  id text primary key,
  title text not null,
  price_usd numeric(10, 2) not null check (price_usd >= 0),
  billing_period interval not null,
  bonus_coins integer not null default 0 check (bonus_coins >= 0),
  store_product_id text unique,
  sort_order integer not null default 0,
  active boolean not null default true
);

alter table public.coin_packages enable row level security;
alter table public.subscription_plans enable row level security;
revoke all on public.coin_packages, public.subscription_plans from anon, authenticated;
grant select on public.coin_packages, public.subscription_plans to anon, authenticated;

create policy "active coin packages are readable"
  on public.coin_packages for select
  to anon, authenticated
  using (active);

create policy "active subscription plans are readable"
  on public.subscription_plans for select
  to anon, authenticated
  using (active);

insert into public.coin_packages (id, coins, bonus_coins, price_usd, badge, sort_order) values
  ('coins-100', 100, 0, 0.99, null, 1),
  ('coins-250', 250, 25, 2.99, '+10% bonus', 2),
  ('coins-600', 600, 90, 6.99, '+15% bonus', 3),
  ('coins-1500', 1500, 300, 14.99, '+20% bonus', 4);

insert into public.subscription_plans (id, title, price_usd, billing_period, bonus_coins, sort_order) values
  ('monthly', 'Monthly Membership', 8.99, interval '1 month', 100, 1),
  ('annual', 'Annual Membership', 59.99, interval '1 year', 1500, 2);

alter table public.subscriptions drop constraint if exists subscriptions_plan_id_check;
alter table public.subscriptions
  add constraint subscriptions_plan_id_fkey foreign key (plan_id) references public.subscription_plans (id);

-- ---------------------------------------------------------------------------
-- Take away direct client writes on entitlement tables.
-- ---------------------------------------------------------------------------
drop policy "users can update their own wallet" on public.wallets;
drop policy "users can insert their own transactions" on public.transactions;
drop policy "users can update their own subscription" on public.subscriptions;
drop policy "users can manage their own unlocks" on public.unlocks;
drop policy "users can manage their own daily mission claims" on public.daily_mission_claims;

create policy "users can read their own unlocks"
  on public.unlocks for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can read their own daily mission claims"
  on public.daily_mission_claims for select
  to authenticated
  using (auth.uid() = user_id);

-- Belt and braces: remove the table privileges too, so a future careless
-- policy can't silently reopen these writes.
revoke insert, update, delete on
  public.wallets, public.transactions, public.subscriptions, public.unlocks, public.daily_mission_claims
from anon, authenticated;

-- profiles: users may only change their display name and avatar. This also
-- makes is_admin unwritable through the API at the privilege level (the
-- trigger from 20260813000001 stays as a second line of defence).
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (display_name, avatar_seed) on public.profiles to authenticated;

-- anon never owns per-user rows; it only needs to read the public catalog.
revoke all on
  public.profiles, public.wallets, public.transactions, public.subscriptions, public.favorites,
  public.unlocks, public.watch_history, public.progress, public.recent_searches, public.daily_mission_claims
from anon;
revoke insert, update, delete on public.series, public.episodes from anon;

-- Supabase grants TRUNCATE / REFERENCES / TRIGGER on every new table by
-- default; nobody needs them from the API.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Short public code per user, shown faintly over the video by the app so a
-- leaked screen recording can be traced back to an account.
-- ---------------------------------------------------------------------------
create function private.new_public_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  -- No 0/O/1/I to keep codes readable off a screen recording.
  v_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code text;
  i integer;
begin
  loop
    v_code := '';
    for i in 1..7 loop
      v_code := v_code || substr(v_alphabet, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1);
    end loop;
    exit when not exists (select 1 from public.profiles where public_code = v_code);
  end loop;
  return v_code;
end;
$$;

alter table public.profiles add column public_code text unique;
update public.profiles set public_code = private.new_public_code() where public_code is null;
alter table public.profiles alter column public_code set not null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.has_active_subscription(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = p_user_id
      and is_active
      and (renews_at is null or renews_at > now())
  );
$$;

create function private.require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  return v_user_id;
end;
$$;

create function private.require_simulated_payments()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.config_bool('simulated_payments', false) then
    raise exception 'payments_disabled';
  end if;
end;
$$;

create function private.starting_coins(p_user_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce((select is_anonymous from auth.users where id = p_user_id), false)
      then private.config_int('starting_coins_guest', 50)
    else private.config_int('starting_coins_member', 150)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Signup trigger: Keybox naming, starting coins from app_config, public code.
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
  v_provider := coalesce(new.raw_user_meta_data ->> 'provider', case when new.is_anonymous then 'guest' else 'email' end);
  v_display_name := coalesce(
    nullif(left(new.raw_user_meta_data ->> 'display_name', 40), ''),
    case when v_provider = 'guest' then 'Guest Viewer' else 'Keybox Member' end
  );
  v_avatar_seed := coalesce(new.raw_user_meta_data ->> 'avatar_seed', v_display_name);

  insert into public.profiles (user_id, display_name, avatar_seed, provider, public_code)
  values (new.id, v_display_name, v_avatar_seed, v_provider, private.new_public_code())
  on conflict (user_id) do nothing;

  insert into public.wallets (user_id, balance)
  values (
    new.id,
    case when new.is_anonymous
      then private.config_int('starting_coins_guest', 50)
      else private.config_int('starting_coins_member', 150)
    end
  )
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id, is_active)
  values (new.id, false)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- can_watch(): the single source of truth for "may this caller play this
-- episode". The playback-token Edge Function calls it with the caller's JWT.
-- Same rules the app used client-side: free, or unlocked, or a subscriber
-- episode while the membership is active.
-- ---------------------------------------------------------------------------
create function public.can_watch(p_episode_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_access public.episode_access;
begin
  select access into v_access from public.episodes where id = p_episode_id;
  if not found then
    return false;
  end if;

  if v_access = 'free' then
    return true;
  end if;

  if v_user_id is null then
    return false;
  end if;

  if exists (select 1 from public.unlocks where user_id = v_user_id and episode_id = p_episode_id) then
    return true;
  end if;

  return v_access = 'subscriber' and private.has_active_subscription(v_user_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Existing RPCs, now SECURITY DEFINER (they no longer rely on the client
-- write policies removed above). Same signatures and return values.
-- ---------------------------------------------------------------------------
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
  where e.id = p_episode_id;

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

-- Still trusts the client that an ad was watched (no ad network yet), so it
-- is capped per day. Returns false once the daily cap is reached.
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

  select access into v_access from public.episodes where id = p_episode_id;

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

create or replace function public.claim_daily_mission()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
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

-- ---------------------------------------------------------------------------
-- Simulated payments (until App Store / Google Play billing is integrated).
-- The price list lives in the database, so a client can only ever buy what
-- coin_packages / subscription_plans offer.
-- ---------------------------------------------------------------------------

-- Returns the new balance.
create function public.simulate_purchase(p_package_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
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

-- Activates (or switches) the caller's membership and grants the plan's
-- bonus coins. Returns the updated subscriptions row.
create function public.simulate_subscribe(p_plan_id text)
returns public.subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_plan public.subscription_plans;
  v_sub public.subscriptions;
begin
  perform private.require_simulated_payments();

  select * into v_plan from public.subscription_plans where id = p_plan_id and active;
  if not found then
    raise exception 'plan % not found', p_plan_id;
  end if;

  insert into public.subscriptions (user_id, is_active, plan_id, started_at, renews_at)
  values (v_user_id, true, v_plan.id, now(), now() + v_plan.billing_period)
  on conflict (user_id) do update
    set is_active = true, plan_id = excluded.plan_id, started_at = excluded.started_at, renews_at = excluded.renews_at
  returning * into v_sub;

  if v_plan.bonus_coins > 0 then
    update public.wallets
    set balance = balance + v_plan.bonus_coins, updated_at = now()
    where user_id = v_user_id;

    insert into public.transactions (user_id, type, label, amount)
    values (v_user_id, 'bonus', format('%s bonus', v_plan.title), v_plan.bonus_coins);
  end if;

  return v_sub;
end;
$$;

create function public.cancel_subscription()
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
  set is_active = false
  where user_id = v_user_id
  returning * into v_sub;

  return v_sub;
end;
$$;

-- "Reset Prototype": wipes the caller's own per-user data and restores the
-- starting balance.
create function public.reset_my_data()
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
  set balance = private.starting_coins(v_user_id), updated_at = now()
  where user_id = v_user_id;

  update public.subscriptions
  set is_active = false, plan_id = null, started_at = null, renews_at = null
  where user_id = v_user_id;
end;
$$;

-- Demo Controls ("+500 coins", "Remove all coins", "Unlock / lock all").
-- Admin accounts only, and only while simulated payments are on.
create function public.demo_set_balance(p_balance integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
  v_old integer;
begin
  perform private.require_simulated_payments();
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;
  if p_balance < 0 then
    raise exception 'balance must be >= 0';
  end if;

  select balance into v_old from public.wallets where user_id = v_user_id for update;

  update public.wallets set balance = p_balance, updated_at = now() where user_id = v_user_id;

  insert into public.transactions (user_id, type, label, amount)
  values (v_user_id, 'reset', format('Demo controls: balance set to %s', p_balance), p_balance - coalesce(v_old, 0));

  return p_balance;
end;
$$;

create function public.demo_set_all_unlocked(p_unlocked boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_user();
begin
  perform private.require_simulated_payments();
  if not public.is_admin() then
    raise exception 'admin_only';
  end if;

  if p_unlocked then
    insert into public.unlocks (user_id, episode_id)
    select v_user_id, id from public.episodes where access <> 'free'
    on conflict do nothing;
  else
    delete from public.unlocks where user_id = v_user_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: Supabase grants EXECUTE on new public functions to
-- anon and authenticated by default. Only signed-in users (guests included)
-- may call these; can_watch is also callable by anon for free episodes.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.unlock_episode_with_coins(text),
  public.redeem_ad_reward(text),
  public.claim_daily_mission(),
  public.simulate_purchase(text),
  public.simulate_subscribe(text),
  public.cancel_subscription(),
  public.reset_my_data(),
  public.demo_set_balance(integer),
  public.demo_set_all_unlocked(boolean)
from public, anon;

grant execute on function
  public.unlock_episode_with_coins(text),
  public.redeem_ad_reward(text),
  public.claim_daily_mission(),
  public.simulate_purchase(text),
  public.simulate_subscribe(text),
  public.cancel_subscription(),
  public.reset_my_data(),
  public.demo_set_balance(integer),
  public.demo_set_all_unlocked(boolean)
to authenticated;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
