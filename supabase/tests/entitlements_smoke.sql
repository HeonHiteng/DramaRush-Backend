-- Smoke test for 20261009150000_lock_down_entitlements.sql (rules as
-- updated by 20261019120000_account_rules.sql and 20261020120000_device_guests.sql:
-- 0 starting coins, the welcome bonus arrives with an identity, guests can't
-- earn or spend coins but may unlock ad episodes, cancelling keeps the
-- membership until renews_at).
--
-- Run it as the postgres role (Supabase SQL Editor, or the MCP execute_sql
-- tool). Everything happens inside one DO block that ALWAYS ends by raising
-- an exception, so the whole transaction rolls back and no test users or
-- rows are left behind:
--   * success -> error message "ALL_TESTS_PASSED"
--   * failure -> error message naming the failed check
do $$
declare
  u_guest uuid := gen_random_uuid();
  u_member uuid := gen_random_uuid();
  u_admin uuid := gen_random_uuid();
  v_int integer;
  v_bool boolean;
  v_text text;
begin
  -- ----------------------------------------------------------------- setup
  insert into auth.users (id, aud, role, email, is_anonymous, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values
    (u_guest, 'authenticated', 'authenticated', null, true, '{"provider":"guest"}', '{}', now(), now()),
    (u_member, 'authenticated', 'authenticated', 'member@test.keybox.invalid', false, '{}', '{}', now(), now()),
    (u_admin, 'authenticated', 'authenticated', 'admin@test.keybox.invalid', false, '{}', '{}', now(), now());
  update public.profiles set is_admin = true where user_id = u_admin;
  update public.app_config set value = '150' where key = 'welcome_bonus_coins';

  -- ------------------------------------------------------- signup trigger
  assert (select balance from public.wallets where user_id = u_guest) = 0, 'guest starting coins should be 0';
  assert (select balance from public.wallets where user_id = u_member) = 0, 'member starting coins should be 0 (bonus comes with the identity)';

  -- GoTrue writes the email identity right after the user row: welcome bonus.
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), u_member, 'email', u_member::text,
          jsonb_build_object('sub', u_member::text, 'email', 'member@test.keybox.invalid'), now(), now(), now());
  assert (select balance from public.wallets where user_id = u_member) = 150, 'member welcome bonus should be 150';
  assert (select display_name from public.profiles where user_id = u_member) = 'KBbox Member', 'default member name';
  assert (select public_code from public.profiles where user_id = u_guest) ~ '^[2-9A-HJ-NP-Z]{7}$', 'public_code format';

  -- ------------------------------------------------- act as a normal member
  perform set_config('request.jwt.claims', json_build_object('sub', u_member, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    update public.wallets set balance = 99999 where user_id = u_member;
    raise exception 'FAIL: member could update own wallet';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.transactions (user_id, type, label, amount) values (u_member, 'purchase', 'fake', 1000);
    raise exception 'FAIL: member could insert a transaction';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.subscriptions set is_active = true where user_id = u_member;
    raise exception 'FAIL: member could activate own subscription';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.unlocks (user_id, episode_id) values (u_member, 'crimson-contract-ep8');
    raise exception 'FAIL: member could insert an unlock';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.daily_mission_claims where user_id = u_member;
    raise exception 'FAIL: member could delete daily mission claims';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.profiles set is_admin = true where user_id = u_member;
    raise exception 'FAIL: member could set is_admin';
  exception when insufficient_privilege then null;
  end;

  update public.profiles set display_name = 'Renamed' where user_id = u_member;

  begin
    perform public.demo_set_balance(99999);
    raise exception 'FAIL: non-admin could use demo_set_balance';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text <> 'admin_only' then raise; end if;
  end;

  -- can_watch + coin unlock
  assert public.can_watch('crimson-contract-ep1'), 'free episode should be watchable';
  assert not public.can_watch('crimson-contract-ep4'), 'locked coin episode should not be watchable';
  assert public.unlock_episode_with_coins('crimson-contract-ep4'), 'coin unlock should succeed';
  assert public.can_watch('crimson-contract-ep4'), 'unlocked coin episode should be watchable';
  assert public.unlock_episode_with_coins('crimson-contract-ep4'), 'second unlock is a no-op success';
  assert (select balance from public.wallets where user_id = u_member) = 130, 'unlock should charge exactly once (150-20)';

  -- ad unlock
  assert public.redeem_ad_reward('crimson-contract-ep3'), 'ad unlock should succeed';

  -- subscription
  assert not public.can_watch('crimson-contract-ep7'), 'subscriber episode locked without membership';
  perform public.simulate_subscribe('monthly');
  assert public.can_watch('crimson-contract-ep7'), 'subscriber episode watchable with membership';
  assert (select balance from public.wallets where user_id = u_member) = 230, 'monthly plan bonus +100';

  -- purchase
  assert public.simulate_purchase('coins-250') = 505, 'coins-250 grants 275';

  -- daily mission
  assert public.claim_daily_mission() = 20, 'first daily claim gives 20';
  assert public.claim_daily_mission() = 0, 'second daily claim gives 0';

  -- cancel + reset
  perform public.cancel_subscription();
  assert public.can_watch('crimson-contract-ep7'), 'cancelled membership keeps subscriber episodes until renews_at';
  perform public.reset_my_data();
  assert (select balance from public.wallets where user_id = u_member) = 0, 'reset sets the balance to 0';
  assert not public.can_watch('crimson-contract-ep7'), 'reset ends the membership';
  assert (select count(*) from public.unlocks where user_id = u_member) = 0, 'reset clears unlocks';

  -- -------------------------------------------------------- act as anon
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;

  -- Since 20261009160000 playback always needs a session, so anon can't call can_watch.
  begin
    perform public.can_watch('crimson-contract-ep1');
    raise exception 'FAIL: anon could call can_watch';
  exception when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.wallets;
    raise exception 'FAIL: anon could read wallets';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.unlock_episode_with_coins('crimson-contract-ep4');
    raise exception 'FAIL: anon could call unlock_episode_with_coins';
  exception when insufficient_privilege then null;
  end;

  -- ------------------------------------------- limits from app_config
  reset role;
  update public.app_config set value = '1' where key = 'ad_unlocks_per_day';
  update public.app_config set value = 'false' where key = 'simulated_payments';

  -- Guests may unlock ad episodes (same daily cap as members).
  perform set_config('request.jwt.claims', json_build_object('sub', u_guest, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert public.redeem_ad_reward('heir-to-nowhere-ep4'), 'guest CAN redeem an ad reward';
  assert not public.redeem_ad_reward('midnight-ledger-ep5'), 'guest ad unlock beyond daily cap refused';
  reset role;
  assert exists (select 1 from public.unlocks where user_id = u_guest and episode_id = 'heir-to-nowhere-ep4'), 'guest ad unlock recorded';
  assert (select balance from public.wallets where user_id = u_guest) = 0, 'ad unlock pays the guest no coins';

  -- The member's ad unlocks were cleared by reset_my_data above.
  perform set_config('request.jwt.claims', json_build_object('sub', u_member, 'role', 'authenticated')::text, true);
  set local role authenticated;

  assert public.redeem_ad_reward('heir-to-nowhere-ep4'), 'first ad unlock today allowed';
  assert not public.redeem_ad_reward('midnight-ledger-ep5'), 'ad unlock beyond daily cap refused';

  begin
    perform public.simulate_purchase('coins-100');
    raise exception 'FAIL: simulate_purchase worked with simulated payments off';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text <> 'payments_disabled' then raise; end if;
  end;

  -- ------------------------------------------------------------- admin
  reset role;
  update public.app_config set value = 'true' where key = 'simulated_payments';
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  perform public.demo_set_all_unlocked(true);
  select count(*) into v_int from public.unlocks where user_id = u_admin;
  assert v_int = (select count(*) from public.episodes where access <> 'free'), 'demo unlock-all unlocks every paid episode';
  assert public.demo_set_balance(0) = 0, 'admin can set balance';

  reset role;
  raise exception 'ALL_TESTS_PASSED';
end;
$$;
