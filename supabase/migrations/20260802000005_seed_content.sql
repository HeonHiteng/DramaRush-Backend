-- Auto-generated from the DramaRush app's src/data/seriesData.ts mock content.
-- Safe to re-run: uses ON CONFLICT DO NOTHING so it will not duplicate rows.

-- Series
insert into public.series
  (id, title, synopsis, genres, rating, status, language, poster_color_from, poster_color_to, banner_color_from, banner_color_to, cast_members, popularity, is_new)
values
  ('crimson-contract', 'Crimson Contract', 'Presumed dead after a car crash orchestrated by her fiancé''s family, Wren Hale resurfaces under a new name — and a seat on the board of the company that tried to erase her.', ARRAY['Revenge', 'Suspense']::text[], 4.8, 'ongoing', 'English', '#3A1420', '#7A1F2B', '#4A0F1A', '#8C2233', '[{"name":"Elena Marsh","role":"Wren Hale"},{"name":"Damon Reyes","role":"Julian Cross"},{"name":"Priya Anand","role":"Detective Kim"}]'::jsonb, 98, false),
  ('heir-to-nowhere', 'Heir to Nowhere', 'To prove he can earn it, the secret heir of Callahan Group clocks in as the newest intern — and falls hard for the assistant tasked with keeping the office running.', ARRAY['Romance', 'Workplace']::text[], 4.6, 'ongoing', 'English', '#1B2033', '#2E3A66', '#141A2E', '#3A4A8C', '[{"name":"Noah Bright","role":"Theo Callahan"},{"name":"Marisol Vega","role":"Ines Duarte"},{"name":"Kenji Osei","role":"Marcus Wren"}]'::jsonb, 91, true),
  ('midnight-ledger', 'Midnight Ledger', 'A forensic accountant finds her missing sister''s handwriting in a set of falsified books — and every entry pulls her closer to the people who want the ledger burned.', ARRAY['Mystery', 'Suspense']::text[], 4.7, 'ongoing', 'English', '#141A1C', '#204045', '#0F1517', '#2A5A61', '[{"name":"Sofia Lindqvist","role":"Ada Reyes"},{"name":"Malik Fontaine","role":"Detective Osei"},{"name":"Grace Tanaka","role":"Ren Reyes (missing)"}]'::jsonb, 87, false),
  ('paper-moon-diner', 'Paper Moon Diner', 'Between burnt pancakes and a betting pool on who''ll confess first, the graveyard-shift crew of a small-town diner turns every night shift into a small disaster.', ARRAY['Comedy', 'Romance']::text[], 4.5, 'completed', 'English', '#2B1B10', '#7A4A1E', '#20140B', '#9C5E22', '[{"name":"Ruby Solano","role":"Jo Alvarez"},{"name":"Tobin Reid","role":"Cash Bennett"},{"name":"Amara Okafor","role":"Deja Price"}]'::jsonb, 76, false),
  ('ever-after-glitch', 'Ever After Glitch', 'Pulled into a malfunctioning fairy-tale simulation, Iris has three in-game days to break the loop — before the story decides to write her out for good.', ARRAY['Fantasy', 'Romance']::text[], 4.9, 'ongoing', 'English', '#1E1330', '#5A2E8C', '#160D26', '#7B3FB8', '[{"name":"Iris Okonkwo","role":"Iris Vance"},{"name":"Felix Aro","role":"Prince Corvin (NPC)"},{"name":"Nadia Petrov","role":"The Narrator"}]'::jsonb, 95, true),
  ('varsity-hearts', 'Varsity Hearts', 'Two rival campus idol groups are forced to co-produce the spring showcase — and discover harmony sounds a lot like falling for the competition.', ARRAY['Youth', 'Romance']::text[], 4.4, 'ongoing', 'Korean', '#0F1E2B', '#1C6E8C', '#0B1620', '#2A8FB0', '[{"name":"Yuna Park","role":"Seo-yeon"},{"name":"Jin Baek","role":"Do-hyun"},{"name":"Mina Cho","role":"Coach Yoon"}]'::jsonb, 83, true),
  ('understudys-revenge', 'The Understudy''s Revenge', 'Fired and blacklisted on false claims, a rising producer rebuilds under an alias — and lands the one deal that can expose the boss who ended her career.', ARRAY['Revenge', 'Workplace']::text[], 4.6, 'completed', 'English', '#241017', '#5E1E2E', '#1A0B10', '#7A2439', '[{"name":"Camille Dorsey","role":"Nora Vance"},{"name":"Owen Marsh","role":"Bradley Kane"},{"name":"Layla Haddad","role":"Priya Suresh"}]'::jsonb, 88, false),
  ('static-bloom', 'Static Bloom', 'Every Tuesday, a florist receives a bouquet addressed from herself — postmarked from a timeline where she made every choice differently.', ARRAY['Mystery', 'Fantasy']::text[], 4.7, 'ongoing', 'Portuguese', '#101F16', '#2E6B45', '#0B1710', '#3E8C58', '[{"name":"Bianca Souza","role":"Alma Ferreira"},{"name":"Rafael Nunes","role":"Theo Duarte"},{"name":"Isadora Melo","role":"Alma (Other Timeline)"}]'::jsonb, 79, false)
