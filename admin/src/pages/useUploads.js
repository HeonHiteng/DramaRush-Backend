import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { runUpload } from '../lib/uploadJob';
const CONCURRENCY = 2;
const POLL_MS = 5000;
/**
 * Upload queue for one series page: runs at most 2 uploads at once, then
 * watches video_assets until Cloudflare has processed each video, optionally
 * publishing the episode. Warns before leaving the page mid-upload.
 */
export function useUploads(seriesId, onChanged) {
    const [jobs, setJobs] = useState({});
    const pending = useRef([]);
    const running = useRef(0);
    const controllers = useRef(new Map());
    const publishOnReady = useRef(new Set());
    const onChangedRef = useRef(onChanged);
    useEffect(() => {
        onChangedRef.current = onChanged;
    });
    const patch = useCallback((episodeId, p) => {
        setJobs((all) => (all[episodeId] ? { ...all, [episodeId]: { ...all[episodeId], ...p } } : all));
    }, []);
    const pump = useCallback(() => {
        while (running.current < CONCURRENCY && pending.current.length > 0) {
            const task = pending.current.shift();
            const controller = new AbortController();
            controllers.current.set(task.job.episodeId, controller);
            if (task.publishWhenReady)
                publishOnReady.current.add(task.job.episodeId);
            running.current++;
            runUpload(task.job, {
                seriesId,
                isNewEpisode: task.isNewEpisode,
                episodePatch: task.episodePatch,
                onUpdate: (p) => patch(task.job.episodeId, p),
                signal: controller.signal,
            }).finally(() => {
                running.current--;
                controllers.current.delete(task.job.episodeId);
                onChangedRef.current();
                pump();
            });
        }
    }, [patch, seriesId]);
    const enqueue = useCallback((tasks) => {
        setJobs((all) => {
            const next = { ...all };
            for (const t of tasks)
                next[t.job.episodeId] = t.job;
            return next;
        });
        pending.current.push(...tasks);
        pump();
    }, [pump]);
    const cancel = useCallback((episodeId) => {
        const queuedIndex = pending.current.findIndex((t) => t.job.episodeId === episodeId);
        if (queuedIndex >= 0) {
            pending.current.splice(queuedIndex, 1);
            patch(episodeId, { state: 'cancelled' });
        }
        controllers.current.get(episodeId)?.abort();
    }, [patch]);
    const dismiss = useCallback((episodeId) => {
        setJobs((all) => {
            const next = { ...all };
            delete next[episodeId];
            return next;
        });
    }, []);
    // Watch Cloudflare processing for uploaded videos.
    const processingIds = Object.values(jobs)
        .filter((j) => j.state === 'processing')
        .map((j) => j.episodeId);
    const processingKey = processingIds.join(',');
    useEffect(() => {
        if (!processingKey)
            return;
        const ids = processingKey.split(',');
        const timer = setInterval(async () => {
            try {
                const videos = await api.videos(ids);
                let changed = false;
                for (const id of ids) {
                    const v = videos.get(id);
                    if (v?.status === 'ready') {
                        if (publishOnReady.current.delete(id))
                            await api.updateEpisode(id, { published: true });
                        patch(id, { state: 'ready' });
                        changed = true;
                    }
                    else if (v?.status === 'error') {
                        patch(id, { state: 'failed', error: `Cloudflare 处理失败：${v.error_reason ?? '未知原因'}` });
                        changed = true;
                    }
                }
                if (changed)
                    onChangedRef.current();
            }
            catch {
                /* try again next tick */
            }
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [processingKey, patch]);
    const busy = Object.values(jobs).some((j) => j.state === 'queued' || j.state === 'saving' || j.state === 'uploading');
    useEffect(() => {
        if (!busy)
            return;
        const warn = (e) => {
            e.preventDefault();
        };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [busy]);
    return { jobs, enqueue, cancel, dismiss, busy };
}
