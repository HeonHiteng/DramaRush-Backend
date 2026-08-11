import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

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

  if (!args.series || !args.file) {
    console.error('Missing required --series and/or --file');
    console.error('Usage: npm run add-poster -- --series <id> --file <path>');
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

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const seriesId = args.series;
  const ext = extname(args.file) || '.jpg';
  const storagePath = `${seriesId}${ext}`;

  console.log(`Uploading ${args.file} -> series-posters/${storagePath} ...`);
  const fileBuffer = readFileSync(args.file);
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const { error: uploadError } = await supabase.storage
    .from('series-posters')
    .upload(storagePath, fileBuffer, { contentType, upsert: true });
  if (uploadError) {
    console.error('Upload failed:', uploadError.message);
    process.exit(1);
  }

  const { data: publicUrlData } = supabase.storage.from('series-posters').getPublicUrl(storagePath);
  const posterUri = publicUrlData.publicUrl;
  console.log(`Uploaded. Public URL: ${posterUri}`);

  console.log(`Updating series ${seriesId} ...`);
  const { error: dbError } = await supabase
    .from('series')
    .update({ poster_image_uri: posterUri })
    .eq('id', seriesId);
  if (dbError) {
    console.error('Database update failed:', dbError.message);
    process.exit(1);
  }

  console.log(`Done. ${seriesId} now uses this poster.`);
}

main();
