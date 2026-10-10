import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { Episode, VideoAsset } from '../lib/api';
import { accessFor, episodeId, matchEpisodeFiles, parseNumberList, type PaywallRule } from '../lib/episodes';
import type { UploadJob } from '../lib/uploadJob';
import { useI18n } from '../lib/i18n';
import { ACCESS_KEYS, AccessBadge, fmtBytes, VideoBadge } from '../ui';
import type { Uploads } from './useUploads';

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

  const rows = match.matched.map(({ number, file }) => {
    const existing = byNumber.get(number);
    const id = episodeId(seriesId, number);
    const video = existing ? videos.get(existing.id) : undefined;
    const planned = rule ? accessFor(number, rule) : null;
    const skip = !!video && video.status === 'ready' && !reuploadReady;
    const willSetAccess = !existing || applyToExisting;
    return { number, file, id, existing, video, planned, skip, willSetAccess };
  });
  const toUpload = rows.filter((r) => !r.skip);
  const totalBytes = toUpload.reduce((sum, r) => sum + r.file.size, 0);

  const start = () => {
    if (!rule) return;
    uploads.enqueue(
      toUpload.map((r) => ({
        job: { episodeId: r.id, number: r.number, file: r.file, state: 'queued', sent: 0 } satisfies UploadJob,
        isNewEpisode: !r.existing,
        episodePatch: r.willSetAccess && r.planned ? { access: r.planned.access, coin_price: r.planned.coinPrice } : {},
        publishWhenReady: autoPublish,
      }))
    );
    setFiles([]);
  };

  const addFiles = (list: File[]) => setFiles((prev) => [...prev, ...list.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{t('bulk.title')}</h2>
        <span className="hint">{t('bulk.hint')}</span>
        {files.length > 0 && (
          <div className="right">
            <button className="btn ghost sm" onClick={() => setFiles([])}>
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
                    <th style={{ width: 120 }}>{t('bulk.colEpisode')}</th>
                    <th style={{ width: 140 }}>{t('ep.fieldAccess')}</th>
                    <th style={{ width: 130 }}>{t('bulk.colVideo')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ opacity: r.skip ? 0.45 : 1 }}>
                      <td className="num">EP{String(r.number).padStart(2, '0')}</td>
                      <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                        {r.file.name}
                        {r.skip && <span className="muted">{t('bulk.skip')}</span>}
                      </td>
                      <td className="num">{fmtBytes(r.file.size)}</td>
                      <td>{r.existing ? <span className="badge plain">{t('bulk.existing')}</span> : <span className="badge blue plain">{t('bulk.new')}</span>}</td>
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
              <button className="btn primary" disabled={!rule || toUpload.length === 0} onClick={start}>
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
