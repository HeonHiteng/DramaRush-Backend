-- Admin role for the in-app content admin UI. Lets a small set of
-- non-technical users create/edit series and episodes (including uploading
-- video files) directly from the app, instead of needing the service role
-- key + add-episode.js script.

alter table public.profiles
  add column is_admin boolean not null default false;

-- Reads the caller's own is_admin flag under their own RLS-permitted read
-- (see "users can read their own profile" in 20260802000003_rls_policies.sql)
-- — deliberately not security definer, since no elevated privilege is needed.
create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where user_id = auth.uid()), false);
$$;

-- series / episodes: previously public-read-only with no write policy at
-- all (service role only). Add admin-gated writes for the new admin UI.
create policy "admins can insert series"
  on public.series for insert
  to authenticated
  with check (public.is_admin());

create policy "admins can update series"
  on public.series for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "admins can delete series"
  on public.series for delete
  to authenticated
  using (public.is_admin());

create policy "admins can insert episodes"
  on public.episodes for insert
  to authenticated
  with check (public.is_admin());

create policy "admins can update episodes"
  on public.episodes for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "admins can delete episodes"
  on public.episodes for delete
  to authenticated
  using (public.is_admin());

-- episode-videos storage bucket: RLS is already enabled on storage.objects
-- by Supabase itself. Public reads already work via the bucket's public
-- flag (20260803000001_video_storage.sql); add admin-gated writes here so
-- the admin UI can upload directly from the browser with the user's own
-- session instead of the service role key.
create policy "admins can upload episode videos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'episode-videos' and public.is_admin());

create policy "admins can update episode videos"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'episode-videos' and public.is_admin())
  with check (bucket_id = 'episode-videos' and public.is_admin());

create policy "admins can delete episode videos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'episode-videos' and public.is_admin());
