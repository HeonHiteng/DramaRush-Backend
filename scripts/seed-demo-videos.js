// Attach a demo video to every published episode that has none, so the app
// team can integrate playback before real footage exists.
//
//   npm run seed-demo-videos [-- --url https://example.com/clip.mp4] [-- --series crimson-contract] [-- --dry-run]
//
// Cloudflare copies the clip from --url (default: a 10-second public sample),
// with signed URLs required and the Keybox watermark if STREAM_WATERMARK_UID
// is set — exactly like real uploads, so playback goes through
// playback-token and stream-webhook marks each video ready. Safe to re-run:
// episodes that already have a pending/ready video are skipped.
//
// Cost: storage is billed per minute stored (10 s × 54 episodes ≈ 9 minutes).
// Remove them later with admin-video-delete, or by re-uploading real videos
// (a new ready video replaces the old one automatically).
import { parseArgs, serviceClient, sleep, streamConfig } from './lib.js';

const DEFAULT_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';

async function copyFromUrl(cfg, url, name, watermarkUid) {
  const body = { url, requireSignedURLs: true, meta: { name } };
  if (watermarkUid) body.watermark = { uid: watermarkUid };
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/stream/copy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.success || !/^[0-9a-f]{32}$/.test(payload.result?.uid ?? '')) {
    throw new Error(`copy failed: HTTP ${res.status} ${(payload.errors ?? []).map((e) => e.message).join('; ')}`);
  }
  return payload.result.uid;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = typeof args.url === 'string' ? args.url : DEFAULT_URL;
  const supabase = serviceClient();
  const cfg = streamConfig();
  const watermarkUid = process.env.STREAM_WATERMARK_UID || undefined;

  let query = supabase.from('episodes').select('id').eq('published', true).order('id');
  if (typeof args.series === 'string') query = query.eq('series_id', args.series);
  const { data: episodes, error } = await query;
  if (error) throw new Error(error.message);

  const { data: existing } = await supabase.from('video_assets').select('episode_id').in('status', ['pending_upload', 'processing', 'ready']);
  const has = new Set((existing ?? []).map((r) => r.episode_id));
  const todo = episodes.filter((e) => !has.has(e.id));

  console.log(`${episodes.length} published episode(s), ${todo.length} without a video. Source: ${url}`);
  if (args['dry-run']) {
    todo.forEach((e) => console.log(`  would attach: ${e.id}`));
    return;
  }

  const uids = [];
  for (const ep of todo) {
    const uid = await copyFromUrl(cfg, url, ep.id, watermarkUid);
    const { error: insErr } = await supabase.from('video_assets').insert({ episode_id: ep.id, provider_uid: uid, status: 'pending_upload' });
    if (insErr) throw new Error(`${ep.id}: ${insErr.message}`);
    uids.push(uid);
    console.log(`  ${ep.id} -> ${uid}`);
    await sleep(250); // stay well under Cloudflare's API rate limit
  }
  if (uids.length === 0) return;

  console.log('Waiting for Cloudflare to process them (the webhook marks each ready)...');
  const deadline = Date.now() + 10 * 60_000;
  let ready = 0;
  while (Date.now() < deadline) {
    const { data } = await supabase.from('video_assets').select('status').in('provider_uid', uids);
    ready = (data ?? []).filter((r) => r.status === 'ready').length;
    const failed = (data ?? []).filter((r) => r.status === 'error').length;
    process.stdout.write(`\r  ready ${ready}/${uids.length}${failed ? `, failed ${failed}` : ''}   `);
    if (ready + failed === uids.length) break;
    await sleep(5000);
  }
  process.stdout.write('\n');
  console.log(ready === uids.length ? 'Done: every episode now has a playable demo video.' : 'Some videos are still processing; re-check video_assets later.');
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
