// Bulk-upload a whole series' episode videos to Cloudflare Stream.
//
//   npm run upload-series -- --series crimson-contract --dir "D:/videos/crimson" \
//     --access "1-3:free,4-5:ad_unlock,6-:coin:20" [--publish] [--replace]
//
// The folder holds one file per episode, numbered by name: ep01.mp4, ep2.mov,
// 003.mp4 ... For each file this script
//   1. creates or updates the episodes row (<series>-ep<N>; new rows start
//      unpublished, video_uri empty — no public URL is ever stored),
//   2. creates a one-time resumable upload on Cloudflare (signed URLs
//      required, Keybox watermark if STREAM_WATERMARK_UID is set),
//   3. records the pending video in video_assets and uploads the file.
// Cloudflare then calls the stream-webhook function, which marks it ready.
//
// --access   rules for NEW episodes and for changing existing ones:
//            "<from>-<to>:<free|ad_unlock|subscriber|coin[:price]>", first match wins;
//            "6-" means 6 and up. Existing episodes keep their access if no rule matches.
// --publish  after uploading, wait for Cloudflare to finish and publish the
//            episodes whose video is ready.
// --replace  upload even if the episode already has a ready video (the old
//            one is deleted automatically once the new one is ready).
//
// Progress is saved in <dir>/.keybox-upload-state.json, so re-running the
// same command resumes interrupted uploads instead of starting over.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, requireEnv, serviceClient, sleep, streamConfig } from './lib.js';
import { tusUpload } from './tus-upload.js';
import { createTusUpload } from '../supabase/functions/_shared/cloudflare-stream.ts';

const VIDEO_RE = /^(?:ep(?:isode)?[\s_-]*)?0*(\d{1,4})\.(mp4|mov|m4v|mkv|webm)$/i;
const STATE_FILE = '.keybox-upload-state.json';

