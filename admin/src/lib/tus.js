/**
 * Browser tus 1.0 client for Cloudflare Stream one-time upload URLs — same
 * approach as scripts/tus-upload.js and aiseahub官网/src/lib/tus-upload.ts.
 * Uses XMLHttpRequest for the PATCHes so progress is reported within a chunk.
 */
// Cloudflare: chunks must be >= 5MB and a multiple of 256KiB (except the last).
const CHUNK_BYTES = 50 * 1024 * 1024;
const MAX_CONSECUTIVE_FAILURES = 6;
export class TusExpiredError extends Error {
    constructor() {
        super('upload url expired');
        this.name = 'TusExpiredError';
    }
}
export class TusAbortedError extends Error {
    constructor() {
        super('upload cancelled');
        this.name = 'TusAbortedError';
    }
}
async function currentOffset(uploadUrl, signal) {
    const res = await fetch(uploadUrl, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' }, signal });
    if (res.status === 404 || res.status === 410)
        throw new TusExpiredError();
    if (!res.ok)
        throw new Error(`HEAD failed: HTTP ${res.status}`);
    return Number(res.headers.get('Upload-Offset') ?? 0);
}
function patchChunk(uploadUrl, offset, chunk, signal, onChunkProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PATCH', uploadUrl);
        xhr.setRequestHeader('Tus-Resumable', '1.0.0');
        xhr.setRequestHeader('Upload-Offset', String(offset));
        xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
        xhr.upload.onprogress = (e) => onChunkProgress(e.loaded);
        xhr.onload = () => {
            if (xhr.status === 204)
                resolve(Number(xhr.getResponseHeader('Upload-Offset') ?? offset + chunk.size));
            else if (xhr.status === 404 || xhr.status === 410)
                reject(new TusExpiredError());
            else
                reject(new Error(`PATCH failed: HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('network error'));
        xhr.onabort = () => reject(new TusAbortedError());
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(chunk);
    });
}
/** Uploads (or resumes) `file` to `uploadUrl`. onProgress(bytesSent, total). */
export async function tusUpload(uploadUrl, file, onProgress, signal) {
    let offset = await currentOffset(uploadUrl, signal);
    let failures = 0;
    onProgress(offset, file.size);
    while (offset < file.size) {
        if (signal.aborted)
            throw new TusAbortedError();
        const chunk = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size));
        try {
            const base = offset;
            offset = await patchChunk(uploadUrl, offset, chunk, signal, (sent) => onProgress(base + sent, file.size));
            failures = 0;
            onProgress(offset, file.size);
        }
        catch (err) {
            if (err instanceof TusExpiredError || err instanceof TusAbortedError)
                throw err;
            failures++;
            if (failures > MAX_CONSECUTIVE_FAILURES)
                throw err;
            await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
            // The server may have kept part of the chunk: continue from its offset.
            offset = await currentOffset(uploadUrl, signal);
        }
    }
}
