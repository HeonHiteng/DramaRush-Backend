import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

const REQUIRED = ['series', 'number', 'title', 'file', 'duration', 'access'];
const VALID_ACCESS = ['free', 'coin', 'subscriber', 'ad_unlock'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  for (const key of REQUIRED) {
    if (!args[key]) {
      console.error(`Missing required --${key}`);
      console.error(
        'Usage: npm run add-episode -- --series <id> --number <n> --title "<title>" ' +
          '--file <path> --duration <seconds> --access <free|coin|subscriber|ad_unlock> [--coin-price <n>] [--id <episode-id>]'
      );
      process.exit(1);
    }
  }
  if (!VALID_ACCESS.includes(args.access)) {
    console.error(`--access must be one of: ${VALID_ACCESS.join(', ')}`);
    process.exit(1);
  }
  if (args.access === 'coin' && !args['coin-price']) {
    console.error('--coin-price is required when --access coin');
    process.exit(1);
  }
  if (!existsSync(args.file)) {
    console.error(`File not found: ${args.file}`);
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in scripts/.env (see scripts/.env.example).');
    process.exit(1);
  }

  // Service role key bypasses RLS entirely — this must never be shipped in
  // the app or committed; it only ever lives in scripts/.env (gitignored).
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const seriesId = args.series;
  const number = Number(args.number);
  const episodeId = args.id || `${seriesId}-ep${number}`;
  const ext = extname(args.file) || '.mp4';
  const storagePath = `${seriesId}/ep${number}${ext}`;

  console.log(`Uploading ${args.file} -> episode-videos/${storagePath} ...`);
  const fileBuffer = readFileSync(args.file);
  const { error: uploadError } = await supabase.storage
    .from('episode-videos')
    .upload(storagePath, fileBuffer, { contentType: 'video/mp4', upsert: true });
  if (uploadError) {
    console.error('Upload failed:', uploadError.message);
    process.exit(1);
  }

  const { data: publicUrlData } = supabase.storage.from('episode-videos').getPublicUrl(storagePath);
  const videoUri = publicUrlData.publicUrl;
  console.log(`Uploaded. Public URL: ${videoUri}`);

  console.log(`Upserting episodes row ${episodeId} ...`);
  const { error: dbError } = await supabase.from('episodes').upsert(
    {
      id: episodeId,
      series_id: seriesId,
      number,
      title: args.title,
      duration_sec: Number(args.duration),
      video_uri: videoUri,
      access: args.access,
      coin_price: args.access === 'coin' ? Number(args['coin-price']) : null,
    },
    { onConflict: 'id' }
  );
  if (dbError) {
    console.error('Database upsert failed:', dbError.message);
    process.exit(1);
  }

  console.log(`Done. Episode "${args.title}" (${episodeId}) is live.`);
}

main();
