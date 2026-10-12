-- Picture size of each episode's video, so the app can letterbox landscape
-- videos (and offer a rotated full-screen view) instead of cropping them, and
-- the admin console can flag landscape uploads.
--
-- Written by stream-webhook from Cloudflare's `input.width/height` when a
-- video becomes ready; existing videos are backfilled with
-- scripts/backfill-video-dimensions.js.
--
-- episodes.video_width/height are readable like every other published
-- episode column (table-level select + the existing published/admin RLS);
-- only admins can write episodes (RLS from 20260803000002_admin_role.sql).

alter table public.video_assets
  add column width integer check (width is null or width between 1 and 16384),
  add column height integer check (height is null or height between 1 and 16384);

alter table public.episodes
  add column video_width integer check (video_width is null or video_width between 1 and 16384),
  add column video_height integer check (video_height is null or video_height between 1 and 16384);

comment on column public.episodes.video_width is 'Width in pixels of the current video (from Cloudflare). width > height = landscape.';
comment on column public.episodes.video_height is 'Height in pixels of the current video (from Cloudflare).';
