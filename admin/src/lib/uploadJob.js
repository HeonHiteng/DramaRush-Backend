import { api } from './api';
import { TusAbortedError, TusExpiredError, tusUpload } from './tus';
/** Same file + episode → same key, so a page reload can resume the upload. */
function storageKey(episodeId, file) {
    return `keybox-admin:tus:${episodeId}:${file.name}:${file.size}:${file.lastModified}`;
}
function readStored(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    }
    catch {
        return null;
    }
}
function writeStored(key, value) {
    try {
        if (value)
            localStorage.setItem(key, JSON.stringify(value));
        else
            localStorage.removeItem(key);
    }
    catch {
        /* private mode: resume just won't survive a reload */
    }
}
/**
 * Saves the episode row, then uploads the file to Cloudflare Stream over tus
 * (resuming a previous attempt when possible). Resolves when the bytes are
 * all on Cloudflare; the stream-webhook marks the video ready afterwards.
 */
export async function runUpload(job, opts) {
    const { seriesId, isNewEpisode, episodePatch, onUpdate, signal } = opts;
    try {
        onUpdate({ state: 'saving', error: undefined });
        if (isNewEpisode || Object.keys(episodePatch).length > 0) {
            await api.upsertEpisode({ id: job.episodeId, series_id: seriesId, number: job.number, ...episodePatch }, isNewEpisode);
        }
        const key = storageKey(job.episodeId, job.file);
        let stored = readStored(key);
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!stored) {
                const created = await api.createUpload(job.episodeId, job.file);
                stored = { uploadUrl: created.upload_url, assetId: created.asset_id };
                writeStored(key, stored);
            }
            onUpdate({ state: 'uploading' });
            try {
                await tusUpload(stored.uploadUrl, job.file, (sent) => onUpdate({ sent }), signal);
                break;
            }
            catch (err) {
                if (!(err instanceof TusExpiredError) || attempt === 1)
                    throw err;
                // The one-time link expired (e.g. resumed much later): drop the
                // half-uploaded video and start a fresh upload.
                await api.deleteVideoAsset(stored.assetId).catch(() => { });
                writeStored(key, null);
                stored = null;
            }
        }
        writeStored(key, null);
        onUpdate({ state: 'processing', sent: job.file.size });
    }
    catch (err) {
        if (err instanceof TusAbortedError || signal.aborted) {
            onUpdate({ state: 'cancelled' });
            return;
        }
        onUpdate({ state: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
}