function parseAccessRules(spec) {
  if (!spec) return [];
  return spec.split(',').map((part) => {
    const m = /^\s*(\d+)(?:-(\d*))?:(free|ad_unlock|subscriber|coin)(?::(\d+))?\s*$/.exec(part);
    if (!m) throw new Error(`Bad --access rule: "${part}"`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === '' ? Infinity : Number(m[2]);
    const access = m[3];
    const price = m[4] ? Number(m[4]) : null;
    if (access === 'coin' && !price) throw new Error(`Coin rule needs a price, e.g. "${from}-:coin:20"`);
    return { from, to, access, price };
  });
}

function ruleFor(rules, n) {
  return rules.find((r) => n >= r.from && n <= r.to) ?? null;
}

async function loadState(dir) {
  try {
    return JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function pct(sent, total) {
  return `${Math.floor((sent / total) * 100)}%`.padStart(4);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.series || !args.dir) {
    console.error('Usage: npm run upload-series -- --series <series-id> --dir <folder> [--access "1-3:free,4-:coin:20"] [--publish] [--replace]');
    process.exit(1);
  }
  const rules = parseAccessRules(args.access);
  const supabase = serviceClient();
  const cfg = streamConfig();
  const watermarkUid = process.env.STREAM_WATERMARK_UID || undefined;
  const allowedOrigins = (process.env.STREAM_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  requireEnv('SUPABASE_URL');

  const { data: series } = await supabase.from('series').select('id, title').eq('id', args.series).maybeSingle();
  if (!series) {
    console.error(`Series "${args.series}" doesn't exist. Create it first (admin UI or SQL insert into public.series).`);
    process.exit(1);
  }

  const files = (await readdir(args.dir))
    .map((name) => ({ name, m: VIDEO_RE.exec(name) }))
    .filter((f) => f.m)
    .map((f) => ({ name: f.name, number: Number(f.m[1]), path: join(args.dir, f.name) }))
    .sort((a, b) => a.number - b.number);
  if (files.length === 0) {
    console.error(`No episode files found in ${args.dir} (expected names like ep01.mp4).`);
    process.exit(1);
  }

  const state = await loadState(args.dir);
  const saveState = () => writeFile(join(args.dir, STATE_FILE), JSON.stringify(state, null, 2));
  const uploadedEpisodeIds = [];

  console.log(`Series: ${series.title} (${series.id}) — ${files.length} file(s)`);

  for (const file of files) {
    const episodeId = `${series.id}-ep${file.number}`;
    const label = `EP${String(file.number).padStart(3, '0')}`;

    // 1. episode row
    const { data: existing } = await supabase
      .from('episodes')
      .select('id, access, coin_price')
      .eq('id', episodeId)
      .maybeSingle();
    const rule = ruleFor(rules, file.number);
    if (!existing && !rule) {
      console.error(`${label}: new episode but no --access rule matches number ${file.number}. Skipped.`);
      continue;
    }
    if (!existing) {
      const { error } = await supabase.from('episodes').insert({
        id: episodeId,
        series_id: series.id,
        number: file.number,
        title: `Episode ${file.number}`,
        duration_sec: 0,
        video_uri: null,
        access: rule.access,
        coin_price: rule.access === 'coin' ? rule.price : null,
        published: false,
      });
      if (error) throw new Error(`${label}: could not create episode: ${error.message}`);
    } else if (rule) {
      const { error } = await supabase
        .from('episodes')
        .update({ access: rule.access, coin_price: rule.access === 'coin' ? rule.price : null })
        .eq('id', episodeId);
      if (error) throw new Error(`${label}: could not update access: ${error.message}`);
    }

    // 2. skip if already has a ready video (unless --replace) or was finished earlier
    const prev = state[file.name];
    if (prev?.done && !args.replace) {
      console.log(`${label}: already uploaded (${prev.uid}), skipping.`);
      uploadedEpisodeIds.push(episodeId);
      continue;
    }
    if (!args.replace && !prev) {
      const { count } = await supabase
        .from('video_assets')
        .select('id', { count: 'exact', head: true })
        .eq('episode_id', episodeId)
        .eq('status', 'ready');
      if (count > 0) {
        console.log(`${label}: already has a ready video, skipping (use --replace to re-upload).`);
        continue;
      }
    }

    // 3. upload (resume if we have a live upload URL from a previous run)
    const { size } = await stat(file.path);
    let entry = prev && !prev.done ? prev : null;
    for (let tries = 0; tries < 2; tries++) {
      if (!entry) {
        const { uploadUrl, uid } = await createTusUpload(cfg, {
          name: episodeId,
          fileSize: size,
          watermarkUid,
          allowedOrigins,
        });
        const { error } = await supabase
          .from('video_assets')
          .insert({ episode_id: episodeId, provider_uid: uid, status: 'pending_upload' });
        if (error) throw new Error(`${label}: could not record video: ${error.message}`);
        entry = { uid, uploadUrl, done: false };
        state[file.name] = entry;
        await saveState();
      }
      try {
        await tusUpload(entry.uploadUrl, file.path, (sent, total) => {
          process.stdout.write(`\r${label}: uploading ${pct(sent, total)} of ${(total / 1024 ** 2).toFixed(1)} MB`);
        });
        process.stdout.write('\n');
        entry.done = true;
        await saveState();
        uploadedEpisodeIds.push(episodeId);
        break;
      } catch (err) {
        process.stdout.write('\n');
        if (!err.expired) throw err;
        console.log(`${label}: previous upload link expired, starting a new upload.`);
        await supabase.from('video_assets').delete().eq('provider_uid', entry.uid).eq('status', 'pending_upload');
        entry = null;
      }
    }
  }

  console.log(`\nUploaded ${uploadedEpisodeIds.length} video(s). Cloudflare is processing them; the webhook marks each one ready.`);

  if (args.publish && uploadedEpisodeIds.length > 0) {
    console.log('Waiting for processing to finish before publishing (up to 30 minutes)...');
    const pending = new Set(uploadedEpisodeIds);
    const deadline = Date.now() + 30 * 60_000;
    while (pending.size > 0 && Date.now() < deadline) {
      const { data: ready } = await supabase
        .from('video_assets')
        .select('episode_id')
        .in('episode_id', [...pending])
        .eq('status', 'ready');
      const readyIds = [...new Set((ready ?? []).map((r) => r.episode_id))];
      if (readyIds.length > 0) {
        await supabase.from('episodes').update({ published: true }).in('id', readyIds);
        for (const id of readyIds) {
          pending.delete(id);
          console.log(`  published ${id}`);
        }
      }
      if (pending.size > 0) await sleep(15_000);
    }
    if (pending.size > 0) {
      console.log(`Still processing (not published yet): ${[...pending].join(', ')}. Re-run with --publish later.`);
    }
  }
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
