import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Series } from '../lib/api';
import { ErrorBox, Loading, useLoad } from '../ui';
import { SeriesForm } from './SeriesForm';

export function SeriesListPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useLoad(async () => {
    const [series, counts] = await Promise.all([api.seriesList(), api.episodeCounts()]);
    return { series, counts };
  }, []);

  const list = (data?.series ?? []).filter((s) => !query || s.title.toLowerCase().includes(query.toLowerCase()) || s.id.includes(query.toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">Library</div>
          <h1>剧集与上传</h1>
        </div>
        <div className="actions">
          <input className="input" style={{ width: 220 }} placeholder="搜索剧名或 ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn primary" onClick={() => setCreating(true)}>
            ＋ 新建剧集
          </button>
        </div>
      </div>

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : list.length === 0 ? (
        <div className="panel empty">{query ? '没有匹配的剧集' : '还没有剧集，先新建一部再上传视频。'}</div>
      ) : (
        <div className="series-grid">
          {list.map((s, i) => (
            <SeriesCard key={s.id} series={s} counts={data!.counts.get(s.id)} delay={i * 0.03} />
          ))}
        </div>
      )}

      {creating && <SeriesForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/series/${id}`)} />}
    </>
  );
}

export function PosterArt({ series }: { series: Series }) {
  return (
    <div className="poster" style={{ background: `linear-gradient(160deg, ${series.poster_color_from}, ${series.poster_color_to})` }}>
      {series.poster_image_uri && <img src={series.poster_image_uri} alt="" />}
      {!series.poster_image_uri && <div className="title-on">{series.title}</div>}
    </div>
  );
}

function SeriesCard({ series, counts, delay }: { series: Series; counts?: { total: number; published: number }; delay: number }) {
  return (
    <Link to={`/series/${series.id}`} className="series-card" style={{ animationDelay: `${delay}s` }}>
      <PosterArt series={series} />
      <div className="meta">
        <strong>{series.title}</strong>
        <div className="row">
          <span className="mono">
            {counts?.published ?? 0}/{counts?.total ?? 0} 集已发布
          </span>
          {series.is_new && <span className="badge coral plain" style={{ color: 'var(--coral)', borderColor: 'rgba(255,90,95,.4)' }}>NEW</span>}
        </div>
        <div className="row muted mono" style={{ fontSize: 11 }}>
          {series.id}
        </div>
      </div>
    </Link>
  );
}
