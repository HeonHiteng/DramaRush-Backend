# Keybox backend — changes the app needs to make

Audience: the Keybox app team (repo `DramaRush`, Expo). This describes the
backend as of migration `20261009180000` and what the app must change to keep
working. "Keybox" is the real product name; "DramaRush" was a placeholder.

**Why things changed:** the paywall used to live only in the app. Anyone with
the public anon key could read every episode's video URL, give themselves
coins, unlock any episode or switch on a membership by writing to the tables
directly. All of that is now closed: the server decides who may watch, and
videos are served from Cloudflare Stream through short-lived signed links.

---

## 0. Suggested order of work

Each step leaves the app working, so it can ship in small PRs.

1. **Point `.env` at the new project** (§1). Everything except purchases,
   Demo Controls and Reset works immediately — seed episodes still carry
   their old `video_uri`, so the current player keeps playing.
2. **Switch purchases / membership / Demo Controls / Reset to RPCs** (§5).
   Read coin packages and plans from the database (§4).
3. **Switch the player to `playback-token`** (§3) — one fetch when a page
   becomes active, stop preloading neighbours, add the watermark overlay.
   Every published episode already has a playable 10-second demo video.
4. **Select explicit episode columns** (§4) — no more `video_uri`.
5. **Admin screens** (§6–7): published toggle, upload through
   `admin-video-upload`.
6. **Rename to Keybox** (§8) whenever convenient.
7. Update `src/testUtils/supabaseMock.ts`: its JS copies of the RPCs should
   mirror §5 (server-side prices, `redeem_ad_reward` may return `false`,
   direct table writes now fail).

Tell the backend team when step 3 is live: we then delete `video_uri` and
the old public `episode-videos` bucket.

## 1. Connect to the new project

| | |
|---|---|
| Project | `keybox` (ref `ogqagauogrzezfmveewk`, Singapore) |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://ogqagauogrzezfmveewk.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWFnYXVvZ3J6ZXpmbXZlZXdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE1NTQ3NDAsImV4cCI6MjEwNzEzMDc0MH0.xR9IePiD3ipknNKg3zurQgCfpk9_cNwo8jls_F_YPbY` |

The anon key is public by design (it ships inside the app); what protects
data is Row Level Security. Never put a service-role / secret key in the app.

Already set up on the backend: anonymous (guest) sign-in on, the same 8
demo series / 54 episodes, and a 10-second demo video on every episode
(free episodes play right away; locked ones need an unlock).

**Test accounts.** Guests: just use the app. Admin (for `/admin`): sign up
with an email in the app, then ask the backend team to promote that email.
Email confirmation is currently on, so confirm the email first.

---

## 2. What breaks and what replaces it

| App code today | Status | Use instead |
|---|---|---|
| `episodes.video_uri` → `useVideoPlayer(episode.videoUri)` (`PlayerPage.tsx:69`) | **Gone for real content** (null for Stream episodes; column will be dropped) | `playback-token` function (§3) |
| `from('episodes').select('*')` (`services/content.ts:75`) | Works today, breaks when `video_uri` is dropped | Select explicit columns (§4) |
| `walletStore.addCoins` / `purchasePackage` / `setBalance` — direct `wallets` update + `transactions` insert | **Permission denied** | `simulate_purchase`, `demo_set_balance` (§5) |
| `subscriptionStore` activate / cancel — direct `subscriptions` update | **Permission denied** | `simulate_subscribe`, `cancel_subscription` |
| `libraryStore` "Unlock All" / "Lock All" — direct `unlocks` upsert/delete | **Permission denied** | `demo_set_all_unlocked` (admins only) |
| `resetPrototype` — direct deletes of transactions / unlocks / daily_mission_claims + wallet update | **Permission denied** for those tables | `reset_my_data()` |
| `profiles` update of anything but `display_name` / `avatar_seed` | **Permission denied** | — |
| `COIN_PACKAGES`, `SUBSCRIPTION_PLANS`, `STARTING_COIN_BALANCE` in `src/data/wallet.ts` | Server is now the source of truth | `coin_packages`, `subscription_plans` tables (§4) |
| Admin upload to storage bucket `episode-videos` (`content.ts:264-273`) | **Deprecated** (bucket will be removed) | `admin-video-upload` function (§7) |
| `unlock_episode_with_coins`, `redeem_ad_reward`, `claim_daily_mission` RPCs | Same names/args/returns | `redeem_ad_reward` may now return `false` (daily cap) |
| Favorites, watch history, progress, recent searches | Unchanged | — |

