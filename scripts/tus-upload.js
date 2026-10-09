// Minimal resumable (tus 1.0) uploader for Cloudflare Stream one-time upload
// URLs, so bulk uploads survive flaky connections without an extra
// dependency. Same approach as aiseahub官网/src/lib/tus-upload.ts.
import { open, stat } from 'node:fs/promises';
import { sleep } from './lib.js';

// Cloudflare: chunks must be >= 5MB and a multiple of 256KiB (except the last).
const CHUNK_BYTES = 50 * 1024 * 1024;
const MAX_CONSECUTIVE_FAILURES = 6;

async function currentOffset(uploadUrl) {
  const res = await fetch(uploadUrl, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
  if (res.status === 404 || res.status === 410) {
    const err = new Error('upload url expired');
    err.expired = true;
    throw err;
  }
  if (!res.ok) throw new Error(`HEAD failed: HTTP ${res.status}`);
  return Number(res.headers.get('Upload-Offset') ?? 0);
}

/**
 * Uploads (or resumes) `filePath` to a tus `uploadUrl`.
 * onProgress(sentBytes, totalBytes) is called after every chunk.
 * Throws an error with `.expired = true` if the upload URL is no longer valid.
 */
export async function tusUpload(uploadUrl, filePath, onProgress = () => {}) {
  const { size } = await stat(filePath);
  const file = await open(filePath, 'r');
  try {
    let offset = await currentOffset(uploadUrl);
    let failures = 0;
    onProgress(offset, size);

    while (offset < size) {
      const length = Math.min(CHUNK_BYTES, size - offset);
      const chunk = Buffer.alloc(length);
      await file.read(chunk, 0, length, offset);

      try {
        const res = await fetch(uploadUrl, {
          method: 'PATCH',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: chunk,
          signal: AbortSignal.timeout(5 * 60_000),
        });
        if (res.status !== 204) throw new Error(`PATCH failed: HTTP ${res.status}`);
        offset = Number(res.headers.get('Upload-Offset') ?? offset + length);
        failures = 0;
        onProgress(offset, size);
      } catch (err) {
        failures++;
        if (err.expired || failures > MAX_CONSECUTIVE_FAILURES) throw err;
        await sleep(Math.min(30_000, 1000 * 2 ** failures));
        // The server may have kept part of the chunk: continue from its offset.
        offset = await currentOffset(uploadUrl);
      }
    }
  } finally {
    await file.close();
  }
}
