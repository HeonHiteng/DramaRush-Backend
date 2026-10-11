-- Keybox: scheduled jobs (pg_cron).
--   * hourly: call the stream-usage-sync Edge Function so the daily cost
--     budget in authorize_playback() works on fresh numbers
--   * daily: prune playback_events older than 30 days
--
-- The cron -> function call is authenticated with a random secret generated
-- here and kept in Supabase Vault; the function checks it with
-- verify_cron_secret(), so nobody has to copy the secret around by hand.
-- The functions base URL is read from app_config.functions_base_url (set
-- per project after deploying, not hardcoded here).

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'keybox_cron_secret',
  'Shared secret: pg_cron -> stream-usage-sync Edge Function'
)
where not exists (select 1 from vault.secrets where name = 'keybox_cron_secret');

insert into public.app_config (key, value, is_public, description) values
  ('functions_base_url', 'null', false, 'https://<project-ref>.supabase.co/functions/v1 — used by the hourly usage-sync cron job.')
on conflict (key) do nothing;

create function public.verify_cron_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select decrypted_secret = p_secret and length(p_secret) >= 32
     from vault.decrypted_secrets where name = 'keybox_cron_secret'),
    false
  );
$$;

revoke execute on function public.verify_cron_secret(text) from public, anon, authenticated;
grant execute on function public.verify_cron_secret(text) to service_role;

-- Called by pg_cron. Does nothing until functions_base_url is configured.
create function private.trigger_stream_usage_sync()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text := (select value #>> '{}' from public.app_config where key = 'functions_base_url');
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'keybox_cron_secret');
begin
  if v_base is null or v_base !~ '^https://' or v_secret is null then
    return;
  end if;

  perform net.http_post(
    url := v_base || '/stream-usage-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

select cron.schedule('keybox-stream-usage-sync', '5 * * * *', 'select private.trigger_stream_usage_sync()');

select cron.schedule(
  'keybox-prune-playback-events',
  '17 3 * * *',
  $$delete from public.playback_events where created_at < now() - interval '30 days'$$
);
