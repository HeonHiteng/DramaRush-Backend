import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Episode, type VideoAsset } from '../lib/api';
import type { EpisodeAccess } from '../lib/episodes';
import type { UploadJob } from '../lib/uploadJob';
import { ACCESS_LABEL, AccessBadge, Confirm, ErrorBox, fmtBytes, fmtDuration, Loading, Modal, useLoad, useToast, VideoBadge } from '../ui';
import { BulkUpload } from './BulkUpload';
import { PosterArt } from './SeriesListPage';
import { SeriesForm } from './SeriesForm';
import { useUploads, type Uploads } from './useUploads';

export function SeriesPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data, error, loading, reload } = useLoad(async () => {
    const [series, episodes] = await Promise.all([api.series(id), api.episodes(id)]);
    const videos = await api.videos(episodes.map((e) => e.id));
    return { series, episodes, videos };
  }, [id]);
  const uploads = useUploads(id, reload);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data?.series) return <ErrorBox message="找不到这部剧" />;
  const { series, episodes, videos } = data;

  const readyCount = episodes.filter((e) => videos.get(e.id)?.status === 'ready').length;
  const publishedCount = episodes.filter((e) => e.published).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">
            <Link to="/series">剧集</Link> / {series.id}
          </div>
          <h1>{series.title}</h1>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setEditing(true)}>
            编辑剧集信息
          </button>
          <button className="btn danger" onClick={() => setDeleting(true)} disabled={uploads.busy}>
            删除整部剧
          </button>
        </div>
      </div>

      <div className="stack">
        <div className="series-hero">
          <PosterArt series={series} />
          <div>
            <p className="dim" style={{ marginTop: 0, maxWidth: 760 }}>
              {series.synopsis}
            </p>
            <div className="chips">
              {series.genres.map((g) => (
                <span key={g} className="badge plain">
                  {g}
                </span>
              ))}
            </div>
            <dl className="kv">
              <dt>集数</dt>
              <dt>已有视频</dt>
              <dt>已发布</dt>
              <dt>评分 · 热度</dt>
              <dd>{episodes.length}</dd>
              <dd>{readyCount}</dd>
              <dd>{publishedCount}</dd>
              <dd>
                {series.rating} · {series.popularity}
              </dd>
            </dl>
          </div>
        </div>

        <BulkUpload seriesId={series.id} episodes={episodes} videos={videos} uploads={uploads} />

        <EpisodeTable seriesId={series.id} episodes={episodes} videos={videos} uploads={uploads} onChanged={reload} />
      </div>

      {editing && (
        <SeriesForm
          initial={series}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast.show('已保存');
            reload();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="删除整部剧？"
          danger
          confirmLabel={`删除《${series.title}》`}
          body={
            <>
              会删除这部剧的 {episodes.length} 集和它们在 Cloudflare 上的全部视频，用户的解锁记录也会一起消失。<b>无法恢复。</b>
            </>
          }
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteSeries(series.id, episodes.map((e) => e.id));
            toast.show('已删除');
            navigate('/series');
          }}
        />
      )}
    </>
  );
}

