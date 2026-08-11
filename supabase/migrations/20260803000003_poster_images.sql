-- Optional real poster image per series. Nullable — when absent, the app
-- falls back to its gradient + icon-motif poster treatment (see the app
-- repo's src/components/media/PosterArt.tsx).
alter table public.series
  add column poster_image_uri text;

-- Public storage bucket for poster image files, same pattern as
-- episode-videos (20260803000001_video_storage.sql): public reads via the
-- bucket's public flag, writes denied by default except for admins
-- (20260803000002_admin_role.sql's is_admin()-gated policies below).
insert into storage.buckets (id, name, public)
values ('series-posters', 'series-posters', true)
on conflict (id) do nothing;

create policy "admins can upload series posters"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'series-posters' and public.is_admin());

create policy "admins can update series posters"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'series-posters' and public.is_admin())
  with check (bucket_id = 'series-posters' and public.is_admin());

create policy "admins can delete series posters"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'series-posters' and public.is_admin());
