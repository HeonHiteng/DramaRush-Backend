import { useState } from 'react';
import { api, type Series } from '../lib/api';
import { SERIES_ID_RE, slugify } from '../lib/episodes';
import { Modal } from '../ui';

/** Same lists the app filters by (DramaRush/src/types/content.ts). */
export const GENRES = ['Romance', 'Suspense', 'Revenge', 'Comedy', 'Fantasy', 'Youth', 'Mystery', 'Workplace'];
export const LANGUAGES = ['English', 'Spanish', 'Korean', 'Portuguese'];

const BLANK: Series = {
  id: '',
  title: '',
  synopsis: '',
  genres: [],
  rating: 4.5,
  status: 'ongoing',
  language: 'English',
  poster_color_from: '#3A1420',
  poster_color_to: '#7A1F2B',
  banner_color_from: '#4A0F1A',
  banner_color_to: '#8C2233',
  cast_members: [],
  popularity: 50,
  is_new: true,
  poster_image_uri: null,
};

function castToText(cast: Series['cast_members']): string {
  return cast.map((c) => `${c.name} | ${c.role}`).join('\n');
}

function textToCast(text: string): Series['cast_members'] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, role = ''] = line.split('|').map((s) => s.trim());
      return { name, role };
    });
}

export function SeriesForm({ initial, onClose, onSaved }: { initial?: Series; onClose: () => void; onSaved: (id: string) => void }) {
  const isNew = !initial;
  const [s, setS] = useState<Series>(initial ?? BLANK);
  const [idTouched, setIdTouched] = useState(false);
  const [castText, setCastText] = useState(castToText(s.cast_members));
  const [poster, setPoster] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Series>(key: K, value: Series[K]) => setS((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setError(null);
    if (!s.title.trim()) return setError('请填写剧名');
    if (!SERIES_ID_RE.test(s.id)) return setError('剧集 ID 只能用小写字母、数字和横线（2–60 个字符）');
    if (!s.synopsis.trim()) return setError('请填写简介');
    if (s.genres.length === 0) return setError('至少选一个类型');
    setBusy(true);
    try {
      const { poster_image_uri: _keep, ...row } = { ...s, title: s.title.trim(), synopsis: s.synopsis.trim(), cast_members: textToCast(castText) };
      void _keep;
      await api.saveSeries(row, isNew);
      if (poster) await api.uploadPoster(s.id, poster);
      onSaved(s.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes('duplicate key') ? '这个剧集 ID 已被占用，换一个' : msg);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? '新建剧集' : `编辑《${initial.title}》`}
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
        <div className="grid-2">
          <label className="field">
            <span>剧名</span>
            <input
              className="input"
              value={s.title}
              onChange={(e) => {
                set('title', e.target.value);
                if (isNew && !idTouched) set('id', slugify(e.target.value));
              }}
            />
          </label>
          <label className="field">
            <span>剧集 ID（网址里用，创建后不能改）</span>
            <input
              className="input mono"
              value={s.id}
              disabled={!isNew}
              onChange={(e) => {
                setIdTouched(true);
                set('id', e.target.value.toLowerCase());
              }}
            />
          </label>
        </div>

        <label className="field">
          <span>简介</span>
          <textarea className="textarea" value={s.synopsis} onChange={(e) => set('synopsis', e.target.value)} />
        </label>

        <div className="field">
          <span>类型</span>
          <div className="chips">
            {GENRES.map((g) => (
              <button
                type="button"
                key={g}
                className={`chip ${s.genres.includes(g) ? 'on' : ''}`}
                onClick={() => set('genres', s.genres.includes(g) ? s.genres.filter((x) => x !== g) : [...s.genres, g])}
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        <div className="grid-4">
          <label className="field">
            <span>语言</span>
            <select className="select" value={s.language} onChange={(e) => set('language', e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>状态</span>
            <select className="select" value={s.status} onChange={(e) => set('status', e.target.value as Series['status'])}>
              <option value="ongoing">连载中</option>
              <option value="completed">已完结</option>
            </select>
          </label>
          <label className="field">
            <span>评分（0–5）</span>
            <input
              className="input mono"
              type="number"
              step="0.1"
              min={0}
              max={5}
              value={s.rating}
              onChange={(e) => set('rating', Math.min(5, Math.max(0, Number(e.target.value))))}
            />
          </label>
          <label className="field">
            <span>热度（排序用）</span>
            <input className="input mono" type="number" value={s.popularity} onChange={(e) => set('popularity', Math.round(Number(e.target.value)))} />
          </label>
        </div>

        <div className="grid-4">
          {(
            [
              ['poster_color_from', '海报渐变 起'],
              ['poster_color_to', '海报渐变 止'],
              ['banner_color_from', '横幅渐变 起'],
              ['banner_color_to', '横幅渐变 止'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="field">
              <span>{label}</span>
              <input className="input" type="color" value={s[key]} onChange={(e) => set(key, e.target.value.toUpperCase())} style={{ height: 36, padding: 3 }} />
            </label>
          ))}
        </div>

        <div className="grid-2">
          <label className="field">
            <span>演员（每行一个：姓名 | 角色）</span>
            <textarea className="textarea mono" value={castText} onChange={(e) => setCastText(e.target.value)} placeholder="Elena Marsh | Wren Hale" />
          </label>
          <div className="stack" style={{ gap: 14 }}>
            <label className="field">
              <span>海报图片（可选，JPG/PNG/WebP，竖版 3:4）</span>
              <input className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPoster(e.target.files?.[0] ?? null)} />
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" checked={s.is_new} onChange={(e) => set('is_new', e.target.checked)} />
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>标记为「新剧」</span>
            </label>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
      </div>
    </Modal>
  );
}
