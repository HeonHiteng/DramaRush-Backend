-- Smoke test for 20261111120000_series_published.sql. Run as postgres; always
-- ends in an exception so everything rolls back. Success = "ALL_TESTS_PASSED".
--
-- Uses its own published series (zz-smoke-live) plus crimson-contract, which
-- is forced to unpublished here whatever its live state is.
do $$
declare
  u_admin uuid := gen_random_uuid();
  u_user uuid := gen_random_uuid();
  v_res jsonb;
  v_int integer;
  v_text text;
begin
  -- ----------------------------------------------------------------- setup
  update public.app_config set value = '0' where key = 'daily_minutes_budget';
  update public.app_config set value = '60' where key = 'playback_max_tokens_per_10min';
  update public.app_config set value = '80' where key = 'playback_max_episodes_per_hour';
  update public.app_config set value = '20' where key = 'ad_unlocks_per_day';

  insert into auth.users (id, aud, role, email, is_anonymous, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values
    (u_admin, 'authenticated', 'authenticated', 'admin@test.keybox.invalid', false, '{}', '{}', now(), now()),
    (u_user, 'authenticated', 'authenticated', 'viewer@test.keybox.invalid', false, '{}', '{}', now(), now());
  update public.profiles set is_admin = true where user_id = u_admin;
  update public.wallets set balance = 1000 where user_id = u_user;

  assert (select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'series' and column_name = 'published') = 'true',
    'series.published defaults to true';

  insert into public.series (id, title, synopsis, genres, rating, status, language,
    poster_color_from, poster_color_to, banner_color_from, banner_color_to)
  values ('zz-smoke-live', 'Smoke Live', 'test', '{}', 4.0, 'ongoing', 'en', '#000', '#111', '#000', '#111');
  assert (select published from public.series where id = 'zz-smoke-live'), 'new series is published by default';
  insert into public.episodes (id, series_id, number, title, duration_sec, access, published)
  values ('zz-smoke-live-ep1', 'zz-smoke-live', 1, 'Ep 1', 60, 'free', true);

  update public.series set published = false where id = 'crimson-contract';
  update public.episodes set published = true where id in ('crimson-contract-ep1', 'crimson-contract-ep3', 'crimson-contract-ep4');

  insert into public.video_assets (episode_id, provider_uid, status, duration_sec, ready_at) values
    ('zz-smoke-live-ep1', md5(gen_random_uuid()::text), 'ready', 60, now()),
    ('crimson-contract-ep1', md5(gen_random_uuid()::text), 'ready', 90, now());

  -- ------------------------------------------------------------- anon
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  assert exists (select 1 from public.series where id = 'zz-smoke-live'), 'anon sees a published series';
  assert exists (select 1 from public.episodes where id = 'zz-smoke-live-ep1'), 'anon sees episodes of a published series';
  assert not exists (select 1 from public.series where id = 'crimson-contract'), 'anon must not see an unpublished series';
  assert not exists (select 1 from public.episodes where series_id = 'crimson-contract'), 'anon must not see episodes of an unpublished series';
  assert not exists (select 1 from public.series where not published), 'anon sees no unpublished series at all';

  -- ------------------------------------------------------------- normal user
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert exists (select 1 from public.series where id = 'zz-smoke-live'), 'user sees a published series';
  assert exists (select 1 from public.episodes where id = 'zz-smoke-live-ep1'), 'user sees episodes of a published series';
  assert not exists (select 1 from public.series where id = 'crimson-contract'), 'user must not see an unpublished series';
  assert not exists (select 1 from public.episodes where series_id = 'crimson-contract'), 'user must not see episodes of an unpublished series';
  assert public.can_watch('zz-smoke-live-ep1'), 'free episode of a published series is watchable';
  assert not public.can_watch('crimson-contract-ep1'), 'free episode of an unpublished series is not watchable';

  -- no charging for an episode of an unpublished series
  begin
    perform public.unlock_episode_with_coins('crimson-contract-ep4');
    raise exception 'FAIL: coin unlock of an unpublished series accepted';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text not like 'episode % not found' then raise; end if;
  end;
  begin
    perform public.redeem_ad_reward('crimson-contract-ep3');
    raise exception 'FAIL: ad unlock of an unpublished series accepted';
  exception when raise_exception then
    get stacked diagnostics v_text = message_text;
    if v_text not like 'episode % not found' then raise; end if;
  end;
  assert (select balance from public.wallets where user_id = u_user) = 1000, 'no coins charged';

  -- users can't publish a series themselves
  update public.series set published = true where id = 'crimson-contract';
  get diagnostics v_int = row_count;
  assert v_int = 0, 'non-admin must not change series.published';

  -- ------------------------------------------------------------- admin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert exists (select 1 from public.series where id = 'crimson-contract'), 'admin sees an unpublished series';
  assert exists (select 1 from public.episodes where id = 'crimson-contract-ep1'), 'admin sees episodes of an unpublished series';
  v_res := public.admin_dashboard_stats();
  assert (v_res ->> 'series')::int > (v_res ->> 'series_published')::int, 'dashboard: series counts all, series_published only published';

  -- ------------------------------------------------- authorize_playback
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  v_res := public.authorize_playback(u_user, 'crimson-contract-ep1', null, null);
  assert v_res ->> 'allowed' = 'false' and v_res ->> 'reason' = 'not_entitled', 'unpublished series -> not_entitled: ' || v_res::text;
  v_res := public.authorize_playback(u_user, 'zz-smoke-live-ep1', null, null);
  assert v_res ->> 'allowed' = 'true', 'published series still plays: ' || v_res::text;

  -- republishing (admin toggle) brings it back
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.series set published = true where id = 'crimson-contract';
  get diagnostics v_int = row_count;
  assert v_int = 1, 'admin can publish a series';

  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  v_res := public.authorize_playback(u_user, 'crimson-contract-ep1', null, null);
  assert v_res ->> 'allowed' = 'true', 'republished series plays again: ' || v_res::text;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  assert exists (select 1 from public.episodes where id = 'crimson-contract-ep1'), 'anon sees episodes of a republished series';

  reset role;
  raise exception 'ALL_TESTS_PASSED';
end $$;
