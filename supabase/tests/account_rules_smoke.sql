-- Smoke test for 20261019120000_account_rules.sql, with the guest playback
-- rule of 20261020120000_device_guests.sql (guests watch free episodes in
-- full and may unlock ad episodes; no previews). Run as postgres; always
-- ends in an exception so everything rolls back. Success = "ALL_TESTS_PASSED".
--
-- GoTrue's order of writes when a guest links an identity is not documented,
-- so both orders are simulated: identity row first, then is_anonymous=false
-- (order A), and the reverse (order B).
do $$
declare
  g_guest uuid := gen_random_uuid();    -- stays a guest: free / ad episodes, account_required otherwise
  g_link_a uuid := gen_random_uuid();   -- guest links Google, identity row first
  g_link_b uuid := gen_random_uuid();   -- guest links Google, is_anonymous flips first
  g_renamed uuid := gen_random_uuid();  -- guest renamed themselves, then links Google
  g_phone uuid := gen_random_uuid();    -- guest verifies a phone number
  u_member uuid := gen_random_uuid();   -- direct email sign-up
  u_google uuid := gen_random_uuid();   -- direct Google sign-up
  u_reused uuid := gen_random_uuid();   -- Google identity already used by a deleted account
  u_p1 uuid := gen_random_uuid();       -- phone sign-up, later deleted
  u_p2 uuid := gen_random_uuid();       -- same phone number, new account
  v_res jsonb;
  v_int integer;
  v_text text;
  v_sql text;
  v_sub public.subscriptions;
  r record;
  i integer;
