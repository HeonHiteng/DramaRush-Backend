/**
 * Pure helpers for bulk uploads: map dropped files to episode numbers and
 * decide each new episode's paywall. Mirrors scripts/upload-series.js so the
 * console and the CLI name episodes the same way.
 */

import { t } from './i18n';

export type EpisodeAccess = 'free' | 'coin' | 'subscriber' | 'ad_unlock';

/** ep01.mp4, EP 2.mov, episode-3.mkv, 004.mp4 … (same as scripts/upload-series.js) */
export const VIDEO_FILE_RE = /^(?:ep(?:isode)?[\s_-]*)?0*(\d{1,4})\.(mp4|mov|m4v|mkv|webm)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|webm)$/i;

/**
 * Looser forms inside longer names, tried when VIDEO_FILE_RE doesn't match:
 * Chinese "di 3 ji / di 03 hua" (written as escapes), S01E03, EP03_title.
 */
const LOOSE_NUMBER_RES = [
  /\u7b2c\s*0*(\d{1,4})\s*[\u96c6\u8bdd\u8a71]/,
  /s\d{1,2}[\s._-]*e0*(\d{1,4})(?!\d)/i,
  /(?:^|[^a-z])ep(?:isode)?[\s._-]*0*(\d{1,4})(?!\d)/i,
];

/** The episode number in a video file name, or null when there isn't one. */
export function episodeNumberFromName(name: string): number | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (!VIDEO_EXT_RE.test(base)) return null;
  for (const re of [VIDEO_FILE_RE, ...LOOSE_NUMBER_RES]) {
    const m = re.exec(base);
    if (m && Number(m[1]) >= 1) return Number(m[1]);
  }
  return null;
}

export interface MatchedFile<F> {
  file: F;
  number: number;
}

export interface FileMatchResult<F> {
  matched: MatchedFile<F>[];
  /** Videos with no episode number in the name, sorted by name; the admin numbers them. */
  unnumbered: F[];
  /** Files that aren't videos (posters, subtitles…); ignored. */
  unmatched: F[];
  /** Episode numbers that appear more than once (only the first file is kept). */
  duplicates: number[];
}

export function matchEpisodeFiles<F extends { name: string }>(files: F[]): FileMatchResult<F> {
  const byNumber = new Map<number, F>();
  const unnumbered: F[] = [];
  const unmatched: F[] = [];
  const duplicates = new Set<number>();
  for (const file of files) {
    const n = episodeNumberFromName(file.name);
    if (n !== null) {
      if (byNumber.has(n)) duplicates.add(n);
      else byNumber.set(n, file);
    } else if (VIDEO_EXT_RE.test(file.name)) {
      unnumbered.push(file);
    } else {
      unmatched.push(file);
    }
  }
  const matched = [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([number, file]) => ({ number, file }));
  unnumbered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { matched, unnumbered, unmatched, duplicates: [...duplicates].sort((a, b) => a - b) };
}

/** Next free numbers after everything already taken, one per file. */
export function suggestNumbers(count: number, taken: Iterable<number>): number[] {
  let next = 1;
  for (const n of taken) next = Math.max(next, n + 1);
  return Array.from({ length: count }, (_, i) => next + i);
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
  for (const part of input.split(/[,\uff0c\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let n = a; n <= b && n - a < 2000; n++) out.add(n);
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part));
    } else {
      throw new Error(t('bulk.badList', { part }));
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