**Guest sign-in (one guest per phone).** Sign guests in through the
`guest-session` function instead of calling `signInAnonymously` directly, so a
reinstall (or cleared app storage) brings back the same guest — favorites,
history, progress and ad unlocks included:

```ts
// device_key: 8–128 chars of [A-Za-z0-9._-], stable for this phone:
// Android expo-application getAndroidId(); iOS a random UUID kept in expo-secure-store
// (Keychain survives reinstall), getIosIdForVendorAsync() as a fallback; web a localStorage UUID.
async function signInAsGuest(deviceKey: string | null) {
  if (deviceKey) {
    const { data, error } = await supabase.functions.invoke('guest-session', { body: { device_key: deviceKey } });
    if (!error && data?.access_token) {
      const { error: setError } = await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      });
      if (!setError) return; // data.user_id; data.created = true the first time on this device
    }
  }
  await supabase.auth.signInAnonymously(); // fallback: no key, offline, 429, 500
}
```

- `POST /functions/v1/guest-session` `{ device_key }` → **200** `{ access_token,
  refresh_token, expires_in, user_id, created }`. No session needed (send the
  anon key as usual; `functions.invoke` does). Errors: `400 bad_request`
  (missing / malformed key), `429 guest_limit` (too many new guests from this
  network today, `guest_new_per_ip_per_day`), `500 server_error`. On any
  error fall back to `signInAnonymously`.
- The session is a normal Supabase session (refreshes itself). The user is
  **not** `is_anonymous` — it is an email account with a synthetic
  `@guest.kbbox.app` address. Decide "guest or not" from
  `profiles.provider === 'guest'` (or `user.is_anonymous` for the fallback
  guests), never from `is_anonymous` alone, and don't show that address.
- Linking works the same as for anonymous guests: `linkIdentity({ provider:
  'google' })` or `updateUser({ phone })` + verify (`phone_change`). After that
  `profiles.provider` is `google` / `phone`, the welcome bonus is paid once
  and the account is a member. That phone then gets a new, empty guest the
  next time it needs one (e.g. after signing out).
- "Delete guest data" = `delete-account` as before; the next launch gets a new
  empty guest for the device.

Rule of thumb: **never compute balances or entitlements on the client.** After
any RPC that changes money/unlocks, re-read `wallets`, `transactions`,
`unlocks`, `subscriptions` (or use the returned value).

---

## 3. Playback (the important part)

Only a signed-in session can play anything (guests: a `guest-session`
device guest, or an anonymous session as the fallback — see §2).

```ts
const { data, error } = await supabase.functions.invoke('playback-token', {
  body: { episode_id: episode.id },
});
```

**200**
```json
{
  "episode_id": "crimson-contract-ep4",
  "hls_url": "https://customer-xxxx.cloudflarestream.com/<token>/manifest/video.m3u8",
  "dash_url": "https://customer-xxxx.cloudflarestream.com/<token>/manifest/video.mpd",
  "thumbnail_url": "https://customer-xxxx.cloudflarestream.com/<token>/thumbnails/thumbnail.jpg",
  "expires_at": "2026-10-09T15:30:00.000Z",
  "watermark_code": "7KQ2MXA"
}
```

**Guests** (device guest or anonymous session) get the same full token as
members for **free** episodes and for **ad** episodes they unlocked with
`redeem_ad_reward` (§5). An ad episode they haven't unlocked gives 403
`not_entitled` (offer the ad); a **coin** or **subscriber** episode gives 403
`account_required` (show the "link an account" gate, not the paywall).

Reading the error code (supabase-js wraps non-2xx responses in `FunctionsHttpError`):

