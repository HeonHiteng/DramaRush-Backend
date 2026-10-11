-- Smoke test for 20261009160000_video_assets.sql + 20261009170000_playback_guard.sql.
-- Same convention as entitlements_smoke.sql: run as postgres; it always ends
-- in an exception so everything rolls back. Success = "ALL_TESTS_PASSED".
do $$
declare
  u_member uuid := gen_random_uuid();
  u_other uuid := gen_random_uuid();
  u_admin uuid := gen_random_uuid();
  v_res jsonb;
  v_int integer;
  i integer;
begin
  -- ----------------------------------------------------------------- setup
  insert into auth.users (id, aud, role, email, is_anonymous, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values
    (u_member, 'authenticated', 'authenticated', 'member@test.keybox.invalid', false, '{}', '{}', now(), now()),
    (u_other, 'authenticated', 'authenticated', 'other@test.keybox.invalid', false, '{}', '{}', now(), now()),
    (u_admin, 'authenticated', 'authenticated', 'admin@test.keybox.invalid', false, '{}', '{}', now(), now());
  update public.profiles set is_admin = true where user_id = u_admin;

  -- ep1 free, ep3 ad_unlock, ep4 coin have ready videos; ep2 (free) has none.
  insert into public.video_assets (episode_id, provider_uid, status, duration_sec, ready_at) values
    ('crimson-contract-ep1', repeat('a', 32), 'ready', 90, now()),
    ('crimson-contract-ep3', repeat('b', 32), 'ready', 95, now()),
    ('crimson-contract-ep4', repeat('c', 32), 'ready', 100, now()),
    ('crimson-contract-ep4', repeat('d', 32), 'processing', null, null);

  -- -------------------------------------------- who may read what
  perform set_config('request.jwt.claims', json_build_object('sub', u_member, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_int from public.video_assets;
  assert v_int = 0, 'normal user must not see any video asset';

  begin
    perform public.authorize_playback(u_member, 'crimson-contract-ep1', null, null);
    raise exception 'FAIL: authenticated could call authorize_playback';
  exception when insufficient_privilege then null;
  end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_int from public.video_assets;
  assert v_int = 4, 'admin sees all video assets';

  -- unpublished episodes are hidden from anon/users but not admins
  reset role;
  update public.episodes set published = false where id = 'crimson-contract-ep8';
  set local role authenticated;
  assert exists (select 1 from public.episodes where id = 'crimson-contract-ep8'), 'admin sees unpublished episode';
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  assert not exists (select 1 from public.episodes where id = 'crimson-contract-ep8'), 'anon must not see unpublished episode';

  -- ------------------------------------------ authorize_playback (service role)
  reset role;
  set local role service_role;

  v_res := public.authorize_playback(u_member, 'crimson-contract-ep1', '203.0.113.7', 'test-agent');
  assert (v_res ->> 'allowed')::boolean, 'free episode with ready video is allowed';
  assert v_res ->> 'provider_uid' = repeat('a', 32), 'returns the ready video uid';
  assert v_res ->> 'watermark_code' ~ '^[2-9A-HJ-NP-Z]{7}$', 'returns the watermark code';
  assert (v_res ->> 'ttl_seconds')::integer = 900, 'ttl from app_config';

  v_res := public.authorize_playback(u_member, 'crimson-contract-ep4', null, null);
  assert v_res ->> 'reason' = 'not_entitled', 'locked coin episode refused';

  v_res := public.authorize_playback(u_member, 'crimson-contract-ep2', null, null);
  assert v_res ->> 'reason' = 'unavailable', 'episode without ready video refused';

  v_res := public.authorize_playback(u_member, 'no-such-episode', null, null);
  assert v_res ->> 'reason' = 'not_entitled', 'unknown episode refused';

  reset role;
  update public.episodes set published = false where id = 'crimson-contract-ep1';
  set local role service_role;
  v_res := public.authorize_playback(u_member, 'crimson-contract-ep1', null, null);
  assert v_res ->> 'reason' = 'not_entitled', 'unpublished episode refused';
  reset role;
  update public.episodes set published = true where id = 'crimson-contract-ep1';

  -- unlocked coin episode -> uses the ready asset, not the processing one
  insert into public.unlocks (user_id, episode_id) values (u_member, 'crimson-contract-ep4');
  set local role service_role;
  v_res := public.authorize_playback(u_member, 'crimson-contract-ep4', null, null);
  assert (v_res ->> 'allowed')::boolean and v_res ->> 'provider_uid' = repeat('c', 32), 'unlocked coin episode allowed with ready asset';

  -- ------------------------------------------------------------ rate limit
  reset role;
  update public.app_config set value = '4' where key = 'playback_max_tokens_per_10min';
  set local role service_role;

  -- member already has 2 granted tokens; 2 more are fine, the 5th trips it
  for i in 1..2 loop
    v_res := public.authorize_playback(u_member, 'crimson-contract-ep1', null, null);
    assert (v_res ->> 'allowed')::boolean, format('token %s within limit', i);
  end loop;
  v_res := public.authorize_playback(u_member, 'crimson-contract-ep1', null, null);
  assert v_res ->> 'reason' = 'rate_limited', 'over the 10-minute limit';

  select count(*) into v_int from public.abuse_flags where user_id = u_member and resolved_at is null;
  assert v_int = 1, 'rate limit creates one abuse flag';

  v_res := public.authorize_playback(u_member, 'crimson-contract-ep1', null, null);
  assert v_res ->> 'reason' = 'blocked', 'blocked while flag is active';

  -- admin clears the block
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_resolve_abuse_flag((select id from public.abuse_flags where user_id = u_member));
  reset role;
  update public.app_config set value = '60' where key = 'playback_max_tokens_per_10min';
  set local role service_role;
  v_res := public.authorize_playback(u_member, 'crimson-contract-ep1', null, null);
  assert (v_res ->> 'allowed')::boolean, 'allowed again after admin resolves the flag';

  -- ------------------------------------------------------------ cost guard
  reset role;
  update public.app_config set value = '100' where key = 'daily_minutes_budget';
  perform public.record_stream_usage((now() at time zone 'utc')::date, 85);
  insert into public.unlocks (user_id, episode_id) values (u_other, 'crimson-contract-ep3'), (u_other, 'crimson-contract-ep4');
  set local role service_role;

  v_res := public.authorize_playback(u_other, 'crimson-contract-ep1', null, null);
  assert v_res ->> 'reason' = 'budget', 'at 85% free episodes stop';
  v_res := public.authorize_playback(u_other, 'crimson-contract-ep3', null, null);
  assert (v_res ->> 'allowed')::boolean, 'at 85% ad-unlocked episodes still play';

  reset role;
  perform public.record_stream_usage((now() at time zone 'utc')::date, 100);
  set local role service_role;
  v_res := public.authorize_playback(u_other, 'crimson-contract-ep3', null, null);
  assert v_res ->> 'reason' = 'budget', 'at 100% ad-unlocked episodes stop';
  v_res := public.authorize_playback(u_other, 'crimson-contract-ep4', null, null);
  assert (v_res ->> 'allowed')::boolean, 'at 100% paid (coin) episodes still play';

  -- every decision was logged
  reset role;
  select count(*) into v_int from public.playback_events where user_id in (u_member, u_other);
  assert v_int >= 14, format('decisions logged (got %s)', v_int);

  raise exception 'ALL_TESTS_PASSED';
end;
$$;
