/**
 * Pure helpers for bulk uploads: map dropped files to episode numbers and
 * decide each new episode's paywall. Mirrors scripts/upload-series.js so the
 * console and the CLI name episodes the same way.
 */

export type EpisodeAccess = 'free' | 'coin' | 'subscriber' | 'ad_unlock';

/** ep01.mp4, EP 2.mov, episode-3.mkv, 004.mp4 … */
export const VIDEO_FILE_RE = /^(?:ep(?:isode)?[\s_-]*)?0*(\d{1,4})\.(mp4|mov|m4v|mkv|webm)$/i;

export interface MatchedFile<F> {
  file: F;
  number: number;
}

export interface FileMatchResult<F> {
  matched: MatchedFile<F>[];
  /** Files whose name doesn't look like an episode number. */
  unmatched: F[];
  /** Episode numbers that appear more than once (only the first file is kept). */
  duplicates: number[];
}

export function matchEpisodeFiles<F extends { name: string }>(files: F[]): FileMatchResult<F> {
  const byNumber = new Map<number, F>();
  const unmatched: F[] = [];
  const duplicates = new Set<number>();
  for (const file of files) {
    const base = file.name.split(/[\\/]/).pop() ?? file.name;
    const m = VIDEO_FILE_RE.exec(base);
    if (!m) {
      unmatched.push(file);
      continue;
    }
    const n = Number(m[1]);
    if (n < 1) {
      unmatched.push(file);
    } else if (byNumber.has(n)) {
      duplicates.add(n);
    } else {
      byNumber.set(n, file);
    }
  }
  const matched = [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([number, file]) => ({ number, file }));
  return { matched, unmatched, duplicates: [...duplicates].sort((a, b) => a - b) };
}

/** How new episodes are priced in a bulk upload. */
export interface PaywallRule {
  /** Episodes 1..freeCount are free. */
  freeCount: number;
  /** Episode numbers unlocked by watching an ad (parsed from "4, 6-7"). */
  adUnlock: number[];
  /** Everything else: coins at this price, or members-only when 'subscriber'. */
  rest: 'coin' | 'subscriber';
  coinPrice: number;
}

export function parseNumberList(input: string): number[] {
  const out = new Set<number>();
  for (const part of input.split(/[,，\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let n = a; n <= b && n - a < 2000; n++) out.add(n);
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part));
    } else {
      throw new Error(`无法识别 "${part}"，请用逗号分隔的集号或范围，如 4, 6-8`);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function accessFor(number: number, rule: PaywallRule): { access: EpisodeAccess; coinPrice: number | null } {
  if (number <= rule.freeCount) return { access: 'free', coinPrice: null };
  if (rule.adUnlock.includes(number)) return { access: 'ad_unlock', coinPrice: null };
  if (rule.rest === 'subscriber') return { access: 'subscriber', coinPrice: null };
  return { access: 'coin', coinPrice: rule.coinPrice };
}

export function episodeId(seriesId: string, number: number): string {
  return `${seriesId}-ep${number}`;
}

/** Series ids are URL slugs: lowercase letters, digits and dashes. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export const SERIES_ID_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