```ts
import { FunctionsHttpError } from '@supabase/supabase-js';

async function getPlayback(episodeId: string) {
  const { data, error } = await supabase.functions.invoke('playback-token', { body: { episode_id: episodeId } });
  if (!error) return { ok: true as const, ...data };
  if (error instanceof FunctionsHttpError) {
    const { error: code } = await error.context.json(); // 'not_entitled' | 'unavailable' | ...
    return { ok: false as const, code, status: error.context.status };
  }
  return { ok: false as const, code: 'network_error' };
}
```

**Errors** (body `{ "error": "<code>" }`):

| Status | `error` | Meaning → what the app shows |
|---|---|---|
| 401 | `not_authenticated` | No/expired session → sign in as guest and retry |
| 403 | `not_entitled` | Locked (or unpublished) → paywall; for a guest only an ad episode not unlocked yet → offer the ad |
| 403 | `account_required` | Guest asked for a coin or subscriber episode → "link an account" gate (Google / WhatsApp), not the paywall |
| 404 | `unavailable` | Video still processing / not uploaded → "coming soon" |
| 429 | `rate_limited`, `blocked` | Too many requests; account temporarily blocked for playback → "try again later" |
| 503 | `budget` | Free/ad episodes paused by the daily cost guard → "try again later" (paid episodes still play) |

How to use it:

1. **Request a token only when an episode page becomes active** (the visible
   page in the vertical FlatList). Do **not** give neighbouring pages a URL —
   today every rendered `PlayerPage` creates a player and preloads. Every
   buffered second is billed by Cloudflare, and preloading also burns the
   per-user rate limit.
