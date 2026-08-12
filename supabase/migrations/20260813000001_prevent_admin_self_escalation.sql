-- Closes a privilege-escalation hole in the admin_role migration: the
-- existing "users can update their own profile" RLS policy
-- (20260802000003_rls_policies.sql) is row-scoped, not column-scoped, so
-- any signed-in user — including a guest — could call
-- supabase.from('profiles').update({ is_admin: true }) from the browser
-- console and successfully grant themselves admin, since Postgres RLS has
-- no native concept of "this column is off-limits."
--
-- This trigger blocks changes to is_admin unless either:
--   (a) the caller is already an admin (so an admin UI can promote others
--       in the future), or
--   (b) the request isn't going through PostgREST at all — auth.uid() is
--       null for a SQL Editor / service-role session — which is the only
--       way to grant the very first admin.
create or replace function public.prevent_admin_self_escalation()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.is_admin is distinct from old.is_admin then
    if auth.uid() is not null and not coalesce(
      (select is_admin from public.profiles where user_id = auth.uid()), false
    ) then
      raise exception 'only an existing admin may change is_admin';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_admin_self_escalation
  before update on public.profiles
  for each row execute function public.prevent_admin_self_escalation();
