// Fill in the picture size (video_assets.width/height and
// episodes.video_width/height) for ready videos that predate
// 20261012120000_video_dimensions.sql. New videos get it from stream-webhook.
//
//   npm run backfill-video-dimensions [-- --dry-run]
//
// Reads each video's `input.width/height` from the Cloudflare Stream API.
// Safe to re-run: only rows still missing a size are touched.
import { parseArgs, serviceClient, sleep, streamConfig } from './lib.js';
import { videoDimensions } from '../supabase/functions/_shared/video-dimensions.ts';

const args = parseArgs(process.argv.slice(2));
const db = serviceClient();
const cfg = streamConfig();

const { data: assets, error } = await db
  .from('video_assets')
  .select('id, episode_id, provider_uid')
  .eq('status', 'ready')
  .is('width', null);
if (error) throw error;
console.log(`${assets.length} ready video(s) without a picture size`);

let updated = 0;
for (const asset of assets) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/stream/${asset.provider_uid}`, {
    headers: { Authorization: `Bearer ${cfg.apiToken}` },
  });
  const payload = await res.json().catch(() => ({}));
  const size = res.ok ? videoDimensions(payload.result) : null;
  if (!size) {
    console.warn(`  ${asset.episode_id}: no size from Cloudflare (HTTP ${res.status})`);
    continue;
  }
  console.log(`  ${asset.episode_id}: ${size.width}x${size.height}`);
  if (!args['dry-run']) {
    const a = await db.from('video_assets').update({ width: size.width, height: size.height }).eq('id', asset.id);
    if (a.error) throw a.error;
    const e = await db.from('episodes').update({ video_width: size.width, video_height: size.height }).eq('id', asset.episode_id);
    if (e.error) throw e.error;
    updated++;
  }
  await sleep(100); // stay well under the Cloudflare API rate limit
}
console.log(args['dry-run'] ? 'dry run: nothing written' : `updated ${updated} video(s)`);
