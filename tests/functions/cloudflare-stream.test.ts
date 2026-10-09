import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBasicUpload,
  createTusUpload,
  deleteVideo,
  type StreamApiConfig,
} from "../../supabase/functions/_shared/cloudflare-stream.ts";

const UID = "0123456789abcdef0123456789abcdef";

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

function cfg(fetchFn: typeof fetch): StreamApiConfig {
  return { accountId: "acc123", apiToken: "secret-token", fetch: fetchFn };
}

test("basic upload: requires signed URLs, sets watermark/creator/origins, returns url + uid", async () => {
  const { fn, calls } = mockFetch(() =>
    Response.json({ success: true, result: { uploadURL: `https://upload.cloudflarestream.com/${UID}`, uid: UID } })
  );
  const res = await createBasicUpload(cfg(fn), {
    name: "crimson-contract-ep4",
    watermarkUid: "wm123",
    creator: "user-1",
    allowedOrigins: ["keybox.app", "*.keybox.app", "bad origin/"],
  });
  assert.deepEqual(res, { uploadUrl: `https://upload.cloudflarestream.com/${UID}`, uid: UID });

  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acc123/stream/direct_upload");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(sent.requireSignedURLs, true);
  assert.equal(sent.maxDurationSeconds, 1800);
  assert.deepEqual(sent.watermark, { uid: "wm123" });
  assert.equal(sent.creator, "user-1");
  assert.deepEqual(sent.allowedOrigins, ["keybox.app", "*.keybox.app"]);
  assert.deepEqual(sent.meta, { name: "crimson-contract-ep4" });
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret-token");
});

test("basic upload: rejects an upload url that isn't Cloudflare's", async () => {
  const { fn } = mockFetch(() => Response.json({ result: { uploadURL: "https://evil.example/x", uid: UID } }));
  await assert.rejects(createBasicUpload(cfg(fn), { name: "x" }), /unexpected upload url/);
});

test("basic upload: surfaces Cloudflare errors", async () => {
  const { fn } = mockFetch(() => new Response("nope", { status: 403 }));
  await assert.rejects(createBasicUpload(cfg(fn), { name: "x" }), /HTTP 403/);
});

test("tus upload: sends tus headers with requiresignedurls and watermark metadata", async () => {
  const { fn, calls } = mockFetch(() =>
    new Response(null, {
      status: 201,
      headers: { Location: `https://upload.videodelivery.net/tus/${UID}?tusv2=true`, "stream-media-id": UID },
    })
  );
  const res = await createTusUpload(cfg(fn), { name: "ep", fileSize: 500 * 1024 ** 2, watermarkUid: "wm1" });
  assert.equal(res.uid, UID);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acc123/stream?direct_user=true");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["Tus-Resumable"], "1.0.0");
  assert.equal(headers["Upload-Length"], String(500 * 1024 ** 2));
  const meta = headers["Upload-Metadata"].split(",");
  assert.ok(meta.includes("requiresignedurls"));
  assert.ok(meta.includes(`watermark ${btoa("wm1")}`));
  assert.ok(meta.includes(`name ${btoa("ep")}`));
});

test("tus upload: validates file size", async () => {
  const { fn } = mockFetch(() => new Response(null, { status: 201 }));
  await assert.rejects(createTusUpload(cfg(fn), { name: "ep", fileSize: 0 }), /invalid file size/);
});

test("delete: treats 404 as already deleted, rejects bad uids, surfaces other errors", async () => {
  const gone = mockFetch(() => new Response("", { status: 404 }));
  await deleteVideo(cfg(gone.fn), UID);
  assert.equal(gone.calls[0].url, `https://api.cloudflare.com/client/v4/accounts/acc123/stream/${UID}`);
  assert.equal(gone.calls[0].init.method, "DELETE");

  await assert.rejects(deleteVideo(cfg(gone.fn), "../../x"), /invalid video id/);

  const broken = mockFetch(() => new Response("boom", { status: 500 }));
  await assert.rejects(deleteVideo(cfg(broken.fn), UID), /HTTP 500/);
});
