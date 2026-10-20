// Live end-to-end test against the deployed keybox project. Run: npm run test:e2e
// Needs scripts/.env and scripts/.secrets/function-secrets.env. Creates temporary users and
// videos (10s public sample clip) and removes them at the end.
const e = process.env;
const SB = e.SUPABASE_URL;
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWFnYXVvZ3J6ZXpmbXZlZXdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1NTQ3NDAsImV4cCI6MjEwNzEzMDc0MH0.xR9IePiD3ipknNKg3zurQgCfpk9_cNwo8jls_F_YPbY';
const SVC = { apikey: e.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
const CF = `https://api.cloudflare.com/client/v4/accounts/${e.CLOUDFLARE_ACCOUNT_ID}/stream`;
const CFH = { Authorization: `Bearer ${e.CLOUDFLARE_STREAM_API_TOKEN}` };
const SAMPLE = 'https://www.w3schools.com/html/mov_bbb.mp4';
const EP_FREE = 'crimson-contract-ep1', EP_COIN = 'crimson-contract-ep4';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const rest = (path, opts = {}) => call(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...SVC, Prefer: 'return=representation', ...(opts.headers ?? {}) } });
const fn = (name, jwt, body) => call(`${SB}/functions/v1/${name}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const rpcAs = (jwt, name, args = {}) => call(`${SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });

