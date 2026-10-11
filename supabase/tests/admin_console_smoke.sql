-- Smoke test for 20261010120000_admin_console.sql. Run as postgres; always
-- ends in an exception so everything rolls back. Success = "ALL_TESTS_PASSED".
do $$
declare
  u_admin uuid := gen_random_uuid();
  u_user uuid := gen_random_uuid();
  v_code text;
  v_json jsonb;
  v_int integer;
  v_text text;
  v_fn text;
begin
  insert into auth.users (id, aud, role, email, is_anonymous, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values
    (u_admin, 'authenticated', 'authenticated', 'admin@test.keybox.invalid', false, '{}', '{}', now(), now()),
    (u_user, 'authenticated', 'authenticated', 'viewer@test.keybox.invalid', false, '{}', '{}', now(), now());
  update public.profiles set is_admin = true where user_id = u_admin;
  select public_code into v_code from public.profiles where user_id = u_user;

  -- ------------------------------------------------ non-admin is refused
  perform set_config('request.jwt.claims', json_build_object('sub', u_user, 'role', 'authenticated')::text, true);
  set local role authenticated;

  foreach v_fn in array array[
    'select public.admin_dashboard_stats()',
    'select public.admin_set_config(''daily_minutes_budget'', ''5''::jsonb)',
    'select * from public.admin_list_abuse_flags(true, 10)',
    format('select public.admin_block_user(%L, 10, %L)', u_user, 'x'),
    'select * from public.admin_find_user(''viewer@test'')',
    'select * from public.admin_playback_events(null, 10)'
  ] loop
    begin
      execute v_fn;
      raise exception 'FAIL: non-admin could run %', v_fn;
    exception when raise_exception then
      get stacked diagnostics v_text = message_text;
      if v_text <> 'admin_only' then raise; end if;
    end;
  end loop;

  select count(*) into v_int from public.app_config;
  assert v_int = (select count(*) from public.app_config where is_public), 'non-admin only sees public config';

  -- ------------------------------------------------------ admin works
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_int from public.app_config where not is_public;
  assert v_int > 0, 'admin sees private config rows';

  v_json := public.admin_dashboard_stats();
  assert (v_json ->> 'episodes_total')::int >= 54, 'dashboard counts episodes';
  assert v_json ? 'stored_minutes' and v_json ? 'open_abuse_flags', 'dashboard has all keys';

  perform public.admin_set_config('daily_minutes_budget', '1234'::jsonb);
  assert (select value from public.app_config where key = 'daily_minutes_budget') = '1234'::jsonb, 'setting saved';
  perform public.admin_set_config('budget_soft_ratio', '0.5'::jsonb);
  perform public.admin_set_config('simulated_payments', 'false'::jsonb);

  begin
    perform public.admin_set_config('functions_base_url', '"https://evil.example"'::jsonb);
    raise exception 'FAIL: non-whitelisted key accepted';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text not like 'unknown_setting%' then raise; end if;
  end;

  begin
    perform public.admin_set_config('daily_minutes_budget', '-1'::jsonb);
    raise exception 'FAIL: out-of-range value accepted';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text not like 'invalid_value%' then raise; end if;
  end;

  begin
    perform public.admin_set_config('simulated_payments', '"yes"'::jsonb);
    raise exception 'FAIL: wrong type accepted';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text not like 'invalid_value%' then raise; end if;
  end;

  -- find by watermark code (any case) and by email fragment
  assert (select count(*) from public.admin_find_user(lower(v_code)) where user_id = u_user) = 1, 'find by code';
  assert (select count(*) from public.admin_find_user('viewer@test') where user_id = u_user) = 1, 'find by email';

  -- manual block shows up as an open flag and blocks playback
  perform public.admin_block_user(u_user, 30, 'leaked episode');
  assert (select count(*) from public.admin_list_abuse_flags(true, 50) where user_id = u_user and reason = 'manual_block') = 1, 'block listed';
  assert (select blocked_until from public.admin_find_user(v_code)) > now(), 'find shows block';

  reset role;
  set local role service_role;
  assert public.authorize_playback(u_user, 'crimson-contract-ep1', null, null) ->> 'reason' = 'blocked', 'blocked user cannot play';
  reset role;
  set local role authenticated;

  select count(*) into v_int from public.admin_playback_events(u_user, 10);
  assert v_int = 1, 'playback log shows the refused attempt';

  reset role;
  raise exception 'ALL_TESTS_PASSED';
end;
$$;