function JobProgress({ job, uploads }: { job: UploadJob; uploads: Uploads }) {
  const pct = job.file.size ? Math.round((job.sent / job.file.size) * 100) : 0;
  const label: Record<UploadJob['state'], string> = {
    queued: '排队中',
    saving: '保存剧集…',
    uploading: `上传 ${pct}% · ${fmtBytes(job.sent)} / ${fmtBytes(job.file.size)}`,
    processing: 'Cloudflare 处理中…',
    ready: '完成',
    failed: '失败',
    cancelled: '已取消',
  };
  const done = job.state === 'ready';
  const fail = job.state === 'failed' || job.state === 'cancelled';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 220 }}>
      <div className={`reel ${done ? 'done' : ''} ${fail ? 'fail' : ''}`}>
        <i style={{ width: `${job.state === 'processing' || done ? 100 : pct}%` }} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
        <span className={`mono ${fail ? 'error-text' : 'dim'}`} style={{ fontSize: 12 }}>
          {label[job.state]}
          {job.error && `：${job.error}`}
        </span>
        {(job.state === 'queued' || job.state === 'uploading') && (
          <button className="btn ghost sm" onClick={() => uploads.cancel(job.episodeId)}>
            取消
          </button>
        )}
        {(done || fail) && (
          <button className="btn ghost sm" onClick={() => uploads.dismiss(job.episodeId)}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function EpisodeTable({
  seriesId,
  episodes,
  videos,
  uploads,
  onChanged,
}: {
  seriesId: string;
  episodes: Episode[];
  videos: Map<string, VideoAsset>;
  uploads: Uploads;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<Episode | null>(null);
  const [deleting, setDeleting] = useState<Episode | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<Episode | null>(null);

  // Jobs for episodes that don't exist yet (being created by a bulk upload).
  const known = new Set(episodes.map((e) => e.id));
  const orphanJobs = Object.values(uploads.jobs).filter((j) => !known.has(j.episodeId));

  const togglePublish = async (ep: Episode) => {
    if (!ep.published && videos.get(ep.id)?.status !== 'ready') {
      toast.show('这集还没有就绪的视频，发布后用户会看到「即将上线」。', 'err');
    }
    setToggling(ep.id);
    try {
      await api.updateEpisode(ep.id, { published: !ep.published });
      onChanged();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setToggling(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>单集</h2>
        <span className="hint">未发布的集用户看不到；视频要「就绪」才能播放</span>
        <div className="right">
          <button className="btn sm" onClick={onChanged}>
            刷新
          </button>
        </div>
      </div>
      <input
        ref={replaceInput}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          const ep = replaceTarget.current;
          e.target.value = '';
          if (!file || !ep) return;
          uploads.enqueue([
            {
              job: { episodeId: ep.id, number: ep.number, file, state: 'queued', sent: 0 },
              isNewEpisode: false,
              episodePatch: {},
              publishWhenReady: false,
            },
          ]);
        }}
      />
      {episodes.length === 0 && orphanJobs.length === 0 ? (
        <div className="empty">还没有单集。把视频拖到上面的「批量上传」即可自动建集。</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 64 }}>集</th>
                <th>标题</th>
                <th style={{ width: 110 }}>付费</th>
                <th style={{ width: 150 }}>视频</th>
                <th style={{ width: 70 }}>发布</th>
                <th style={{ width: 250 }}>上传</th>
                <th style={{ width: 210 }} />
              </tr>
            </thead>
            <tbody>
              {episodes.map((ep) => {
                const job = uploads.jobs[ep.id];
                const active = job && !['ready', 'failed', 'cancelled'].includes(job.state);
                return (
                  <tr key={ep.id}>
                    <td className="num">EP{String(ep.number).padStart(2, '0')}</td>
                    <td>
                      {ep.title}
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {fmtDuration(ep.duration_sec)}
                      </div>
                    </td>
                    <td>
                      <AccessBadge access={ep.access} coinPrice={ep.coin_price} />
                    </td>
                    <td>
                      <VideoBadge video={videos.get(ep.id)} />
                    </td>
                    <td>
                      <button
                        className={`toggle ${ep.published ? 'on' : ''}`}
                        aria-label={ep.published ? '已发布，点击取消发布' : '草稿，点击发布'}
                        disabled={toggling === ep.id}
                        onClick={() => togglePublish(ep)}
                      />
                    </td>
                    <td>{job ? <JobProgress job={job} uploads={uploads} /> : <span className="muted">—</span>}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn ghost sm" onClick={() => setEditing(ep)}>
                        编辑
                      </button>
                      <button
                        className="btn ghost sm"
                        disabled={!!active}
                        onClick={() => {
                          replaceTarget.current = ep;
                          replaceInput.current?.click();
                        }}
                      >
                        {videos.get(ep.id) ? '替换视频' : '上传视频'}
                      </button>
                      <button className="btn ghost sm" style={{ color: 'var(--red)' }} disabled={!!active} onClick={() => setDeleting(ep)}>
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
              {orphanJobs.map((job) => (
                <tr key={job.episodeId}>
                  <td className="num">EP{String(job.number).padStart(2, '0')}</td>
                  <td className="muted">新建中…</td>
                  <td />
                  <td />
                  <td />
                  <td>
                    <JobProgress job={job} uploads={uploads} />
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EpisodeEditor
          episode={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.show('已保存');
            onChanged();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title={`删除第 ${deleting.number} 集？`}
          danger
          confirmLabel="删除"
          body="会同时删掉它在 Cloudflare 上的视频（停止计费），用户对这集的解锁记录也会消失。无法恢复。"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteEpisode(deleting.id);
            toast.show(`已删除 ${seriesId} 第 ${deleting.number} 集`);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function EpisodeEditor({ episode, onClose, onSaved }: { episode: Episode; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(episode.title);
  const [access, setAccess] = useState<EpisodeAccess>(episode.access);
  const [price, setPrice] = useState(episode.coin_price ?? 20);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) return setError('请填写标题');
    if (access === 'coin' && (!Number.isInteger(price) || price < 1)) return setError('金币价格要是正整数');
    setBusy(true);
    try {
      await api.updateEpisode(episode.id, { title: title.trim(), access, coin_price: access === 'coin' ? price : null });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      small
      title={`编辑第 ${episode.number} 集`}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <label className="field">
          <span>标题</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="field">
          <span>付费方式</span>
          <div className="chips">
            {(Object.keys(ACCESS_LABEL) as EpisodeAccess[]).map((a) => (
              <button type="button" key={a} className={`chip ${access === a ? 'on' : ''}`} onClick={() => setAccess(a)}>
                {ACCESS_LABEL[a]}
              </button>
            ))}
          </div>
        </div>
        {access === 'coin' && (
          <label className="field">
            <span>金币价格</span>
            <input className="input mono" type="number" min={1} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </Modal>
  );
}
