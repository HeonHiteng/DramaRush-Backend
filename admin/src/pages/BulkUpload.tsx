import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Episode, VideoAsset } from '../lib/api';
import { accessFor, episodeId, matchEpisodeFiles, parseNumberList, suggestNumbers, type PaywallRule } from '../lib/episodes';
import type { UploadJob } from '../lib/uploadJob';
import { useI18n } from '../lib/i18n';
import { orientationOf, probeVideoSize } from '../lib/videoSize';
import { ACCESS_KEYS, AccessBadge, fmtBytes, OrientationTag, VideoBadge } from '../ui';
import type { Uploads } from './useUploads';

/** Same file dropped again → same key (also used for typed episode numbers). */
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

/** Collects files from a drop, including whole folders. */
async function filesFromDrop(e: DragEvent): Promise<File[]> {
  const items = [...e.dataTransfer.items];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (entries.length === 0) return [...e.dataTransfer.files];
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child);
      } while (batch.length > 0);
    }
  };
  for (const entry of entries) await walk(entry);
  return out;
}

export function BulkUpload({
  seriesId,
  episodes,
  videos,
  uploads,
}: {
  seriesId: string;
  episodes: Episode[];
  videos: Map<string, VideoAsset>;
  uploads: Uploads;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [freeCount, setFreeCount] = useState(3);
  const [adText, setAdText] = useState('');
  const [rest, setRest] = useState<'coin' | 'subscriber'>('coin');
  const [coinPrice, setCoinPrice] = useState(20);
  const [applyToExisting, setApplyToExisting] = useState(false);
  const [reuploadReady, setReuploadReady] = useState(false);
  const [autoPublish, setAutoPublish] = useState(true);
  /** Episode numbers typed for files whose names have none (by fileKey). */
  const [manualNumbers, setManualNumbers] = useState<Record<string, string>>({});
  /** Picture size read locally from each dropped video (null = couldn't tell). */
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number } | null>>({});

  // Read each new file's picture size in the browser, a few at a time.
  useEffect(() => {
    const todo = files.filter((f) => !(fileKey(f) in sizes));
    if (todo.length === 0) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < todo.length && !cancelled; i += 3) {
        const batch = todo.slice(i, i + 3);
        const found = await Promise.all(batch.map((f) => probeVideoSize(f)));
        if (!cancelled) setSizes((prev) => ({ ...prev, ...Object.fromEntries(batch.map((f, j) => [fileKey(f), found[j]])) }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const byNumber = useMemo(() => new Map(episodes.map((e) => [e.number, e])), [episodes]);
  const match = useMemo(() => matchEpisodeFiles(files), [files]);

  let rule: PaywallRule | null = null;
  let ruleError: string | null = null;
  try {
    rule = { freeCount: Math.max(0, freeCount), adUnlock: parseNumberList(adText), rest, coinPrice: Math.max(1, coinPrice) };
  } catch (e) {
    ruleError = e instanceof Error ? e.message : String(e);
  }

  // Videos without a number in the name get the next free numbers, editable per file.
  const suggested = suggestNumbers(match.unnumbered.length, [...episodes.map((e) => e.number), ...match.matched.map((m) => m.number)]);
  const entries = [
    ...match.matched.map(({ number, file }) => ({ file, number: number as number | null, text: null as string | null })),
    ...match.unnumbered.map((file, i) => {
      const text = manualNumbers[fileKey(file)] ?? String(suggested[i]);
      const n = /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : 0;
      return { file, number: n >= 1 ? n : null, text };
    }),
  ];
  const counts = new Map<number, number>();
  for (const e of entries) if (e.number !== null) counts.set(e.number, (counts.get(e.number) ?? 0) + 1);
  const clashes = [...counts].filter(([, c]) => c > 1).map(([n]) => n);
  const numberError = entries.some((e) => e.number === null)
    ? t('bulk.numberInvalid')
    : clashes.length > 0
      ? t('bulk.numberClash', { list: clashes.join(', ') })
      : null;

  const rows = entries
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
    .map(({ file, number, text }) => {
      const existing = number !== null ? byNumber.get(number) : undefined;
      const id = number !== null ? episodeId(seriesId, number) : null;
      const video = existing ? videos.get(existing.id) : undefined;
      const planned = rule && number !== null ? accessFor(number, rule) : null;
      const skip = !!video && video.status === 'ready' && !reuploadReady;
      const willSetAccess = !existing || applyToExisting;
      return { key: fileKey(file), number, text, file, id, existing, video, planned, skip, willSetAccess };
    });
  const landscapeCount = rows.filter((r) => !r.skip && orientationOf(sizes[r.key]?.width, sizes[r.key]?.height) === 'landscape').length;
  const toUpload = rows.filter((r): r is typeof r & { number: number; id: string } => !r.skip && r.number !== null && r.id !== null);
  const totalBytes = toUpload.reduce((sum, r) => sum + r.file.size, 0);

  const start = () => {
    if (!rule || numberError) return;
    uploads.enqueue(
      toUpload.map((r) => ({
        job: { episodeId: r.id, number: r.number, file: r.file, state: 'queued', sent: 0 } satisfies UploadJob,
        isNewEpisode: !r.existing,
        episodePatch: r.willSetAccess && r.planned ? { access: r.planned.access, coin_price: r.planned.coinPrice } : {},
        publishWhenReady: autoPublish,
      }))
    );
    clearFiles();
  };

  const clearFiles = () => {
    setFiles([]);
    setManualNumbers({});
    setSizes({});
  };

  const addFiles = (list: File[]) => setFiles((prev) => [...prev, ...list.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('bulk.title')}</h2>
        <span className="hint">{t('bulk.hint')}</span>
        {files.length > 0 && (
          <div className="right">
            <button className="btn ghost sm" onClick={clearFiles}>
              {t('bulk.clear')}
            </button>
          </div>
        )}
      </div>
      <div className="panel-body stack" style={{ gap: 16 }}>
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setOver(false);
            addFiles(await filesFromDrop(e));
          }}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
        >
          <h3>{t('bulk.drop')}</h3>
          <p>
            {t('bulk.dropFolders')}{' '}
            <button
              type="button"
              className="btn ghost sm"
              onClick={(e) => {
                e.stopPropagation();
                folderInput.current?.click();
              }}
            >
              {t('bulk.chooseFolder')}
            </button>{' '}
            · {t('bulk.resumable')}
          </p>
          <input ref={fileInput} type="file" accept="video/*" multiple hidden onChange={(e) => addFiles([...(e.target.files ?? [])])} />
          <input
            ref={folderInput}
            type="file"
            hidden
            multiple
            {...({ webkitdirectory: '' } as Record<string, string>)}
            onChange={(e) => addFiles([...(e.target.files ?? [])])}
          />
        </div>

        {files.length > 0 && (
          <>
            <div className="grid-4">
              <label className="field">
                <span>{t('bulk.freeCount')}</span>
                <input className="input mono" type="number" min={0} value={freeCount} onChange={(e) => setFreeCount(Number(e.target.value))} />
              </label>
              <label className="field">
                <span>{t('bulk.adEpisodes')}</span>
                <input className="input mono" value={adText} onChange={(e) => setAdText(e.target.value)} placeholder={t('bulk.adPlaceholder')} />
              </label>
              <label className="field">
                <span>{t('bulk.rest')}</span>
                <select className="select" value={rest} onChange={(e) => setRest(e.target.value as 'coin' | 'subscriber')}>
                  <option value="coin">{t('access.coin')}</option>
                  <option value="subscriber">{t('access.subscriber')}</option>
                </select>
              </label>
              <label className="field">
                <span>{t('bulk.coinPrice')}</span>
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  value={coinPrice}
                  disabled={rest !== 'coin'}
                  onChange={(e) => setCoinPrice(Number(e.target.value))}
                />
              </label>
            </div>
            {ruleError && <p className="error-text">{ruleError}</p>}

            <div className="chips" style={{ gap: 18 }}>
              <label className="dim" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)} />
                {t('bulk.autoPublish')}
              </label>
              <label className="dim" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={applyToExisting} onChange={(e) => setApplyToExisting(e.target.checked)} />
                {t('bulk.applyExisting')}
              </label>
              <label className="dim" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={reuploadReady} onChange={(e) => setReuploadReady(e.target.checked)} />
                {t('bulk.reupload')}
              </label>
            </div>

            <div className="panel table-wrap" style={{ boxShadow: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>{t('ep.colEp')}</th>
                    <th>{t('bulk.colFile')}</th>
                    <th style={{ width: 100 }}>{t('bulk.colSize')}</th>
                    <th style={{ width: 150 }}>{t('bulk.colPicture')}</th>
                    <th style={{ width: 120 }}>{t('bulk.colEpisode')}</th>
                    <th style={{ width: 140 }}>{t('ep.fieldAccess')}</th>
                    <th style={{ width: 130 }}>{t('bulk.colVideo')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} style={{ opacity: r.skip ? 0.45 : 1 }}>
                      <td className="num">
                        {r.text !== null ? (
                          <input
                            className={`input mono ${r.number === null || (r.number !== null && clashes.includes(r.number)) ? 'invalid' : ''}`}
                            style={{ width: 64, padding: '4px 8px' }}
                            inputMode="numeric"
                            value={r.text}
                            aria-label={t('bulk.numberAria', { file: r.file.name })}
                            onChange={(e) => {
                              const value = e.target.value;
                              setManualNumbers((prev) => ({ ...prev, [r.key]: value }));
                            }}
                          />
                        ) : (
                          `EP${String(r.number).padStart(2, '0')}`
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                        {r.file.name}
                        {r.skip && <span className="muted">{t('bulk.skip')}</span>}
                      </td>
                      <td className="num">{fmtBytes(r.file.size)}</td>
                      <td>
                        {r.key in sizes ? (
                          sizes[r.key] ? <OrientationTag width={sizes[r.key]!.width} height={sizes[r.key]!.height} /> : <span className="muted">—</span>
                        ) : (
                          <span className="muted">…</span>
                        )}
                      </td>
                      <td>
                        {r.number === null ? null : r.existing ? (
                          <span className="badge plain">{t('bulk.existing')}</span>
                        ) : (
                          <span className="badge blue plain">{t('bulk.new')}</span>
                        )}
                      </td>
                      <td>
                        {r.willSetAccess && r.planned ? (
                          <AccessBadge access={r.planned.access} coinPrice={r.planned.coinPrice} />
                        ) : r.existing ? (
                          <span className="muted" title={t('bulk.unchangedTitle')}>
                            {t('bulk.unchanged', { access: t(ACCESS_KEYS[r.existing.access]) })}
                          </span>
                        ) : null}
                      </td>
                      <td>{r.existing ? <VideoBadge video={r.video} /> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {match.unnumbered.length > 0 && <p className="dim" style={{ margin: 0, fontSize: 13 }}>{t('bulk.unnumbered', { n: match.unnumbered.length })}</p>}
            {landscapeCount > 0 && <p className="warn-text">{t('bulk.landscapeWarn', { n: landscapeCount })}</p>}
            {numberError && <p className="error-text" style={{ margin: 0 }}>{numberError}</p>}

            {(match.unmatched.length > 0 || match.duplicates.length > 0) && (
              <p className="dim" style={{ margin: 0, fontSize: 13 }}>
                {match.unmatched.length > 0 && (
                  <>
                    {t('bulk.unmatched', { n: match.unmatched.length })}
                    <span className="mono">{match.unmatched.slice(0, 5).map((f) => f.name).join(t('bulk.listSep'))}</span>
                    {match.unmatched.length > 5 && ' …'}
                  </>
                )}
                {match.duplicates.length > 0 && t('bulk.duplicates', { list: match.duplicates.join(', ') })}
              </p>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <button className="btn primary" disabled={!rule || !!numberError || toUpload.length === 0} onClick={start}>
                {t('bulk.start', { n: toUpload.length, size: fmtBytes(totalBytes) })}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {t('bulk.note')}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
