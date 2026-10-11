import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tusUpload } from '../../scripts/tus-upload.js';

/** Tiny in-memory tus server. `failPatches` makes the first N PATCHes store half the chunk, then 500. */
function fakeTus({ failPatches = 0, expired = false } = {}) {
  let stored = Buffer.alloc(0);
  let failures = failPatches;
  const server = createServer((req, res) => {
    if (expired) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Upload-Offset': String(stored.length) }).end();
      return;
    }
    if (req.method === 'PATCH') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (Number(req.headers['upload-offset']) !== stored.length) {
          res.writeHead(409).end();
          return;
        }
        if (failures > 0) {
          failures--;
          stored = Buffer.concat([stored, body.subarray(0, Math.floor(body.length / 2))]);
          res.writeHead(500).end();
          return;
        }
        stored = Buffer.concat([stored, body]);
        res.writeHead(204, { 'Upload-Offset': String(stored.length) }).end();
      });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/tus/abc`, server, stored: () => stored });
    });
  });
}

async function tempFile(bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'keybox-tus-'));
  const path = join(dir, 'ep01.mp4');
  await writeFile(path, bytes);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('uploads a file and reports progress', async () => {
  const data = randomBytes(1024 * 1024 + 123);
  const tus = await fakeTus();
  const file = await tempFile(data);
  const progress = [];
  try {
    await tusUpload(tus.url, file.path, (sent, total) => progress.push([sent, total]));
    assert.ok(tus.stored().equals(data), 'server has the exact bytes');
    assert.deepEqual(progress.at(-1), [data.length, data.length]);
  } finally {
    tus.server.close();
    await file.cleanup();
  }
});

test('recovers from a failed chunk by resuming at the server offset', { timeout: 20_000 }, async () => {
  const data = randomBytes(300 * 1024);
  const tus = await fakeTus({ failPatches: 1 });
  const file = await tempFile(data);
  try {
    await tusUpload(tus.url, file.path);
    assert.ok(tus.stored().equals(data), 'no duplicated or missing bytes after the retry');
  } finally {
    tus.server.close();
    await file.cleanup();
  }
});

test('reports an expired upload url so the caller can start over', async () => {
  const tus = await fakeTus({ expired: true });
  const file = await tempFile(randomBytes(10));
  try {
    await assert.rejects(tusUpload(tus.url, file.path), (err) => err.expired === true);
  } finally {
    tus.server.close();
    await file.cleanup();
  }
});
