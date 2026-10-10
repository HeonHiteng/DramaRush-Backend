import { supabase, errorMessage } from './supabase';
import type { EpisodeAccess } from './episodes';

/** Awaits a supabase-js call and throws its error; the caller states the row type. */
async function must<T = unknown>(promise: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(await errorMessage(error));
  return data as T;
}

// ---------------------------------------------------------------- types

export interface CastMember {
  name: string;
  role: string;
}

export interface Series {
  id: string;
  title: string;
  synopsis: string;
  genres: string[];
  rating: number;
  status: 'ongoing' | 'completed';
  language: string;
  poster_color_from: string;
  poster_color_to: string;
  banner_color_from: string;
  banner_color_to: string;
  cast_members: CastMember[];
  popularity: number;
  is_new: boolean;
  poster_image_uri: string | null;
}

export interface Episode {
  id: string;
  series_id: string;
  number: number;
  title: string;
  duration_sec: number;
  access: EpisodeAccess;
  coin_price: number | null;
  published: boolean;
}

export type VideoStatus = 'pending_upload' | 'processing' | 'ready' | 'error';

export interface VideoAsset {
  id: string;
  episode_id: string;
  status: VideoStatus;
  duration_sec: number | null;
  error_reason: string | null;
  created_at: string;
}

export interface DashboardStats {
  series: number;
  episodes_total: number;
  episodes_published: number;
  videos_ready: number;
  videos_processing: number;
  videos_failed: number;
  stored_minutes: number;
  users_total: number;
  users_guest: number;
  today_minutes: number;
  usage_synced_at: string | null;
  daily_minutes_budget: number;
  tokens_today: number;
  open_abuse_flags: number;
}

export interface ConfigRow {
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
}

export interface AbuseFlag {
  id: number;
  user_id: string;
  reason: string;
  details: Record<string, unknown>;
  created_at: string;
  blocks_playback_until: string | null;
  resolved_at: string | null;
  display_name: string | null;
  public_code: string | null;
  email: string | null;
  is_anonymous: boolean;
}

export interface AdminUser {
  user_id: string;
  display_name: string;
  public_code: string;
  email: string | null;
  is_anonymous: boolean;
  is_admin: boolean;
  created_at: string;
  balance: number | null;
  is_member: boolean;
  member_until: string | null;
  unlock_count: number;
  blocked_until: string | null;
}

export interface PlaybackEvent {
  id: number;
  created_at: string;
  user_id: string;
  public_code: string | null;
  episode_id: string;
  episode_number: number | null;
  series_title: string | null;
  decision: string;
  client_ip: string | null;
  user_agent: string | null;
}

export interface UsageDay {
  day: string;
  minutes_viewed: number;
  synced_at: string;
}

// ---------------------------------------------------------------- reads