on conflict (id) do nothing;

-- Episodes
insert into public.episodes
  (id, series_id, number, title, duration_sec, video_uri, access, coin_price)
values
  ('crimson-contract-ep1', 'crimson-contract', 1, 'The Crash That Wasn''t', 612, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'free', null),
  ('crimson-contract-ep2', 'crimson-contract', 2, 'A Name Not My Own', 588, 'https://www.w3schools.com/html/mov_bbb.mp4', 'free', null),
  ('crimson-contract-ep3', 'crimson-contract', 3, 'Boardroom Ghost', 634, 'https://www.w3schools.com/html/movie.mp4', 'ad_unlock', null),
  ('crimson-contract-ep4', 'crimson-contract', 4, 'The First Domino', 601, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'coin', 20),
  ('crimson-contract-ep5', 'crimson-contract', 5, 'Old Enemies, New Faces', 655, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'coin', 20),
  ('crimson-contract-ep6', 'crimson-contract', 6, 'A Toast to Ruin', 590, 'https://www.w3schools.com/html/mov_bbb.mp4', 'coin', 25),
  ('crimson-contract-ep7', 'crimson-contract', 7, 'The Ledger Opens', 641, 'https://www.w3schools.com/html/movie.mp4', 'subscriber', null),
  ('crimson-contract-ep8', 'crimson-contract', 8, 'Checkmate in Heels', 677, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'subscriber', null),
  ('heir-to-nowhere-ep1', 'heir-to-nowhere', 1, 'Badge 214', 560, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'free', null),
  ('heir-to-nowhere-ep2', 'heir-to-nowhere', 2, 'Coffee Run', 545, 'https://www.w3schools.com/html/mov_bbb.mp4', 'free', null),
  ('heir-to-nowhere-ep3', 'heir-to-nowhere', 3, 'The Wrong Elevator', 572, 'https://www.w3schools.com/html/movie.mp4', 'free', null),
  ('heir-to-nowhere-ep4', 'heir-to-nowhere', 4, 'Overtime', 598, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'ad_unlock', null),
  ('heir-to-nowhere-ep5', 'heir-to-nowhere', 5, 'Company Retreat', 610, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'coin', 15),
  ('heir-to-nowhere-ep6', 'heir-to-nowhere', 6, 'Under His Signature', 583, 'https://www.w3schools.com/html/mov_bbb.mp4', 'coin', 15),
  ('midnight-ledger-ep1', 'midnight-ledger', 1, 'Row 47', 605, 'https://www.w3schools.com/html/movie.mp4', 'free', null),
  ('midnight-ledger-ep2', 'midnight-ledger', 2, 'Her Handwriting', 590, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'free', null),
  ('midnight-ledger-ep3', 'midnight-ledger', 3, 'The Numbers Lie', 622, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'coin', 18),
  ('midnight-ledger-ep4', 'midnight-ledger', 4, 'A Warning in Red Ink', 599, 'https://www.w3schools.com/html/mov_bbb.mp4', 'coin', 18),
  ('midnight-ledger-ep5', 'midnight-ledger', 5, 'Whoever Signs Last', 615, 'https://www.w3schools.com/html/movie.mp4', 'ad_unlock', null),
  ('midnight-ledger-ep6', 'midnight-ledger', 6, 'The Second Ledger', 648, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'subscriber', null),
  ('midnight-ledger-ep7', 'midnight-ledger', 7, 'Ren''s Room', 660, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'subscriber', null),
  ('paper-moon-diner-ep1', 'paper-moon-diner', 1, 'Order Up', 520, 'https://www.w3schools.com/html/mov_bbb.mp4', 'free', null),
  ('paper-moon-diner-ep2', 'paper-moon-diner', 2, 'The Betting Pool', 505, 'https://www.w3schools.com/html/movie.mp4', 'free', null),
  ('paper-moon-diner-ep3', 'paper-moon-diner', 3, 'Burnt Pancakes', 512, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'free', null),
  ('paper-moon-diner-ep4', 'paper-moon-diner', 4, 'Closing Shift', 530, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'free', null),
  ('paper-moon-diner-ep5', 'paper-moon-diner', 5, 'Jukebox Confession', 540, 'https://www.w3schools.com/html/mov_bbb.mp4', 'ad_unlock', null),
  ('paper-moon-diner-ep6', 'paper-moon-diner', 6, 'The Last Booth', 555, 'https://www.w3schools.com/html/movie.mp4', 'coin', 12),
  ('ever-after-glitch-ep1', 'ever-after-glitch', 1, 'Loading Happily Ever After', 598, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'free', null),
  ('ever-after-glitch-ep2', 'ever-after-glitch', 2, 'A Prince With a Bug', 605, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'free', null),
  ('ever-after-glitch-ep3', 'ever-after-glitch', 3, 'Save File Corrupted', 611, 'https://www.w3schools.com/html/mov_bbb.mp4', 'coin', 20),
  ('ever-after-glitch-ep4', 'ever-after-glitch', 4, 'The Narrator Notices', 597, 'https://www.w3schools.com/html/movie.mp4', 'coin', 20),
  ('ever-after-glitch-ep5', 'ever-after-glitch', 5, 'Glass Slipper, Cracked', 620, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'ad_unlock', null),
  ('ever-after-glitch-ep6', 'ever-after-glitch', 6, 'Rewriting the Ending', 635, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'subscriber', null),
  ('ever-after-glitch-ep7', 'ever-after-glitch', 7, 'Day Three', 642, 'https://www.w3schools.com/html/mov_bbb.mp4', 'subscriber', null),
  ('ever-after-glitch-ep8', 'ever-after-glitch', 8, 'Ever After, Actually', 650, 'https://www.w3schools.com/html/movie.mp4', 'subscriber', null),
  ('varsity-hearts-ep1', 'varsity-hearts', 1, 'Audition Chaos', 540, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'free', null),
  ('varsity-hearts-ep2', 'varsity-hearts', 2, 'Rival Practice Rooms', 555, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'free', null),
  ('varsity-hearts-ep3', 'varsity-hearts', 3, 'Shared Playlist', 560, 'https://www.w3schools.com/html/mov_bbb.mp4', 'ad_unlock', null),
  ('varsity-hearts-ep4', 'varsity-hearts', 4, 'Duet Assignment', 572, 'https://www.w3schools.com/html/movie.mp4', 'coin', 15),
  ('varsity-hearts-ep5', 'varsity-hearts', 5, 'Backstage Nerves', 566, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'coin', 15),
  ('varsity-hearts-ep6', 'varsity-hearts', 6, 'Encore', 580, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'coin', 18),
  ('understudys-revenge-ep1', 'understudys-revenge', 1, 'The Termination Letter', 600, 'https://www.w3schools.com/html/mov_bbb.mp4', 'free', null),
  ('understudys-revenge-ep2', 'understudys-revenge', 2, 'A New Name Badge', 590, 'https://www.w3schools.com/html/movie.mp4', 'free', null),
  ('understudys-revenge-ep3', 'understudys-revenge', 3, 'The Pitch Meeting', 610, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'coin', 18),
  ('understudys-revenge-ep4', 'understudys-revenge', 4, 'Friends in Low Places', 605, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'coin', 18),
  ('understudys-revenge-ep5', 'understudys-revenge', 5, 'Paper Trail', 615, 'https://www.w3schools.com/html/mov_bbb.mp4', 'ad_unlock', null),
  ('understudys-revenge-ep6', 'understudys-revenge', 6, 'The Real Signature', 620, 'https://www.w3schools.com/html/movie.mp4', 'coin', 22),
  ('understudys-revenge-ep7', 'understudys-revenge', 7, 'Reinstated', 630, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'coin', 22),
  ('static-bloom-ep1', 'static-bloom', 1, 'The First Bouquet', 570, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'free', null),
  ('static-bloom-ep2', 'static-bloom', 2, 'A Return Address', 585, 'https://www.w3schools.com/html/mov_bbb.mp4', 'free', null),
  ('static-bloom-ep3', 'static-bloom', 3, 'The Other Alma', 600, 'https://www.w3schools.com/html/movie.mp4', 'coin', 16),
  ('static-bloom-ep4', 'static-bloom', 4, 'What She Didn''t Choose', 595, 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', 'ad_unlock', null),
  ('static-bloom-ep5', 'static-bloom', 5, 'Wilted Warning', 610, 'https://storage.googleapis.com/exoplayer-test-media-0/BigBuckBunny_320x180.mp4', 'coin', 16),
  ('static-bloom-ep6', 'static-bloom', 6, 'Cross-Pollination', 625, 'https://www.w3schools.com/html/mov_bbb.mp4', 'subscriber', null)
on conflict (id) do nothing;