begin
  -- Known config, whatever the live values are (rolled back at the end).
  update public.app_config set value = '150' where key = 'welcome_bonus_coins';
  update public.app_config set value = '20' where key = 'ad_unlocks_per_day';
  update public.app_config set value = '0' where key = 'daily_minutes_budget';
  update public.app_config set value = '60' where key = 'playback_max_tokens_per_10min';
  update public.app_config set value = '80' where key = 'playback_max_episodes_per_hour';
  update public.app_config set value = 'true' where key = 'simulated_payments';
  update public.episodes set published = true where id in ('crimson-contract-ep1', 'crimson-contract-ep3', 'crimson-contract-ep4', 'crimson-contract-ep7');
  assert not exists (select 1 from public.app_config where key in ('guest_preview_seconds', 'guest_previews_per_day')),
    'preview settings removed';

  -- ------------------------------------------------- guests start with 0
  insert into auth.users (id, aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values
    (g_guest, 'authenticated', 'authenticated', '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now()),
    (g_link_a, 'authenticated', 'authenticated', '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now()),
    (g_link_b, 'authenticated', 'authenticated', '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now()),
    (g_renamed, 'authenticated', 'authenticated', '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now()),
    (g_phone, 'authenticated', 'authenticated', '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now());

  select count(*) into v_int from public.wallets where user_id in (g_guest, g_link_a, g_link_b, g_renamed, g_phone) and balance = 0;
  assert v_int = 5, 'every new guest starts with 0 coins';
  select display_name, provider into r from public.profiles where user_id = g_guest;
  assert r.display_name = 'Guest Viewer' and r.provider = 'guest', format('guest profile: %s / %s', r.display_name, r.provider);

  -- ------------------------------- order A: identity row, then the flip
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), g_link_a, 'google', 'smoke-google-sub-a',
          '{"sub":"smoke-google-sub-a","email":"aisha@test.keybox.invalid","full_name":"Aisha Rahman","name":"Aisha"}', now(), now(), now());
  assert (select balance from public.wallets where user_id = g_link_a) = 0, 'no bonus while still anonymous';
  assert (select provider from public.profiles where user_id = g_link_a) = 'guest', 'profile untouched while still anonymous';

  update auth.users
  set is_anonymous = false, raw_app_meta_data = '{"provider":"google","providers":["google"]}'
  where id = g_link_a;

  select display_name, provider into r from public.profiles where user_id = g_link_a;
  assert r.display_name = 'Aisha Rahman' and r.provider = 'google', format('order A profile: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = g_link_a) = 150, 'order A: welcome bonus 150';

  -- Re-running the triggers (e.g. app_metadata rewritten on the next sign-in) pays nothing.
  update auth.users set raw_app_meta_data = '{"provider":"google","providers":["google"],"x":1}' where id = g_link_a;
  assert private.grant_welcome_bonus(g_link_a) = 0, 'grant is idempotent';

  -- Linking a phone number as well: no second bonus, but the number is recorded.
  update auth.users set phone = '60100000011' where id = g_link_a;
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), g_link_a, 'phone', g_link_a::text,
          jsonb_build_object('sub', g_link_a::text, 'phone', '60100000011'), now(), now() + interval '1 second', now());
  assert (select balance from public.wallets where user_id = g_link_a) = 150, 'second identity pays nothing';
  select count(*) into v_int from public.transactions where user_id = g_link_a and label = 'Welcome bonus';
  assert v_int = 1, format('exactly one welcome bonus transaction (got %s)', v_int);
  assert exists (select 1 from private.welcome_bonus_grants where provider = 'phone' and provider_id = '60100000011' and user_id = g_link_a and coins = 0),
    'linked phone recorded by number, with 0 coins';
  assert (select provider from public.profiles where user_id = g_link_a) = 'google', 'provider stays the app_metadata one';

  -- ------------------------------- order B: the flip, then the identity row
  update auth.users
  set is_anonymous = false, raw_app_meta_data = '{"provider":"google","providers":["google"]}'
  where id = g_link_b;
  select display_name, provider into r from public.profiles where user_id = g_link_b;
  assert r.display_name = 'KBbox Member' and r.provider = 'google', format('order B first pass: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = g_link_b) = 0, 'order B: no identity yet, no bonus yet';

  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), g_link_b, 'google', 'smoke-google-sub-b',
          '{"sub":"smoke-google-sub-b","name":"Ben Tan"}', now(), now(), now());
  select display_name, provider into r from public.profiles where user_id = g_link_b;
  assert r.display_name = 'Ben Tan' and r.provider = 'google', format('order B profile: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = g_link_b) = 150, 'order B: welcome bonus 150';

  -- ------------------------------- a name the guest chose is kept
  update public.profiles set display_name = 'Ming' where user_id = g_renamed;
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), g_renamed, 'google', 'smoke-google-sub-r',
          '{"sub":"smoke-google-sub-r","full_name":"Someone Else"}', now(), now(), now());
  update auth.users set is_anonymous = false, raw_app_meta_data = '{"provider":"google","providers":["google"]}' where id = g_renamed;
  select display_name, provider into r from public.profiles where user_id = g_renamed;
  assert r.display_name = 'Ming' and r.provider = 'google', format('renamed guest: %s / %s', r.display_name, r.provider);

  -- ------------------------------- guest verifies a phone number (WhatsApp)
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), g_phone, 'phone', g_phone::text,
          jsonb_build_object('sub', g_phone::text, 'phone', '60100000022'), now(), now(), now());
  update auth.users
  set is_anonymous = false, phone = '60100000022', raw_app_meta_data = '{"provider":"phone","providers":["phone"]}'
  where id = g_phone;
  select display_name, provider into r from public.profiles where user_id = g_phone;
  assert r.display_name = 'KBbox Member' and r.provider = 'phone', format('phone link: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = g_phone) = 150, 'phone link: welcome bonus 150';

  -- ------------------------------- direct sign-ups (user row, then identity)
  insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values
    (u_member, 'authenticated', 'authenticated', 'member@test.keybox.invalid', '{"provider":"email","providers":["email"]}', '{}', false, now(), now()),
    (u_google, 'authenticated', 'authenticated', 'carol@test.keybox.invalid', '{"provider":"google","providers":["google"]}', '{"full_name":"Carol Lim"}', false, now(), now());
  assert (select balance from public.wallets where user_id = u_member) = 0, 'sign-up row alone gives 0 coins';
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values
    (gen_random_uuid(), u_member, 'email', u_member::text, jsonb_build_object('sub', u_member::text, 'email', 'Member@Test.Keybox.invalid'), now(), now(), now()),
    (gen_random_uuid(), u_google, 'google', 'smoke-google-sub-c', '{"sub":"smoke-google-sub-c","full_name":"Carol Lim"}', now(), now(), now());
  assert (select balance from public.wallets where user_id = u_member) = 150, 'email sign-up: welcome bonus 150';
  assert exists (select 1 from private.welcome_bonus_grants where provider = 'email' and provider_id = 'member@test.keybox.invalid'),
    'email identity keyed by lower-cased address';
  select display_name, provider into r from public.profiles where user_id = u_google;
  assert r.display_name = 'Carol Lim' and r.provider = 'google' , format('google sign-up: %s / %s', r.display_name, r.provider);
  assert (select balance from public.wallets where user_id = u_google) = 150, 'google sign-up: welcome bonus 150';

  -- ------------------------------- an identity used by a deleted account
  insert into private.welcome_bonus_grants (provider, provider_id, user_id, coins)
  values ('google', 'smoke-google-sub-deleted', null, 150);
  insert into auth.users (id, aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values (u_reused, 'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{}', false, now(), now());
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), u_reused, 'google', 'smoke-google-sub-deleted', '{"sub":"smoke-google-sub-deleted","name":"Dan"}', now(), now(), now());
  assert (select balance from public.wallets where user_id = u_reused) = 0, 'reused Google identity gives nothing';
  assert (select display_name from public.profiles where user_id = u_reused) = 'Dan', 'reused identity still names the profile';

  -- Same for a phone number: sign up, delete the account, sign up again.
  insert into auth.users (id, aud, role, phone, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values (u_p1, 'authenticated', 'authenticated', '60100000033', '{"provider":"phone","providers":["phone"]}', '{}', false, now(), now());
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), u_p1, 'phone', u_p1::text, jsonb_build_object('sub', u_p1::text, 'phone', '60100000033'), now(), now(), now());
  assert (select balance from public.wallets where user_id = u_p1) = 150, 'first phone account gets the bonus';
  delete from auth.users where id = u_p1;
  assert exists (select 1 from private.welcome_bonus_grants where provider = 'phone' and provider_id = '60100000033' and user_id is null),
    'grant row survives account deletion';
  insert into auth.users (id, aud, role, phone, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values (u_p2, 'authenticated', 'authenticated', '60100000033', '{"provider":"phone","providers":["phone"]}', '{}', false, now(), now());
  insert into auth.identities (id, user_id, provider, provider_id, identity_data, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), u_p2, 'phone', u_p2::text, jsonb_build_object('sub', u_p2::text, 'phone', '+60 10-000 0033'), now(), now(), now());
  assert (select balance from public.wallets where user_id = u_p2) = 0, 'same phone number on a new account gives nothing';

  -- ------------------------------- guests: every coin / membership RPC refused
  perform set_config('request.jwt.claims', json_build_object('sub', g_guest, 'role', 'authenticated')::text, true);
  set local role authenticated;

  foreach v_sql in array array[
    'select public.unlock_episode_with_coins(''crimson-contract-ep4'')',
    'select public.claim_daily_mission()',
    'select public.simulate_purchase(''coins-100'')',
    'select public.simulate_subscribe(''monthly'')'
  ] loop
    begin
      execute v_sql;
      raise exception 'FAIL: guest could run %', v_sql;
    exception when raise_exception then
      get stacked diagnostics v_text = message_text;
      if v_text <> 'account_required' then raise; end if;
    end;
  end loop;
  reset role;
  assert (select balance from public.wallets where user_id = g_guest) = 0, 'guest still has 0 coins';

  -- ------------------------------- guest playback (service role, like playback-token)
  insert into public.video_assets (episode_id, provider_uid, status, duration_sec, ready_at) values
    ('crimson-contract-ep1', md5(gen_random_uuid()::text), 'ready', 90, now()),
    ('crimson-contract-ep3', md5(gen_random_uuid()::text), 'ready', 95, now()),
    ('crimson-contract-ep4', md5(gen_random_uuid()::text), 'ready', 100, now());
  set local role service_role;

  v_res := public.authorize_playback(g_guest, 'crimson-contract-ep1', null, null);
  assert (v_res ->> 'allowed')::boolean, format('guest free episode allowed: %s', v_res);
  assert not (v_res ? 'preview_seconds'), 'guest free episode is a full token, not a preview';
  assert (v_res ->> 'ttl_seconds')::integer = coalesce((select (value #>> '{}')::integer from public.app_config where key = 'playback_token_ttl_seconds'), 900),
    'guest ttl = playback_token_ttl_seconds';

  v_res := public.authorize_playback(g_guest, 'crimson-contract-ep4', null, null);
  assert v_res ->> 'reason' = 'account_required', format('guest coin episode -> account_required: %s', v_res);
  v_res := public.authorize_playback(g_guest, 'crimson-contract-ep7', null, null);
  assert v_res ->> 'reason' = 'account_required', format('guest subscriber episode -> account_required: %s', v_res);
  v_res := public.authorize_playback(g_guest, 'crimson-contract-ep3', null, null);
  assert v_res ->> 'reason' = 'not_entitled', format('guest ad episode not unlocked -> not_entitled: %s', v_res);

  -- No daily cap on free episodes any more.
  for i in 2..21 loop
    v_res := public.authorize_playback(g_guest, 'crimson-contract-ep1', null, null);
    assert (v_res ->> 'allowed')::boolean, format('free token %s allowed', i);
  end loop;
  reset role;

  -- Guests may unlock ad episodes, then watch them.
  perform set_config('request.jwt.claims', json_build_object('sub', g_guest, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert public.redeem_ad_reward('crimson-contract-ep3'), 'guest redeem_ad_reward -> true';
  reset role;
  set local role service_role;
  v_res := public.authorize_playback(g_guest, 'crimson-contract-ep3', null, null);
  assert (v_res ->> 'allowed')::boolean and not (v_res ? 'preview_seconds'), format('guest ad-unlocked episode -> granted: %s', v_res);

  -- Members get normal tokens.
  v_res := public.authorize_playback(u_member, 'crimson-contract-ep1', null, null);
  assert (v_res ->> 'allowed')::boolean and not (v_res ? 'preview_seconds'), 'member token';
  assert (v_res ->> 'ttl_seconds')::integer = coalesce((select (value #>> '{}')::integer from public.app_config where key = 'playback_token_ttl_seconds'), 900), 'member ttl unchanged';
  reset role;

  assert (select balance from public.wallets where user_id = g_guest) = 0, 'ad unlock pays the guest no coins';
  select count(*) into v_int from public.playback_events where user_id = g_guest and decision = 'preview';
  assert v_int = 0, format('no previews logged (got %s)', v_int);
  select count(*) into v_int from public.playback_events where user_id = g_guest and decision = 'granted';
  assert v_int = 22, format('22 granted logged (got %s)', v_int);
  select count(*) into v_int from public.playback_events where user_id = g_guest and decision = 'account_required';
  assert v_int = 2, format('2 account_required logged (got %s)', v_int);
  select count(*) into v_int from public.playback_events where user_id = g_guest and decision = 'not_entitled';
  assert v_int = 1, format('1 not_entitled logged (got %s)', v_int);

  -- ------------------------------- membership bonus once per period
  perform set_config('request.jwt.claims', json_build_object('sub', u_member, 'role', 'authenticated')::text, true);
  set local role authenticated;

  v_sub := public.simulate_subscribe('monthly');
  assert v_sub.is_active and v_sub.bonus_granted_at is not null, 'subscribed, bonus recorded';
  assert (select balance from public.wallets where user_id = u_member) = 250, 'monthly bonus +100';
  perform public.simulate_subscribe('monthly');
  assert (select balance from public.wallets where user_id = u_member) = 250, 'no bonus while membership is running';

  v_sub := public.cancel_subscription();
  assert v_sub.is_active and v_sub.cancelled_at is not null, 'cancel only marks cancelled_at';
  assert public.can_watch('crimson-contract-ep7'), 'cancelled membership keeps access until renews_at';
  v_sub := public.simulate_subscribe('monthly');
  assert v_sub.cancelled_at is null, 'subscribing again resumes (clears cancelled_at)';
  assert (select balance from public.wallets where user_id = u_member) = 250, 'resume pays no bonus';
  reset role;

  -- expiry job
  update public.subscriptions set renews_at = now() - interval '1 minute' where user_id = u_member;
  assert private.expire_subscriptions() >= 1, 'expiry job switched something off';
  assert not (select is_active from public.subscriptions where user_id = u_member), 'expired membership is_active = false';
  assert not private.has_active_subscription(u_member), 'expired membership not active';
  assert exists (select 1 from cron.job where jobname = 'keybox-expire-subscriptions'), 'expiry cron job scheduled';

  set local role authenticated;
  perform public.simulate_subscribe('monthly');
  assert (select balance from public.wallets where user_id = u_member) = 250, 'no second bonus within one billing period';
  reset role;
  update public.subscriptions set is_active = false, bonus_granted_at = now() - interval '2 months' where user_id = u_member;
  set local role authenticated;
  perform public.simulate_subscribe('monthly');
  assert (select balance from public.wallets where user_id = u_member) = 350, 'bonus again after a full billing period';

  -- ------------------------------- reset
  perform public.reset_my_data();
  reset role;
  select * into v_sub from public.subscriptions where user_id = u_member;
  assert (select balance from public.wallets where user_id = u_member) = 0, 'reset -> 0 coins';
  assert not v_sub.is_active and v_sub.bonus_granted_at is null and v_sub.cancelled_at is null, 'reset clears membership';
  assert exists (select 1 from private.welcome_bonus_grants where user_id = u_member), 'reset keeps the welcome-bonus record';
  assert private.grant_welcome_bonus(u_member) = 0, 'reset cannot earn the welcome bonus again';

  -- ------------------------------- account deletion archive
  perform set_config('request.jwt.claims', json_build_object('sub', g_link_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.archive_deleted_account(g_link_a);
    raise exception 'FAIL: authenticated could call archive_deleted_account';
  exception when insufficient_privilege then null;
  end;
  reset role;
  set local role service_role;
  perform public.archive_deleted_account(g_link_a);
  reset role;
  select * into r from private.deleted_accounts where user_id = g_link_a;
  assert r.public_code = (select public_code from public.profiles where user_id = g_link_a) and r.provider = 'google',
    'deleted account archived with its watermark code';

  -- ------------------------------- admin can edit the new settings
  -- (clear the claims first: the is_admin guard trigger refuses changes made
  -- "as" a non-admin user)
  perform set_config('request.jwt.claims', '', true);
  update public.profiles set is_admin = true where user_id = u_google;
  perform set_config('request.jwt.claims', json_build_object('sub', u_google, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_config('welcome_bonus_coins', '200'::jsonb);
  foreach v_sql in array array['guest_preview_seconds', 'guest_previews_per_day'] loop
    begin
      perform public.admin_set_config(v_sql, '30'::jsonb);
      raise exception 'FAIL: removed setting % accepted', v_sql;
    exception when raise_exception then
      get stacked diagnostics v_text = message_text;
      if v_text not like 'unknown_setting%' then raise; end if;
    end;
  end loop;
  begin
    perform public.admin_set_config('welcome_bonus_coins', '-1'::jsonb);
    raise exception 'FAIL: negative welcome bonus accepted';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text not like 'invalid_value%' then raise; end if;
  end;
  reset role;
  assert (select value from public.app_config where key = 'welcome_bonus_coins') = '200'::jsonb, 'admin setting saved';

  raise exception 'ALL_TESTS_PASSED';
end;
$$;
