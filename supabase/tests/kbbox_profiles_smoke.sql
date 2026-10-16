-- Smoke test for 20261014120000_kbbox_profiles.sql. Run as postgres; ends
-- with ALL_TESTS_PASSED raised as an error so everything rolls back.
do $$
declare
  v_phone uuid := gen_random_uuid();
  v_google uuid := gen_random_uuid();
  v_guest uuid := gen_random_uuid();
  v_rows int;
  r record;
begin
  insert into auth.users (id, aud, role, phone, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
  values
    (v_phone, 'authenticated', 'authenticated', '60100000001', '{"provider":"phone","providers":["phone"]}', '{}', false, now(), now()),
    (v_google, 'authenticated', 'authenticated', null, '{"provider":"google","providers":["google"]}', '{"full_name":"Aisha Rahman","name":"Aisha"}', false, now(), now()),
    (v_guest, 'authenticated', 'authenticated', null, '{}', '{"provider":"guest","display_name":"Guest Viewer"}', true, now(), now());

  select display_name, provider into r from public.profiles where user_id = v_phone;
  assert r.display_name = 'KBbox Member' and r.provider = 'phone', format('phone sign-up: %s / %s', r.display_name, r.provider);
  select display_name, provider into r from public.profiles where user_id = v_google;
  assert r.display_name = 'Aisha Rahman' and r.provider = 'google', format('google sign-up: %s / %s', r.display_name, r.provider);
  select display_name, provider into r from public.profiles where user_id = v_guest;
  assert r.display_name = 'Guest Viewer' and r.provider = 'guest', format('guest sign-up: %s / %s', r.display_name, r.provider);
  assert not exists (select 1 from public.profiles where display_name in ('Keybox Member', 'Keybox Admin')), 'old names renamed';

  -- A user can rename themselves, not others, and not to an empty name.
  perform set_config('request.jwt.claims', json_build_object('sub', v_phone, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set display_name = 'Ming' where user_id = v_phone;
  get diagnostics v_rows = row_count;
  assert v_rows = 1, 'user renames themselves';
  update public.profiles set display_name = 'Hacked' where user_id = v_google;
  get diagnostics v_rows = row_count;
  assert v_rows = 0, 'user cannot rename someone else';
  begin
    update public.profiles set display_name = '   ' where user_id = v_phone;
    assert false, 'blank name must be rejected';
  exception when check_violation then null;
  end;
  begin
    update public.profiles set public_code = 'XXXXXXX' where user_id = v_phone;
    assert false, 'public_code must not be writable';
  exception when insufficient_privilege then null;
  end;
  reset role;

  assert (select display_name from public.profiles where user_id = v_phone) = 'Ming', 'rename stuck';

  raise exception 'ALL_TESTS_PASSED';
end $$;
