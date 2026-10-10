import { supabase, errorMessage } from './supabase';
/** Awaits a supabase-js call and throws its error; the caller states the row type. */
async function must(promise) {
    const { data, error } = await promise;
    if (error)
        throw new Error(await errorMessage(error));
    return data;
}
// ---------------------------------------------------------------- reads
export const api = {
    dashboard: () => must(supabase.rpc('admin_dashboard_stats')),
    seriesList: () => must(supabase.from('series').select('*').order('created_at', { ascending: false })),
    series: (id) => must(supabase.from('series').select('*').eq('id', id).maybeSingle()),
    episodes: (seriesId) => must(supabase
        .from('episodes')
        .select('id, series_id, number, title, duration_sec, access, coin_price, published')
        .eq('series_id', seriesId)
        .order('number')),
    episodeCounts: async () => {
        const rows = await must(supabase.from('episodes').select('series_id, published'));
        const counts = new Map();
        for (const r of rows) {
            const c = counts.get(r.series_id) ?? { total: 0, published: 0 };
            c.total++;
            if (r.published)
                c.published++;
            counts.set(r.series_id, c);
        }
        return counts;
    },
    /** Latest video per episode (video_assets is admin-readable only). */
    videos: async (episodeIds) => {
        if (episodeIds.length === 0)
            return new Map();
        const rows = await must(supabase
            .from('video_assets')
            .select('id, episode_id, status, duration_sec, error_reason, created_at')
            .in('episode_id', episodeIds)
            .order('created_at', { ascending: false }));
        const latest = new Map();
        for (const v of rows)
            if (!latest.has(v.episode_id))
                latest.set(v.episode_id, v);
        return latest;
    },
    config: () => must(supabase.from('app_config').select('key, value, description, updated_at').order('key')),
    usage: (days = 30) => {
        const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
        return must(supabase.from('stream_usage_daily').select('*').gte('day', since).order('day'));
    },
    abuseFlags: (openOnly) => must(supabase.rpc('admin_list_abuse_flags', { p_open_only: openOnly, p_limit: 200 })),
    findUser: (query) => must(supabase.rpc('admin_find_user', { p_query: query })),
    playbackEvents: (userId, limit = 100) => must(supabase.rpc('admin_playback_events', { p_user_id: userId, p_limit: limit })),
    // ---------------------------------------------------------------- writes
    saveSeries: (row, isNew) => must(isNew ? supabase.from('series').insert(row) : supabase.from('series').update(row).eq('id', row.id)),
    uploadPoster: async (seriesId, file) => {
        const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '.jpg';
        const path = `${seriesId}${ext}`;
        await must(supabase.storage.from('series-posters').upload(path, file, { contentType: file.type || 'image/jpeg', upsert: true }));
        const { data } = supabase.storage.from('series-posters').getPublicUrl(path);
        // Cache-bust so the new poster shows even though the path didn't change.
        const uri = `${data.publicUrl}?v=${Date.now()}`;
        await must(supabase.from('series').update({ poster_image_uri: uri }).eq('id', seriesId));
        return uri;
    },
    /** Creates the episode if missing; otherwise updates only the given fields. */
    upsertEpisode: async (ep, isNew) => {
        if (isNew) {
            await must(supabase.from('episodes').insert({
                title: `Episode ${ep.number}`,
                duration_sec: 0,
                access: 'free',
                coin_price: null,
                published: false,
                ...ep,
            }));
        }
        else {
            const { id, ...rest } = ep;
            await must(supabase.from('episodes').update(rest).eq('id', id));
        }
    },
    updateEpisode: (id, patch) => must(supabase.from('episodes').update(patch).eq('id', id)),
    /** Removes the episode's videos from Cloudflare first, then the row. */
    deleteEpisode: async (id) => {
        const { data, error } = await supabase.functions.invoke('admin-video-delete', { body: { episode_id: id } });
        if (error)
            throw new Error(await errorMessage(error));
        if (data?.failed?.length)
            throw new Error('Cloudflare 上的视频没删掉，请重试');
        await must(supabase.from('episodes').delete().eq('id', id));
    },
    /** Deletes every episode (and its Cloudflare videos), then the series. */
    deleteSeries: async (seriesId, episodeIds) => {
        for (const id of episodeIds)
            await api.deleteEpisode(id);
        await must(supabase.from('series').delete().eq('id', seriesId));
    },
    deleteVideoAsset: async (assetId) => {
        const { error } = await supabase.functions.invoke('admin-video-delete', { body: { asset_id: assetId } });
        if (error)
            throw new Error(await errorMessage(error));
    },
    /** One-time resumable (tus) upload URL on Cloudflare for this episode. */
    createUpload: async (episodeId, file) => {
        const { data, error } = await supabase.functions.invoke('admin-video-upload', {
            body: { episode_id: episodeId, mode: 'tus', file_size: file.size, file_name: file.name },
        });
        if (error)
            throw new Error(await errorMessage(error));
        return data;
    },
    setConfig: (key, value) => must(supabase.rpc('admin_set_config', { p_key: key, p_value: value })),
    resolveFlag: (id) => must(supabase.rpc('admin_resolve_abuse_flag', { p_flag_id: id })),
    blockUser: (userId, minutes, reason) => must(supabase.rpc('admin_block_user', { p_user_id: userId, p_minutes: minutes, p_reason: reason })),
};
