-- Smoke test for 20261020120000_device_guests.sql. Run as postgres; always
-- ends in an exception so everything rolls back. Success = "ALL_TESTS_PASSED".
--
-- A device guest is what the guest-session Edge Function creates: a
-- non-anonymous email account with a synthetic @guest.kbbox.app address and
-- user_metadata provider 'guest'. GoTrue's admin createUser writes the
-- auth.users row (app_metadata provider 'email') and then an email identity;
-- both are simulated here. Linking Google is simulated in both orders
-- (identity row first / app_metadata first), as in account_rules_smoke.sql.
do $$
declare
  d_guest uuid := gen_random_uuid();    -- device guest, later links Google (identity first)
  d_link_b uuid := gen_random_uuid();   -- device guest, links Google (app_metadata first)
  d_next uuid := gen_random_uuid();     -- the device's next guest after d_guest linked
  d_racer uuid := gen_random_uuid();    -- loses the race for the device to d_next
  a_guest uuid := gen_random_uuid();    -- plain anonymous guest (old path), still a guest
  cap1 uuid := gen_random_uuid();
  cap2 uuid := gen_random_uuid();
  cap3 uuid := gen_random_uuid();
  cap4 uuid := gen_random_uuid();
  dev_a text := md5('dev-a' || gen_random_uuid()) || md5('dev-a2' || gen_random_uuid());
  dev_b text := md5('dev-b' || gen_random_uuid()) || md5('dev-b2' || gen_random_uuid());
  ip_a text := md5('ip-a' || gen_random_uuid()) || md5('ip-a2' || gen_random_uuid());
  ip_cap text := md5('ip-cap' || gen_random_uuid()) || md5('ip-cap2' || gen_random_uuid());
  email_guest text;
  email_b text;
  email_next text;
  v_res jsonb;
  v_int integer;
  v_text text;
  v_who text;
  v_code_next text;
  v_code_guest text;
  v_sql text;
  r record;
