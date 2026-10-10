import { useMemo, useRef, useState, type DragEvent } from 'react';
import type { Episode, VideoAsset } from '../lib/api';
import { accessFor, episodeId, matchEpisodeFiles, parseNumberList, type PaywallRule } from '../lib/episodes';
import type { UploadJob } from '../lib/uploadJob';
import { ACCESS_LABEL, AccessBadge, fmtBytes, VideoBadge } from '../ui';
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
        <h2>批量上传</h2>
        <span className="hint">文件名带集号即可：ep01.mp4、EP 2.mov、003.mp4…</span>
        {files.length > 0 && (
          <div className="right">
            <button className="btn ghost sm" onClick={() => setFiles([])}>
              清空
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
          <h3>把整部剧的视频拖到这里</h3>
          <p>
            可以拖文件夹 · 或{' '}
            <button
              type="button"
              className="btn ghost sm"
              onClick={(e) => {
                e.stopPropagation();
                folderInput.current?.click();
              }}
            >
              选择文件夹
            </button>{' '}
            · 支持大文件和断点续传
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
                <span>前几集免费</span>
                <input className="input mono" type="number" min={0} value={freeCount} onChange={(e) => setFreeCount(Number(e.target.value))} />
              </label>
              <label className="field">
                <span>看广告解锁的集（如 4, 6-7）</span>
                <input className="input mono" value={adText} onChange={(e) => setAdText(e.target.value)} placeholder="留空 = 没有" />
              </label>
              <label className="field">
                <span>其余集</span>
                <select className="select" value={rest} onChange={(e) => setRest(e.target.value as 'coin' | 'subscriber')}>
                  <option value="coin">金币解锁</option>
                  <option value="subscriber">会员专享</option>
                </select>
              </label>
              <label className="field">
                <span>金币价格</span>
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
                处理完自动发布
              </label>
              <label className="dim" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={applyToExisting} onChange={(e) => setApplyToExisting(e.target.checked)} />
                已有的集也按上面的规则改付费方式
              </label>
              <label className="dim" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={reuploadReady} onChange={(e) => setReuploadReady(e.target.checked)} />
                已有视频的集也重新上传（替换旧视频）
              </label>
            </div>

            <div className="panel table-wrap" style={{ boxShadow: 'none' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>集</th>
                    <th>文件</th>
                    <th style={{ width: 100 }}>大小</th>
                    <th style={{ width: 120 }}>剧集</th>
                    <th style={{ width: 140 }}>付费方式</th>
                    <th style={{ width: 130 }}>现有视频</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ opacity: r.skip ? 0.45 : 1 }}>
                      <td className="num">EP{String(r.number).padStart(2, '0')}</td>
                      <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                        {r.file.name}
                        {r.skip && <span className="muted"> · 已有视频，跳过</span>}
                      </td>
                      <td className="num">{fmtBytes(r.file.size)}</td>
                      <td>{r.existing ? <span className="badge plain">已有</span> : <span className="badge blue plain">新建</span>}</td>
                      <td>
                        {r.willSetAccess && r.planned ? (
                          <AccessBadge access={r.planned.access} coinPrice={r.planned.coinPrice} />
                        ) : r.existing ? (
                          <span className="muted" title="保持不变">
                            {ACCESS_LABEL[r.existing.access]}（不变）
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
                    忽略 {match.unmatched.length} 个认不出集号的文件：
                    <span className="mono">{match.unmatched.slice(0, 5).map((f) => f.name).join('、')}</span>
                    {match.unmatched.length > 5 && ' …'}
                  </>
                )}
                {match.duplicates.length > 0 && <> · 集号重复（只取第一个）：{match.duplicates.join(', ')}</>}
              </p>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <button className="btn primary" disabled={!rule || toUpload.length === 0} onClick={start}>
                开始上传 {toUpload.length} 集 · {fmtBytes(totalBytes)}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                同时传 2 集；上传中请别关闭这个页面（关了也能重新拖入同样的文件继续传）。
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