const created = { users: [], episodesTouched: {} };
let adminJwt, guestJwt, guestId, memberJwt, memberId;
const signUpGuest = () => call(`${SB}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { provider: 'guest' } }) });

async function waitForAsset(uid, label) {
  for (let i = 0; i < 60; i++) {
    const { body } = await rest(`video_assets?provider_uid=eq.${uid}&select=status,duration_sec,error_reason`);
    const row = body?.[0];
    if (row?.status === 'ready' || row?.status === 'error') return row;
    await sleep(3000);
  }
  return { status: 'timeout' };
}

async function uploadVia(jwt, episodeId, bytes) {
  const up = await fn('admin-video-upload', jwt, { episode_id: episodeId, file_size: bytes.length, file_name: 'sample.mp4' });
  if (up.status !== 200) return { up };
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'sample.mp4');
  const put = await call(up.body.upload_url, { method: 'POST', body: form });
  return { up, put };
}

try {
  // ---------------------------------------------------------------- setup
  const settings = await call(`${SB}/auth/v1/settings`, { headers: { apikey: ANON } });
  check('anonymous sign-in enabled', settings.body?.external?.anonymous_users === true);

  for (const id of [EP_FREE, EP_COIN]) {
    const { body } = await rest(`episodes?id=eq.${id}&select=duration_sec`);
    created.episodesTouched[id] = body[0].duration_sec;
  }
  const cfgBefore = (await rest('app_config?key=eq.playback_max_tokens_per_10min&select=value')).body[0].value;

  // The library is not empty (demo videos, npm run seed-demo-videos). Uploads below replace the
  // existing videos of EP_FREE / EP_COIN (the webhook deletes the older ones), so at the end the
  // library should hold what it held now minus those.
  const cfCount = async () => {
    const r = await call(`${CF}?limit=1000`, { headers: CFH });
    return Array.isArray(r.body?.result) ? r.body.result.length : NaN;
  };
  const libraryBefore = await cfCount();
  const replacedVideos = (await rest(`video_assets?episode_id=in.(${EP_FREE},${EP_COIN})&select=provider_uid`)).body.length;
  // A published free episode with no video at all, for the 404 check (null if every one has a video).
  const withVideo = new Set((await rest('video_assets?select=episode_id')).body.map((r) => r.episode_id));
  const epNoVideo = (await rest('episodes?access=eq.free&published=eq.true&select=id')).body.map((r) => r.id).find((id) => id !== EP_FREE && !withVideo.has(id)) ?? null;

  const email = `e2e-admin-${Date.now()}@keybox.invalid`;
  const password = crypto.randomUUID() + 'Aa1!';
  const adminUser = await call(`${SB}/auth/v1/admin/users`, { method: 'POST', headers: SVC, body: JSON.stringify({ email, password, email_confirm: true }) });
  check('create temporary admin (service role)', adminUser.status === 200, `HTTP ${adminUser.status}`);
  created.users.push(adminUser.body.id);
  await rest(`profiles?user_id=eq.${adminUser.body.id}`, { method: 'PATCH', body: JSON.stringify({ is_admin: true }) });
  const login = await call(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  adminJwt = login.body.access_token;
  check('admin password sign-in', !!adminJwt, `HTTP ${login.status}`);

  const guest = await signUpGuest();
  guestJwt = guest.body.access_token; guestId = guest.body.user?.id;
  check('guest (anonymous) sign-in', !!guestJwt && guest.body.user?.is_anonymous === true, `HTTP ${guest.status}`);
  if (guestId) created.users.push(guestId);
  const wallet = await call(`${SB}/rest/v1/wallets?select=balance`, { headers: { apikey: ANON, Authorization: `Bearer ${guestJwt}` } });
  check('guest starts with 0 coins', wallet.body?.[0]?.balance === 0, JSON.stringify(wallet.body));

  // A real (email) account: GoTrue writes its email identity, which pays the welcome bonus.
  const memberEmail = `e2e-member-${Date.now()}@keybox.invalid`;
  const memberUser = await call(`${SB}/auth/v1/admin/users`, { method: 'POST', headers: SVC, body: JSON.stringify({ email: memberEmail, password, email_confirm: true }) });
  check('create temporary member (service role)', memberUser.status === 200, `HTTP ${memberUser.status}`);
  memberId = memberUser.body.id;
  if (memberId) created.users.push(memberId);
  const memberLogin = await call(`${SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password }) });
  memberJwt = memberLogin.body.access_token;
  check('member password sign-in', !!memberJwt, `HTTP ${memberLogin.status}`);
  const memberWallet = await call(`${SB}/rest/v1/wallets?select=balance`, { headers: { apikey: ANON, Authorization: `Bearer ${memberJwt}` } });
  check('member gets the 150-coin welcome bonus once', memberWallet.body?.[0]?.balance === 150, JSON.stringify(memberWallet.body));

  // ---------------------------------------------------------------- upload
  const bytes = new Uint8Array(await (await fetch(SAMPLE)).arrayBuffer());
  console.log(`sample clip: ${(bytes.length / 1024).toFixed(0)} KB`);

  const notAdmin = await fn('admin-video-upload', guestJwt, { episode_id: EP_FREE, file_size: bytes.length });
  check('guest cannot request an upload URL', notAdmin.status === 403 && notAdmin.body.error === 'admin_only', `HTTP ${notAdmin.status} ${JSON.stringify(notAdmin.body)}`);

  const u1 = await uploadVia(adminJwt, EP_FREE, bytes);
  check('admin-video-upload returns a Cloudflare URL', u1.up.status === 200 && u1.up.body.mode === 'basic', `HTTP ${u1.up.status}`);
  check('file POST to Cloudflare', u1.put?.status === 200, `HTTP ${u1.put?.status}`);
  const u2 = await uploadVia(adminJwt, EP_COIN, bytes);
  check('second upload (coin episode)', u2.put?.status === 200);

  const r1 = await waitForAsset(u1.up.body.uid);
  const r2 = await waitForAsset(u2.up.body.uid);
  check('webhook marked free-episode video ready', r1.status === 'ready', JSON.stringify(r1));
  check('webhook marked coin-episode video ready', r2.status === 'ready', JSON.stringify(r2));
  const dur = (await rest(`episodes?id=eq.${EP_FREE}&select=duration_sec`)).body[0].duration_sec;
  check('episode duration filled from video', dur > 0 && dur < 60, `duration_sec=${dur}`);

  const cfVideo = await call(`${CF}/${u1.up.body.uid}`, { headers: CFH });
  check('Cloudflare video requires signed URLs', cfVideo.body?.result?.requireSignedURLs === true);

  // ---------------------------------------------------------------- playback
  const p1 = await fn('playback-token', guestJwt, { episode_id: EP_FREE });
  check('guest gets a preview token for a free episode', p1.status === 200 && !!p1.body.hls_url && p1.body.preview_seconds === 15, `HTTP ${p1.status} ${JSON.stringify(p1.body).slice(0, 120)}`);
  if (p1.status === 200) {
    check('watermark code returned', /^[2-9A-HJ-NP-Z]{7}$/.test(p1.body.watermark_code ?? ''), p1.body.watermark_code);
    const m = await call(p1.body.hls_url);
    check('HLS manifest plays with token', m.status === 200, `HTTP ${m.status}`);
    const ttl = (Date.parse(p1.body.expires_at) - Date.now()) / 1000;
    check('guest preview token expires in ~30 s', ttl > 15 && ttl <= 30, `${Math.round(ttl)}s`);
  }
  const pm = await fn('playback-token', memberJwt, { episode_id: EP_FREE });
  check('member gets a full token for a free episode', pm.status === 200 && !('preview_seconds' in pm.body), `HTTP ${pm.status} ${JSON.stringify(pm.body).slice(0, 120)}`);
  if (pm.status === 200) {
    const ttl = (Date.parse(pm.body.expires_at) - Date.now()) / 1000;
    check('member token expires in ~15 minutes', ttl > 840 && ttl <= 900, `${Math.round(ttl)}s`);
  }
  const bare = await call(`https://${e.CLOUDFLARE_STREAM_CUSTOMER_CODE}.cloudflarestream.com/${u1.up.body.uid}/manifest/video.m3u8`);
  check('video ID without token is refused', bare.status === 401, `HTTP ${bare.status}`);

  const pg4 = await fn('playback-token', guestJwt, { episode_id: EP_COIN });
  check('guest paid episode -> 403 account_required', pg4.status === 403 && pg4.body.error === 'account_required', `HTTP ${pg4.status} ${JSON.stringify(pg4.body)}`);
  const p4 = await fn('playback-token', memberJwt, { episode_id: EP_COIN });
  check('locked coin episode refused (403 not_entitled)', p4.status === 403 && p4.body.error === 'not_entitled', `HTTP ${p4.status} ${JSON.stringify(p4.body)}`);
  if (epNoVideo) {
    const p2 = await fn('playback-token', memberJwt, { episode_id: epNoVideo });
    check('episode without video -> 404 unavailable', p2.status === 404 && p2.body.error === 'unavailable', `HTTP ${p2.status} (${epNoVideo})`);
  } else {
    console.log('SKIP  episode without video -> 404 unavailable  — every published free episode has a video');
  }
  const noAuth = await fn('playback-token', ANON, { episode_id: EP_FREE });
  check('no session -> 401', noAuth.status === 401, `HTTP ${noAuth.status}`);

  const cheat = await call(`${SB}/rest/v1/wallets?user_id=eq.${guestId}`, { method: 'PATCH', headers: { apikey: ANON, Authorization: `Bearer ${guestJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ balance: 99999 }) });
  check('guest cannot edit own wallet', cheat.status === 401 || cheat.status === 403, `HTTP ${cheat.status}`);

  const guestUnlock = await rpcAs(guestJwt, 'unlock_episode_with_coins', { p_episode_id: EP_COIN });
  check('guest coin unlock -> account_required', guestUnlock.status >= 400 && guestUnlock.body?.message === 'account_required', `HTTP ${guestUnlock.status} ${JSON.stringify(guestUnlock.body)}`);
  const unlock = await rpcAs(memberJwt, 'unlock_episode_with_coins', { p_episode_id: EP_COIN });
  check('member unlocks coin episode with coins', unlock.body === true, JSON.stringify(unlock.body));
  const p4b = await fn('playback-token', memberJwt, { episode_id: EP_COIN });
  check('unlocked coin episode -> token', p4b.status === 200, `HTTP ${p4b.status}`);
  if (p4b.status === 200) check('coin episode manifest plays', (await call(p4b.body.hls_url)).status === 200);
  const peek = await call(`${SB}/rest/v1/video_assets?select=provider_uid`, { headers: { apikey: ANON, Authorization: `Bearer ${guestJwt}` } });
  check('guest cannot read video IDs', Array.isArray(peek.body) ? peek.body.length === 0 : peek.status >= 400, `HTTP ${peek.status} ${JSON.stringify(peek.body).slice(0, 80)}`);

  // ---------------------------------------------------------------- replacement upload
  const u3 = await uploadVia(adminJwt, EP_FREE, bytes);
  const r3 = await waitForAsset(u3.up.body.uid);
  check('replacement upload ready', r3.status === 'ready');
  await sleep(4000);
  const assets = (await rest(`video_assets?episode_id=eq.${EP_FREE}&select=provider_uid,status`)).body;
  check('old video row removed after replacement', assets.length === 1 && assets[0].provider_uid === u3.up.body.uid, JSON.stringify(assets));
  const oldCf = await call(`${CF}/${u1.up.body.uid}`, { headers: CFH });
  check('old video deleted from Cloudflare', oldCf.status === 404, `HTTP ${oldCf.status}`);

  // ---------------------------------------------------------------- rate limit
  const granted = (await rest(`playback_events?user_id=eq.${memberId}&decision=in.(granted,preview)&select=id`)).body.length;
  await rest('app_config?key=eq.playback_max_tokens_per_10min', { method: 'PATCH', body: JSON.stringify({ value: granted + 2 }) });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fn('playback-token', memberJwt, { episode_id: EP_FREE })).body.error ?? 'ok');
  check('rapid requests -> rate_limited then blocked', codes.join(',') === 'ok,ok,rate_limited,blocked', codes.join(','));
  const flags = (await rest(`abuse_flags?user_id=eq.${memberId}&select=reason,blocks_playback_until`)).body;
  check('abuse flag recorded', flags.length === 1 && flags[0].reason === 'playback_rate_limit');
  await rest('app_config?key=eq.playback_max_tokens_per_10min', { method: 'PATCH', body: JSON.stringify({ value: cfgBefore }) });

  // ---------------------------------------------------------------- webhook forgery
  const forged = await call(`${SB}/functions/v1/stream-webhook`, { method: 'POST', headers: { 'Webhook-Signature': `time=${Math.floor(Date.now() / 1000)},sig1=${'0'.repeat(64)}` }, body: JSON.stringify({ uid: u3.up.body.uid, status: { state: 'error' } }) });
  check('forged webhook rejected', forged.status === 401, `HTTP ${forged.status}`);

  // ---------------------------------------------------------------- delete account
  const doomed = await signUpGuest();
  const doomedJwt = doomed.body.access_token;
  if (doomed.body.user?.id) created.users.push(doomed.body.user.id);
  const gone = await fn('delete-account', doomedJwt, {});
  check('delete-account -> 200 deleted', gone.status === 200 && gone.body?.deleted === true, `HTTP ${gone.status} ${JSON.stringify(gone.body)}`);
  const afterDelete = await fn('playback-token', doomedJwt, { episode_id: EP_FREE });
  check('old JWT of a deleted account -> 401', afterDelete.status === 401, `HTTP ${afterDelete.status} ${JSON.stringify(afterDelete.body)}`);
  const deleteNoAuth = await fn('delete-account', ANON, {});
  check('delete-account without session -> 401', deleteNoAuth.status === 401, `HTTP ${deleteNoAuth.status}`);

  // ---------------------------------------------------------------- delete
  const del = await fn('admin-video-delete', adminJwt, { episode_id: EP_FREE });
  const del2 = await fn('admin-video-delete', adminJwt, { episode_id: EP_COIN });
  check('admin-video-delete removes videos', del.body.deleted === 1 && del2.body.deleted === 1, `${JSON.stringify(del.body)} ${JSON.stringify(del2.body)}`);
  const ours = [u1.up.body.uid, u2.up.body.uid, u3.up.body.uid];
  const stillThere = [];
  for (const uid of ours) if ((await call(`${CF}/${uid}`, { headers: CFH })).status !== 404) stillThere.push(uid);
  check('test uploads removed from Cloudflare', stillThere.length === 0, stillThere.join(','));
  const libraryAfter = await cfCount();
  check('Cloudflare library back to its starting size (minus replaced videos)', libraryAfter === libraryBefore - replacedVideos,
    `before=${libraryBefore} replaced=${replacedVideos} after=${libraryAfter}`);
} catch (err) {
  check('script error', false, err.stack);
} finally {
  // ---------------------------------------------------------------- cleanup
  for (const [id, d] of Object.entries(created.episodesTouched)) await rest(`episodes?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ duration_sec: d }) });
  for (const uid of created.users) await call(`${SB}/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: SVC });
  const leftovers = await rest('video_assets?select=id');
  console.log(`cleanup: users deleted=${created.users.length}, video_assets left=${leftovers.body.length}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}