2. Play `hls_url` with expo-video: `useVideoPlayer({ uri: hls_url, contentType: 'hls' })`.
   Use `thumbnail_url` for the poster frame if needed (same expiry).
   **Web build:** iOS/Android play HLS natively, and so do Safari and Chrome
   142+, but Firefox and older Chrome can't play `.m3u8` in a plain
   `<video>`. On web, check `video.canPlayType('application/vnd.apple.mpegurl')`
   and fall back to [hls.js](https://github.com/video-dev/hls.js) when it's
   empty. Test the Vercel build in Chrome and Firefox.
3. Tokens last **15 minutes** (`expires_at`), for guests too. If playback errors (HTTP 401/403
   from Cloudflare) or the user resumes after `expires_at`, call
   `playback-token` again and continue from the current position. Re-requesting
   the same episode is cheap and expected.
4. After a successful unlock (`unlock_episode_with_coins` / `redeem_ad_reward` /
   `simulate_subscribe`), request a token — don't reuse anything cached.
5. **Watermark overlay:** draw `watermark_code` small and semi-transparent over
   the video (e.g. 30–40% opacity, moving corner every ~20 s). It identifies
   the viewer if a screen recording leaks. (The Keybox logo is additionally
   burned into the video itself by the backend.)
6. **Screen capture:** on Android enable secure mode while the player is
   visible (`expo-screen-capture` `preventScreenCaptureAsync()`); on iOS
   listen for recording (`addScreenshotListener` / `isScreenRecording`-style
   APIs) and pause + blur while recording.
7. Locked badges: still compute from `access` + `unlocks` + `subscriptions`
   for display only. Note subscriber episodes are watchable by active members
   (badge currently shows a lock for them, `EpisodeRow.tsx:18`).

---

## 4. Catalog & config reads

```ts
supabase.from('episodes')
  .select('id, series_id, number, title, duration_sec, access, coin_price, published, video_width, video_height')
  .order('number');
```

- Only `published` episodes are returned to users (admins see all) — no client filter needed.
- `duration_sec` is filled in automatically from the uploaded video.
- `video_width` / `video_height` (pixels, from Cloudflare) tell landscape from portrait: the app
  letterboxes landscape videos (`contentFit="contain"`) and offers an in-app rotated view.

New read-only tables (anon + signed-in):

| Table | Columns |
|---|---|
| `coin_packages` | `id, coins, bonus_coins, price_usd, badge, store_product_id, sort_order` (only active rows) |
| `subscription_plans` | `id, title, price_usd, billing_period, bonus_coins, store_product_id, sort_order` |
| `app_config` (public rows) | `key, value` — `simulated_payments` (bool), `daily_mission_reward` (int), `ad_unlocks_per_day` (int), `welcome_bonus_coins` (int) |

Hide the fake purchase buttons when `simulated_payments` is `false` (it will
be switched off before launch, when real store billing arrives).

`profiles` gained `public_code` (7 chars, the watermark code) — readable by its owner.

---

## 5. Wallet, membership, rewards (RPCs)

All require a signed-in session. Errors are thrown as PostgREST errors whose
`message` is one of the codes below.

| RPC | Args | Returns | Notes |
|---|---|---|---|
| `unlock_episode_with_coins` | `{ p_episode_id }` | `boolean` | `false` = not enough coins. **Members only** |
| `redeem_ad_reward` | `{ p_episode_id }` | `boolean` | `false` = daily ad-unlock cap reached (`ad_unlocks_per_day`). Guests too |
| `claim_daily_mission` | – | `integer` coins (0 = already claimed today, UTC) | amount from `app_config`. **Members only** |
| `simulate_purchase` | `{ p_package_id }` e.g. `'coins-250'` | new balance `integer` | adds coins + bonus, writes the transaction. **Members only** |
| `simulate_subscribe` | `{ p_plan_id }` `'monthly' \| 'annual'` | `subscriptions` row | sets active + `renews_at`, clears `cancelled_at`; plan bonus coins only if no membership is running and none was paid in the last billing period (`bonus_granted_at`). **Members only** |
| `cancel_subscription` | – | `subscriptions` row | sets `cancelled_at`; `is_active` stays true and subscriber episodes keep playing until `renews_at` |
| `reset_my_data` | – | – | "Reset Prototype": clears own favorites/unlocks/history/progress/searches/transactions/daily claims, sets the balance to 0, ends membership (the welcome bonus is not paid again) |
| `demo_set_balance` | `{ p_balance }` | `integer` | **admins only** (Demo Controls "+500" = current+500, "Remove all" = 0) |
| `demo_set_all_unlocked` | `{ p_unlocked: boolean }` | – | **admins only** |
| `can_watch` | `{ p_episode_id }` | `boolean` | optional helper; playback still goes through `playback-token` |

Error messages: `not_authenticated`, `account_required` (the caller is a
guest — show the "link an account" gate), `payments_disabled` (simulated
payments switched off), `admin_only`, `episode <id> not found`, `episode <id>
is not a coin-unlock episode`, `package <id> not found`, `plan <id> not found`.

**Account rules** (since `20261019120000_account_rules.sql`):

- **Guests have 0 coins** and can't earn or spend coins: the four "Members
  only" RPCs above raise `account_required`. Guests watch **free episodes in
  full** and may **unlock ad episodes** with `redeem_ad_reward` (same daily
  cap as members); coin and subscriber episodes need an account — see §3.
- **Every new account starts with 0 coins.** The **welcome bonus** (150,
  `welcome_bonus_coins`) is paid by the server the moment a real identity
  (Google / WhatsApp phone / Apple / email) is attached — signing up with it,
  or a guest linking it (`linkIdentity`, phone verify). Once per account
  (linking Google *and* a phone pays once) and **once per identity, ever**:
  deleting the account and signing up again with the same Google account or
  phone number pays nothing. It shows up as a `bonus` transaction labelled
  `Welcome bonus`; re-read `wallets` after linking.
- On linking, `profiles.provider` becomes `google` / `phone` and a default
  name (`Guest Viewer`) becomes the Google name (or `KBbox Member`). A name the
  user chose is kept. Read the provider from `profiles.provider`.
- **Membership:** the plan bonus is paid at most once per billing period.
  Cancelling keeps access until `renews_at` (show "cancelled, ends on
  `renews_at`" when `cancelled_at` is set); an hourly job sets `is_active =
  false` after `renews_at`. Subscribing again while cancelled resumes it.
- Read the balance from `wallets`; don't assume a constant.

**Delete account** (store requirement), guests included:

```ts
const { error } = await supabase.functions.invoke('delete-account'); // POST, no body
// 200 { deleted: true } → supabase.auth.signOut({ scope: 'local' }), clear local state, go to onboarding
// 401 not_authenticated · 500 server_error
```

Everything per-user is deleted; the old access token stops working
immediately (`playback-token` → 401). The watermark code is archived
server-side so leaks stay traceable.

---

## 6. Admin screens (in-app `/admin`)

Admins (`profiles.is_admin = true`) can still insert/update/delete `series` and
`episodes` directly. Changes:

- **New episodes start unpublished.** Add a "Published" toggle
  (`update episodes set published = true`). Publish once the video is ready.
- `video_uri` is optional now — don't send it.
- Video status per episode: `supabase.from('video_assets').select('episode_id, status, error_reason, duration_sec, created_at, ready_at')`
  (admins only). `status`: `pending_upload` → `ready` | `error`.
- Abuse review: `abuse_flags` (admins can read); clear a block with
  `rpc('admin_resolve_abuse_flag', { p_flag_id })`. Playback log:
  `playback_events`; daily usage: `stream_usage_daily`.

## 7. Uploading a video (admin)

```ts
// 1. ask the backend for a one-time Cloudflare upload URL
const { data } = await supabase.functions.invoke('admin-video-upload', {
  body: { episode_id, file_size: file.size, file_name: file.name },
});
// data = { asset_id, uid, upload_url, mode: 'basic' | 'tus' }

// 2a. mode 'basic' (files ≤ 200 MB): one multipart POST, field name "file"
const form = new FormData();
form.append('file', file);
await fetch(data.upload_url, { method: 'POST', body: form });

// 2b. mode 'tus' (> 200 MB, chosen automatically from file_size):
//     upload with any tus client (e.g. tus-js-client) using
//     { uploadUrl: data.upload_url, chunkSize: 50 * 1024 * 1024 }
```

Cloudflare processes the file (usually under a minute for a short episode),
then the backend marks it `ready` and fills the episode duration. Uploading a
new video for an episode replaces the old one automatically once the new one
is ready.

Errors: `401 not_authenticated`, `403 admin_only`, `400 bad_request`,
`404 episode_not_found`, `500 server_error`.

**Before deleting an episode**, delete its videos so they stop being stored
(and billed): `functions.invoke('admin-video-delete', { body: { episode_id } })`
→ `{ deleted, failed }`. A single failed upload: `{ asset_id }`.

Bulk uploads of whole series are done by the backend team with
`npm run upload-series` (see backend README), not through the app.

---

## 8. Rename to Keybox

- `src/config/brand.ts`: name `Keybox`, scheme `keybox` (OAuth redirect
  `keybox://` is already allowed on the backend; `dramarush://` will be
  removed later), support email / website when known.
- Hardcoded "DramaRush" strings: `app/(tabs)/search.tsx:61`,
  `app/(tabs)/index.tsx:125`, `app/auth/index.tsx:161`, `app.json`
  (name/slug/scheme/bundle ids), `package.json`, AsyncStorage keys
  `dramarush/*` in `src/store/storage.ts` (migrate or accept a one-time reset).
- New members are named "Keybox Member" by the backend.

## 9. Coming next (not live yet)

- Cloudflare Turnstile captcha on guest sign-in: the app will need to pass a
  token to `guest-session` and `options.captchaToken` to `signInAnonymously`.
  We'll announce the site key.
- Real App Store / Google Play billing (RevenueCat) replacing `simulate_*`.
- Ad-network server verification for `redeem_ad_reward` / `claim_daily_mission`.

## 10. Quick self-test

1. Guest sign-in (`guest-session`) → balance 0, `public_code` present, `profiles.provider = 'guest'`;
   reinstall / clear storage → same `user_id` again.
2. Guest: free episode → `playback-token` 200, plays in full; ad episode → 403 `not_entitled` →
   `redeem_ad_reward` → 200; coin episode → 403 `account_required`; daily mission → `account_required`.
3. Link Google / WhatsApp → balance 150 once; coin episode → 403 `not_entitled` → unlock with coins → 200.
4. Direct `update wallets ...` from the console → permission denied.
5. Leave a video paused > 15 min, resume → app fetches a new token and continues.
