-- handle_new_user(): seeds profile/wallet/subscription rows for every new
-- auth.users row (email, OAuth, or anonymous/guest sign-in alike). Runs as
-- SECURITY DEFINER because clients have no insert policy on profiles/wallets
-- (see 20260802000003_rls_policies.sql) — only this trigger may create them.
-- Mirrors buildUser()'s implicit defaults in the app's src/store/userStore.ts.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_display_name text;
  v_avatar_seed text;
  v_provider text;
begin
  v_provider := coalesce(new.raw_user_meta_data ->> 'provider', case when new.is_anonymous then 'guest' else 'email' end);
  v_display_name := coalesce(new.raw_user_meta_data ->> 'display_name', case when v_provider = 'guest' then 'Guest Viewer' else 'DramaRush Member' end);
  v_avatar_seed := coalesce(new.raw_user_meta_data ->> 'avatar_seed', v_display_name);

  insert into public.profiles (user_id, display_name, avatar_seed, provider)
  values (new.id, v_display_name, v_avatar_seed, v_provider)
  on conflict (user_id) do nothing;

  insert into public.wallets (user_id, balance)
  values (new.id, 150)
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id, is_active)
  values (new.id, false)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- unlock_episode_with_coins(): atomically checks balance, deducts coins, and
-- records the unlock + transaction in one transaction. SECURITY INVOKER so
-- it runs as the calling user and is still bound by RLS. Idempotent: calling
-- it again for an already-unlocked episode is a no-op success, not a second
-- charge — this is the DB-level guarantee behind "an episode is never
-- charged twice" (replaces the client-only check the prototype used).
create or replace function public.unlock_episode_with_coins(p_episode_id text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_price integer;
  v_access public.episode_access;
  v_series_title text;
  v_episode_title text;
  v_episode_number integer;
  v_balance integer;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  if exists (select 1 from public.unlocks where user_id = v_user_id and episode_id = p_episode_id) then
    return true;
  end if;

  select e.coin_price, e.access, e.title, e.number, s.title
    into v_price, v_access, v_episode_title, v_episode_number, v_series_title
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

-- redeem_ad_reward(): unlocks an ad_unlock episode after the client-side
-- rewarded-ad simulation completes. Idempotent for the same reason as above.
create or replace function public.redeem_ad_reward(p_episode_id text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_access public.episode_access;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

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

  insert into public.unlocks (user_id, episode_id) values (v_user_id, p_episode_id);

  insert into public.transactions (user_id, type, label, amount)
  values (v_user_id, 'reward', 'Unlocked via rewarded ad', 0);

  return true;
end;
$$;