export const api = {
  dashboard: () => must<DashboardStats>(supabase.rpc('admin_dashboard_stats')),

  seriesList: () => must<Series[]>(supabase.from('series').select('*').order('created_at', { ascending: false })),

  series: (id: string) => must<Series | null>(supabase.from('series').select('*').eq('id', id).maybeSingle()),

  episodes: (seriesId: string) =>
    must<Episode[]>(
      supabase
        .from('episodes')
        .select('id, series_id, number, title, duration_sec, access, coin_price, published')
        .eq('series_id', seriesId)
        .order('number')
    ),

  episodeCounts: async () => {
    const rows = await must<{ series_id: string; published: boolean }[]>(supabase.from('episodes').select('series_id, published'));
    const counts = new Map<string, { total: number; published: number }>();
    for (const r of rows) {
      const c = counts.get(r.series_id) ?? { total: 0, published: 0 };
      c.total++;
      if (r.published) c.published++;
      counts.set(r.series_id, c);
    }
    return counts;
  },

  /** Latest video per episode (video_assets is admin-readable only). */
  videos: async (episodeIds: string[]) => {
    if (episodeIds.length === 0) return new Map<string, VideoAsset>();
    const rows = await must<VideoAsset[]>(
      supabase
        .from('video_assets')
        .select('id, episode_id, status, duration_sec, error_reason, created_at')
        .in('episode_id', episodeIds)
        .order('created_at', { ascending: false })
    );
    const latest = new Map<string, VideoAsset>();
    for (const v of rows) if (!latest.has(v.episode_id)) latest.set(v.episode_id, v);
    return latest;
  },

  config: () => must<ConfigRow[]>(supabase.from('app_config').select('key, value, description, updated_at').order('key')),

  usage: (days = 30) => {
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    return must<UsageDay[]>(supabase.from('stream_usage_daily').select('*').gte('day', since).order('day'));
  },

  abuseFlags: (openOnly: boolean) =>
    must<AbuseFlag[]>(supabase.rpc('admin_list_abuse_flags', { p_open_only: openOnly, p_limit: 200 })),

  findUser: (query: string) => must<AdminUser[]>(supabase.rpc('admin_find_user', { p_query: query })),

  playbackEvents: (userId: string | null, limit = 100) =>
    must<PlaybackEvent[]>(supabase.rpc('admin_playback_events', { p_user_id: userId, p_limit: limit })),

  // ---------------------------------------------------------------- writes

  saveSeries: (row: Omit<Series, 'poster_image_uri'> & { poster_image_uri?: string | null }, isNew: boolean) =>
    must(isNew ? supabase.from('series').insert(row) : supabase.from('series').update(row).eq('id', row.id)),

  uploadPoster: async (seriesId: string, file: File) => {
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
  upsertEpisode: async (ep: Partial<Episode> & { id: string; series_id: string; number: number }, isNew: boolean) => {
    if (isNew) {
      await must(
        supabase.from('episodes').insert({
          title: `Episode ${ep.number}`,
          duration_sec: 0,
          access: 'free',
          coin_price: null,
          published: false,
          ...ep,
        })
      );
    } else {
      const { id, ...rest } = ep;
      await must(supabase.from('episodes').update(rest).eq('id', id));
    }
  },

  updateEpisode: (id: string, patch: Partial<Episode>) => must(supabase.from('episodes').update(patch).eq('id', id)),

  /** Removes the episode's videos from Cloudflare first, then the row. */
  deleteEpisode: async (id: string) => {
    const { data, error } = await supabase.functions.invoke('admin-video-delete', { body: { episode_id: id } });
    if (error) throw new Error(await errorMessage(error));
    if (data?.failed?.length) throw new Error('Cloudflare 上的视频没删掉，请重试');
    await must(supabase.from('episodes').delete().eq('id', id));
  },

  /** Deletes every episode (and its Cloudflare videos), then the series. */
  deleteSeries: async (seriesId: string, episodeIds: string[]) => {
    for (const id of episodeIds) await api.deleteEpisode(id);
    await must(supabase.from('series').delete().eq('id', seriesId));
  },

  deleteVideoAsset: async (assetId: string) => {
    const { error } = await supabase.functions.invoke('admin-video-delete', { body: { asset_id: assetId } });
    if (error) throw new Error(await errorMessage(error));
  },

  /** One-time resumable (tus) upload URL on Cloudflare for this episode. */
  createUpload: async (episodeId: string, file: File) => {
    const { data, error } = await supabase.functions.invoke('admin-video-upload', {
      body: { episode_id: episodeId, mode: 'tus', file_size: file.size, file_name: file.name },
    });
    if (error) throw new Error(await errorMessage(error));
    return data as { asset_id: string; uid: string; upload_url: string; mode: 'tus' };
  },

  setConfig: (key: string, value: unknown) => must(supabase.rpc('admin_set_config', { p_key: key, p_value: value })),

  resolveFlag: (id: number) => must(supabase.rpc('admin_resolve_abuse_flag', { p_flag_id: id })),

  blockUser: (userId: string, minutes: number, reason: string) =>
    must(supabase.rpc('admin_block_user', { p_user_id: userId, p_minutes: minutes, p_reason: reason })),
};
