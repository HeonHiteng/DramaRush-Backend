-- KBbox rename + better profiles for phone (WhatsApp) and Google sign-ups.
--
-- handle_new_user (20261009150000) named every non-guest "Keybox Member" and
-- recorded every non-guest as provider 'email'. Now:
--   provider     = metadata provider, else 'guest' for anonymous users, else
--                  Supabase's own app_metadata provider (email / phone /
--                  google / apple), else 'email'
--   display_name = metadata display_name, else the name Google/Apple send
--                  (full_name / name), else 'KBbox Member' / 'Guest Viewer'
-- The rest of the function (wallet, subscription, public code) is unchanged.
--
-- Users can rename themselves (column grant on display_name already exists);
-- a check keeps names to 1–40 visible characters.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
  v_avatar_seed text;
  v_provider text;
begin
  v_provider := coalesce(
    new.raw_user_meta_data ->> 'provider',
    case when new.is_anonymous then 'guest' end,
    new.raw_app_meta_data ->> 'provider',
    'email'
  );
  v_display_name := coalesce(
    nullif(btrim(left(new.raw_user_meta_data ->> 'display_name', 40)), ''),
    nullif(btrim(left(new.raw_user_meta_data ->> 'full_name', 40)), ''),
    nullif(btrim(left(new.raw_user_meta_data ->> 'name', 40)), ''),
    case when v_provider = 'guest' then 'Guest Viewer' else 'KBbox Member' end
  );
  v_avatar_seed := coalesce(new.raw_user_meta_data ->> 'avatar_seed', v_display_name);

  insert into public.profiles (user_id, display_name, avatar_seed, provider, public_code)
  values (new.id, v_display_name, v_avatar_seed, v_provider, private.new_public_code())
  on conflict (user_id) do nothing;

  insert into public.wallets (user_id, balance)
  values (
    new.id,
    case when new.is_anonymous
      then private.config_int('starting_coins_guest', 50)
      else private.config_int('starting_coins_member', 150)
    end
  )
  on conflict (user_id) do nothing;

  insert into public.subscriptions (user_id, is_active)
  values (new.id, false)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- Existing rows: the old default names, and phone/Google users recorded as 'email'.
update public.profiles set display_name = 'KBbox Member' where display_name = 'Keybox Member';
update public.profiles set display_name = 'KBbox Admin' where display_name = 'Keybox Admin';
update public.profiles p
set provider = u.raw_app_meta_data ->> 'provider'
from auth.users u
where u.id = p.user_id
  and not u.is_anonymous
  and p.provider = 'email'
  and u.raw_app_meta_data ->> 'provider' in ('phone', 'google', 'apple');

alter table public.profiles
  add constraint profiles_display_name_length check (char_length(btrim(display_name)) between 1 and 40);
