-- Public storage bucket for episode video files. Public buckets serve
-- objects at a public URL (/storage/v1/object/public/...) that bypasses RLS
-- for reads, so no explicit "public can read" policy is needed here.
-- No insert/update/delete policy is added for anon/authenticated, so
-- uploads are denied by default for regular clients — new episodes are
-- uploaded via scripts/add-episode.js using the service role key, which
-- bypasses RLS entirely (see DramaRush-Backend/README.md "Adding content").
insert into storage.buckets (id, name, public)
values ('episode-videos', 'episode-videos', true)
on conflict (id) do nothing;