begin
  -- Known config, whatever the live values are (rolled back at the end).
  update public.app_config set value = '150' where key = 'welcome_bonus_coins';
  update public.app_config set value = '20' where key = 'ad_unlocks_per_day';
  update public.app_config set value = '0' where key = 'daily_minutes_budget';
  update public.app_config set value = '60' where key = 'playback_max_tokens_per_10min';
  update public.app_config set value = '80' where key = 'playback_max_episodes_per_hour';
  update public.app_config set value = 'true' where key = 'simulated_payments';
  update public.app_config set value = '20' where key = 'daily_mission_reward';
  update public.episodes set published = true where id in ('crimson-contract-ep1', 'crimson-contract-ep3', 'crimson-contract-ep4');

  assert exists (select 1 from public.app_config where key = 'guest_new_per_ip_per_day' and value = '20'::jsonb and not is_public),
    'guest_new_per_ip_per_day = 20, not public';

  email_guest := 'd-' || left(dev_a, 32) || '-0a1b2c3d@guest.kbbox.app';
  email_b := 'd-' || left(dev_b, 32) || '-1a2b3c4d@guest.kbbox.app';
  email_next := 'd-' || left(dev_a, 32) || '-5e6f7a8b@guest.kbbox.app';

  -- ------------------------------------------------- a device guest is created
  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values
    (d_guest, 'authenticated', 'authenticated', email_guest, now(), '{"provider":"email","providers":["email"]}',
     '{"provider":"guest","display_name":"Guest Viewer","device":true}', false, now(), now()),
    (d_link_b, 'authenticated', 'authenticated', email_b, now(), '{"provider":"email","providers":["email"]}',
     '{"provider":"guest","display_name":"Guest Viewer","device":true}', false, now(), now());
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values
    (gen_random_uuid(), d_guest, 'email', d_guest::text,
     jsonb_build_object('sub', d_guest::text, 'email', email_guest, 'email_verified', false), now(), now(), now()),
    (gen_random_uuid(), d_link_b, 'email', d_link_b::text,
     jsonb_build_object('sub', d_link_b::text, 'email', email_b, 'email_verified', false), now(), now(), now());

  select display_name, provider into r from public.profiles where user_id = d_guest;
  assert r.provider = 'guest' and r.display_name = 'Guest Viewer', format('device guest profile: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = d_guest) = 0, 'device guest has 0 coins';
  assert not exists (select 1 from public.transactions where user_id = d_guest), 'no welcome bonus for the synthetic email';
  assert not exists (select 1 from private.welcome_bonus_grants where user_id = d_guest), 'synthetic email not recorded as an identity';
  assert private.is_guest(d_guest), 'device guest is_guest';
  assert private.identity_key('email', d_guest::text, jsonb_build_object('email', upper(email_guest)), null, null) is null,
    'identity_key ignores device-guest addresses (any case)';
  assert private.identity_key('email', 'x', '{"email":"Real@Example.com"}', null, null) = 'real@example.com', 'real email still keyed';
  assert private.grant_welcome_bonus(d_guest) = 0, 'grant pays a device guest nothing';

  -- GoTrue rewriting app_metadata on a later sign-in changes nothing.
  update auth.users set raw_app_meta_data = '{"provider":"email","providers":["email"],"x":1}' where id = d_guest;
  select display_name, provider into r from public.profiles where user_id = d_guest;
  assert r.provider = 'guest' and r.display_name = 'Guest Viewer', format('after app_metadata rewrite: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = d_guest) = 0, 'still 0 coins';

  -- Plain anonymous guests are still guests.
  insert into auth.users (id, aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values (a_guest, 'authenticated', 'authenticated', '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now());
  assert private.is_guest(a_guest), 'anonymous user is_guest';
  assert not private.is_guest(gen_random_uuid()), 'unknown user is not is_guest (require_member handles missing users)';

  -- ------------------------------------------------- guest rules apply
  -- Coins, membership and the daily mission need an account.
  foreach v_sql in array array[
    'select public.unlock_episode_with_coins(''crimson-contract-ep4'')',
    'select public.claim_daily_mission()',
    'select public.simulate_purchase(''coins-100'')',
    'select public.simulate_subscribe(''monthly'')'
  ] loop
    foreach v_who in array array[d_guest::text, a_guest::text, gen_random_uuid()::text] loop
      perform set_config('request.jwt.claims', json_build_object('sub', v_who, 'role', 'authenticated')::text, true);
      set local role authenticated;
      begin
        execute v_sql;
        raise exception 'FAIL: guest % could run %', v_who, v_sql;
      exception when raise_exception then
        get stacked diagnostics v_text = message_text;
        if v_text <> 'account_required' then raise; end if;
      end;
      reset role;
    end loop;
  end loop;
  assert (select balance from public.wallets where user_id = d_guest) = 0, 'device guest still has 0 coins';

  -- Free episodes in full, ad episodes after an ad, coin episodes need an account.
  insert into public.video_assets (episode_id, provider_uid, status, duration_sec, ready_at) values
    ('crimson-contract-ep1', md5(gen_random_uuid()::text), 'ready', 90, now()),
    ('crimson-contract-ep3', md5(gen_random_uuid()::text), 'ready', 95, now()),
    ('crimson-contract-ep4', md5(gen_random_uuid()::text), 'ready', 100, now());
  set local role service_role;
  v_res := public.authorize_playback(d_guest, 'crimson-contract-ep1', null, null);
  assert (v_res ->> 'allowed')::boolean and not (v_res ? 'preview_seconds')
    and (v_res ->> 'ttl_seconds')::integer = coalesce((select (value #>> '{}')::integer from public.app_config where key = 'playback_token_ttl_seconds'), 900),
    format('device guest free episode -> full token: %s', v_res);
  v_res := public.authorize_playback(d_guest, 'crimson-contract-ep4', null, null);
  assert v_res ->> 'reason' = 'account_required', format('device guest coin episode -> account_required: %s', v_res);
  v_res := public.authorize_playback(d_guest, 'crimson-contract-ep3', null, null);
  assert v_res ->> 'reason' = 'not_entitled', format('device guest ad episode not unlocked -> not_entitled: %s', v_res);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', d_guest, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert public.redeem_ad_reward('crimson-contract-ep3'), 'device guest redeem_ad_reward -> true';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  v_res := public.authorize_playback(d_guest, 'crimson-contract-ep3', null, null);
  assert (v_res ->> 'allowed')::boolean, format('device guest ad-unlocked episode -> granted: %s', v_res);
  reset role;
  assert (select balance from public.wallets where user_id = d_guest) = 0, 'ad unlock pays no coins';
  select count(*) into v_int from public.playback_events where user_id = d_guest and decision = 'granted';
  assert v_int = 2, format('2 granted logged (got %s)', v_int);
  assert not exists (select 1 from public.playback_events where user_id = d_guest and decision = 'preview'), 'no previews logged';

  -- ------------------------------------------------- guest-session RPCs
  -- Not callable by app users.
  perform set_config('request.jwt.claims', json_build_object('sub', d_guest, 'role', 'authenticated')::text, true);
  foreach v_sql in array array[
    format('select * from public.guest_session_lookup(%L)', dev_a),
    format('select public.guest_session_check_ip(%L)', ip_a),
    format('select public.guest_session_register(%L, %L, %L)', dev_a, d_guest, ip_a)
  ] loop
    foreach v_who in array array['authenticated', 'anon'] loop
      execute format('set local role %I', v_who);
      begin
        execute v_sql;
        raise exception 'FAIL: % could run %', v_who, v_sql;
      exception when insufficient_privilege then null;
      end;
      reset role;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  set local role service_role;
  assert not exists (select 1 from public.guest_session_lookup(dev_a)), 'unknown device -> no row';
  assert public.guest_session_check_ip(ip_a), 'fresh IP may create';
  perform public.guest_session_register(dev_a, d_guest, ip_a);
  perform public.guest_session_register(dev_b, d_link_b, ip_a);
  perform public.guest_session_register(dev_a, d_guest, ip_a); -- repeat: no-op, not counted
  select * into r from public.guest_session_lookup(dev_a);
  assert r.user_id = d_guest and r.email = email_guest, format('lookup -> the device guest and its email: %s', r);
  reset role;
  assert (select created from private.guest_session_log where ip_hash = ip_a and day = (now() at time zone 'utc')::date) = 2,
    'two guests counted for the IP (repeat registration not counted)';

  -- Another guest can't take a device whose guest is still a guest.
  insert into auth.users (id, aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values (d_racer, 'authenticated', 'authenticated', '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now());
  set local role service_role;
  begin
    perform public.guest_session_register(dev_a, d_racer, ip_a);
    raise exception 'FAIL: second guest registered for a taken device';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text <> 'device_taken' then raise; end if;
  end;
  begin
    perform public.guest_session_register(dev_a, gen_random_uuid(), ip_a);
    raise exception 'FAIL: unknown user registered';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text <> 'not_guest' then raise; end if;
  end;
  begin
    perform public.guest_session_register('not-a-hash', d_racer, ip_a);
    raise exception 'FAIL: malformed device hash accepted';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text not like 'invalid_value%' then raise; end if;
  end;
  reset role;

  -- ------------------------------------------------- link Google, identity row first
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), d_guest, 'google', 'smoke-device-google-a',
          '{"sub":"smoke-device-google-a","email":"aisha.device@test.keybox.invalid","full_name":"Aisha Device"}',
          now(), now() + interval '1 second', now());
  update auth.users set raw_app_meta_data = '{"provider":"email","providers":["email","google"]}' where id = d_guest;

  select display_name, provider into r from public.profiles where user_id = d_guest;
  assert r.provider = 'google' and r.display_name = 'Aisha Device', format('linked device guest: %s / %s', r.display_name, r.provider);
  assert not private.is_guest(d_guest), 'linked device guest is no longer a guest';
  assert (select balance from public.wallets where user_id = d_guest) = 150, 'welcome bonus 150 on linking';
  update auth.users set raw_app_meta_data = '{"provider":"email","providers":["email","google"],"y":2}' where id = d_guest;
  assert private.grant_welcome_bonus(d_guest) = 0, 'grant is idempotent';
  select count(*) into v_int from public.transactions where user_id = d_guest and label = 'Welcome bonus';
  assert v_int = 1, format('exactly one welcome bonus (got %s)', v_int);
  assert exists (select 1 from private.welcome_bonus_grants where provider = 'google' and provider_id = 'smoke-device-google-a' and user_id = d_guest and coins = 150),
    'Google identity recorded as the paying identity';
  assert not exists (select 1 from private.welcome_bonus_grants where provider = 'email' and user_id = d_guest),
    'synthetic email still not recorded';

  -- Member rules now: the daily mission pays.
  perform set_config('request.jwt.claims', json_build_object('sub', d_guest, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert public.claim_daily_mission() = 20, 'linked device guest can claim the daily mission';
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  v_res := public.authorize_playback(d_guest, 'crimson-contract-ep1', null, null);
  assert (v_res ->> 'allowed')::boolean and not (v_res ? 'preview_seconds'), format('member token, not a preview: %s', v_res);
  reset role;

  -- ------------------------------------------------- link Google, app_metadata first
  update auth.users set raw_app_meta_data = '{"provider":"email","providers":["email","google"]}' where id = d_link_b;
  select display_name, provider into r from public.profiles where user_id = d_link_b;
  assert r.provider = 'guest' and r.display_name = 'Guest Viewer', format('order B first pass keeps the guest: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = d_link_b) = 0, 'order B: no bonus before the identity';
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), d_link_b, 'google', 'smoke-device-google-b', '{"sub":"smoke-device-google-b","name":"Ben Device"}',
          now(), now() + interval '1 second', now());
  select display_name, provider into r from public.profiles where user_id = d_link_b;
  assert r.provider = 'google' and r.display_name = 'Ben Device', format('order B linked: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = d_link_b) = 150, 'order B: welcome bonus 150';

  -- ------------------------------------------------- the device's next guest
  -- (member signed out on that phone, or deleted the app's data and the
  -- account was linked meanwhile): the linked account is not handed out.
  set local role service_role;
  assert not exists (select 1 from public.guest_session_lookup(dev_a)), 'lookup skips a guest that linked an identity';
  reset role;

  insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values (d_next, 'authenticated', 'authenticated', email_next, now(), '{"provider":"email","providers":["email"]}',
          '{"provider":"guest","display_name":"Guest Viewer","device":true}', false, now(), now());
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), d_next, 'email', d_next::text, jsonb_build_object('sub', d_next::text, 'email', email_next), now(), now(), now());

  set local role service_role;
  perform public.guest_session_register(dev_a, d_next, ip_a);
  select * into r from public.guest_session_lookup(dev_a);
  assert r.user_id = d_next and r.email = email_next, format('device re-pointed to its new guest: %s', r);
  reset role;
  assert (select user_id from private.device_guests where device_hash = dev_a) = d_next, 'one row per device';

  -- ------------------------------------------------- per-IP daily cap
  update public.app_config set value = '3' where key = 'guest_new_per_ip_per_day';
  insert into auth.users (id, aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  select x, 'authenticated', 'authenticated', '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now()
  from unnest(array[cap1, cap2, cap3, cap4]) x;

  set local role service_role;
  perform public.guest_session_register(md5(cap1::text) || md5('1'), cap1, ip_cap);
  perform public.guest_session_register(md5(cap2::text) || md5('2'), cap2, ip_cap);
  assert public.guest_session_check_ip(ip_cap), '2 of 3 used: may create';
  perform public.guest_session_register(md5(cap3::text) || md5('3'), cap3, ip_cap);
  assert not public.guest_session_check_ip(ip_cap), '3 of 3 used: check_ip false';
  assert public.guest_session_check_ip(ip_a) = false, 'ip_a used 3 as well (d_guest, d_link_b, d_next)';
  begin
    perform public.guest_session_register(md5(cap4::text) || md5('4'), cap4, ip_cap);
    raise exception 'FAIL: 4th guest from one IP registered';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text <> 'guest_limit' then raise; end if;
  end;
  reset role;
  assert not exists (select 1 from private.device_guests where user_id = cap4), 'over-cap guest not registered';
  assert (select created from private.guest_session_log where ip_hash = ip_cap and day = (now() at time zone 'utc')::date) = 3,
    'over-cap attempt not counted';

  -- ------------------------------------------------- admin console
  -- d_guest is a member now; make it an admin (claims cleared: the is_admin
  -- guard trigger refuses changes made "as" a non-admin user).
  perform set_config('request.jwt.claims', '', true);
  update public.profiles set is_admin = true where user_id = d_guest;
  select public_code into v_code_next from public.profiles where user_id = d_next;
  select public_code into v_code_guest from public.profiles where user_id = d_guest;
  perform set_config('request.jwt.claims', json_build_object('sub', d_guest, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_config('guest_new_per_ip_per_day', '50'::jsonb);
  begin
    perform public.admin_set_config('guest_new_per_ip_per_day', '-1'::jsonb);
    raise exception 'FAIL: negative guest_new_per_ip_per_day accepted';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text not like 'invalid_value%' then raise; end if;
  end;
  select * into r from public.admin_find_user(v_code_next);
  assert r.user_id = d_next and r.is_anonymous, format('admin_find_user shows the device guest as a guest: %s', r);
  select * into r from public.admin_find_user(v_code_guest);
  assert r.user_id = d_guest and not r.is_anonymous, 'linked account shown as a member';
  assert (public.admin_dashboard_stats() ->> 'users_guest')::integer >= 2, 'dashboard counts device + anonymous guests';
  reset role;
  assert (select value from public.app_config where key = 'guest_new_per_ip_per_day') = '50'::jsonb, 'admin setting saved';

  -- ------------------------------------------------- deletion cascades
  delete from auth.users where id = d_next;
  assert not exists (select 1 from private.device_guests where device_hash = dev_a), 'deleting the guest frees the device';

  raise exception 'ALL_TESTS_PASSED';
end;
$$;
