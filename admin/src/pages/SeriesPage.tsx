import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Episode, type VideoAsset } from '../lib/api';
import type { EpisodeAccess } from '../lib/episodes';
import type { UploadJob } from '../lib/uploadJob';
import { useI18n } from '../lib/i18n';
import { ACCESS_KEYS, AccessBadge, Confirm, ErrorBox, fmtBytes, fmtDuration, Loading, Modal, useLoad, useToast, VideoBadge } from '../ui';
import { BulkUpload } from './BulkUpload';
import { PosterArt } from './SeriesListPage';
import { SeriesForm } from './SeriesForm';
import { useUploads, type Uploads } from './useUploads';

export function SeriesPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useI18n();
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
  if (!data?.series) return <ErrorBox message={t('sp.notFound')} />;
  const { series, episodes, videos } = data;

  const readyCount = episodes.filter((e) => videos.get(e.id)?.status === 'ready').length;
  const publishedCount = episodes.filter((e) => e.published).length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">
            <Link to="/series">{t('sp.crumb')}</Link> / {series.id}
          </div>
          <h1>{series.title}</h1>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setEditing(true)}>
            {t('sp.edit')}
          </button>
          <button className="btn danger" onClick={() => setDeleting(true)} disabled={uploads.busy}>
            {t('sp.deleteAll')}
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
              <dt>{t('sp.kvEpisodes')}</dt>
              <dt>{t('sp.kvVideos')}</dt>
              <dt>{t('sp.kvPublished')}</dt>
              <dt>{t('sp.kvRating')}</dt>
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
            toast.show(t('common.saved'));
            reload();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title={t('sp.deleteTitle')}
          danger
          confirmLabel={t('sp.deleteConfirm', { title: series.title })}
          body={
            <>
              {t('sp.deleteBody', { n: episodes.length })} <b>{t('sp.cannotUndo')}</b>
            </>
          }
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteSeries(series.id, episodes.map((e) => e.id));
            toast.show(t('common.deleted'));
            navigate('/series');
          }}
        />
      )}
    </>
  );
}

function JobProgress({ job, uploads }: { job: UploadJob; uploads: Uploads }) {
  const { t } = useI18n();
  const pct = job.file.size ? Math.round((job.sent / job.file.size) * 100) : 0;
  const label: Record<UploadJob['state'], string> = {
    queued: t('job.queued'),
    saving: t('job.saving'),
    uploading: t('job.uploading', { pct, sent: fmtBytes(job.sent), size: fmtBytes(job.file.size) }),
    processing: t('job.processing'),
    ready: t('job.ready'),
    failed: t('job.failed'),
    cancelled: t('job.cancelled'),
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
          {job.error ? t('common.withError', { label: label[job.state], error: job.error }) : label[job.state]}
        </span>
        {(job.state === 'queued' || job.state === 'uploading') && (
          <button className="btn ghost sm" onClick={() => uploads.cancel(job.episodeId)}>
            {t('common.cancel')}
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
  const { t } = useI18n();
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
      toast.show(t('ep.notReadyWarn'), 'err');
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
        <h2>{t('ep.title')}</h2>
        <span className="hint">{t('ep.hint')}</span>
        <div className="right">
          <button className="btn sm" onClick={onChanged}>
            {t('common.refresh')}
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
        <div className="empty">{t('ep.empty')}</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 64 }}>{t('ep.colEp')}</th>
                <th>{t('ep.colTitle')}</th>
                <th style={{ width: 110 }}>{t('ep.colAccess')}</th>
                <th style={{ width: 150 }}>{t('ep.colVideo')}</th>
                <th style={{ width: 70 }}>{t('ep.colPublished')}</th>
                <th style={{ width: 250 }}>{t('ep.colUpload')}</th>
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
                        aria-label={ep.published ? t('ep.unpublishAria') : t('ep.publishAria')}
                        disabled={toggling === ep.id}
                        onClick={() => togglePublish(ep)}
                      />
                    </td>
                    <td>{job ? <JobProgress job={job} uploads={uploads} /> : <span className="muted">—</span>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn ghost sm" onClick={() => setEditing(ep)}>
                        {t('common.edit')}
                      </button>
                      <button
                        className="btn ghost sm"
                        disabled={!!active}
                        onClick={() => {
                          replaceTarget.current = ep;
                          replaceInput.current?.click();
                        }}
                      >
                        {videos.get(ep.id) ? t('ep.replace') : t('ep.uploadVideo')}
                      </button>
                      <button className="btn ghost sm" style={{ color: 'var(--red)' }} disabled={!!active} onClick={() => setDeleting(ep)}>
                        {t('common.delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {orphanJobs.map((job) => (
                <tr key={job.episodeId}>
                  <td className="num">EP{String(job.number).padStart(2, '0')}</td>
                  <td className="muted">{t('ep.creating')}</td>
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
            toast.show(t('common.saved'));
            onChanged();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title={t('ep.deleteTitle', { n: deleting.number })}
          danger
          confirmLabel={t('common.delete')}
          body={t('ep.deleteBody')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteEpisode(deleting.id);
            toast.show(t('ep.deletedToast', { series: seriesId, n: deleting.number }));
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function EpisodeEditor({ episode, onClose, onSaved }: { episode: Episode; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(episode.title);
  const [access, setAccess] = useState<EpisodeAccess>(episode.access);
  const [price, setPrice] = useState(episode.coin_price ?? 20);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) return setError(t('ep.errTitle'));
    if (access === 'coin' && (!Number.isInteger(price) || price < 1)) return setError(t('ep.errPrice'));
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
      title={t('ep.editTitle', { n: episode.number })}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <label className="field">
          <span>{t('ep.colTitle')}</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="field">
          <span>{t('ep.fieldAccess')}</span>
          <div className="chips">
            {(Object.keys(ACCESS_KEYS) as EpisodeAccess[]).map((a) => (
              <button type="button" key={a} className={`chip ${access === a ? 'on' : ''}`} onClick={() => setAccess(a)}>
                {t(ACCESS_KEYS[a])}
              </button>
            ))}
          </div>
        </div>
        {access === 'coin' && (
          <label className="field">
            <span>{t('ep.fieldPrice')}</span>
            <input className="input mono" type="number" min={1} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </Modal>
  );
}
