-- Smoke test for 20261012120000_video_dimensions.sql. Run as postgres; ends
-- with ALL_TESTS_PASSED raised as an error so everything rolls back.
do $$
declare
  v_user uuid;
  v_rows int;
begin
  -- anon can read the new columns of published episodes
  set local role anon;
  perform video_width, video_height from public.episodes where published limit 1;
  reset role;

  -- a signed-in non-admin can read but not change them
  select id into v_user from auth.users where not exists (
    select 1 from public.profiles p where p.user_id = auth.users.id and p.is_admin
  ) limit 1;
  if v_user is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    set local role authenticated;
    perform video_width from public.episodes limit 1;
    update public.episodes set video_width = 1, video_height = 1 where id = 'crimson-contract-ep1';
    get diagnostics v_rows = row_count;
    assert v_rows = 0, 'non-admin must not update episode video size';
    reset role;
  end if;

  -- constraints reject nonsense
  begin
    update public.episodes set video_width = 0 where id = 'crimson-contract-ep1';
    assert false, 'zero width must be rejected';
  exception when check_violation then null;
  end;
  begin
    update public.video_assets set height = 99999 where episode_id = 'crimson-contract-ep1';
    assert false, 'oversized height must be rejected';
  exception when check_violation then null;
  end;

  raise exception 'ALL_TESTS_PASSED';
end $$;
