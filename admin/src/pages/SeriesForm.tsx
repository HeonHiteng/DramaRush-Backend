import { useState } from 'react';
import { api, type Series } from '../lib/api';
import { SERIES_ID_RE, slugify } from '../lib/episodes';
import { useI18n } from '../lib/i18n';
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
  const { t } = useI18n();
  const [s, setS] = useState<Series>(initial ?? BLANK);
  const [idTouched, setIdTouched] = useState(false);
  const [castText, setCastText] = useState(castToText(s.cast_members));
  const [poster, setPoster] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof Series>(key: K, value: Series[K]) => setS((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setError(null);
    if (!s.title.trim()) return setError(t('form.errTitle'));
    if (!SERIES_ID_RE.test(s.id)) return setError(t('form.errId'));
    if (!s.synopsis.trim()) return setError(t('form.errSynopsis'));
    if (s.genres.length === 0) return setError(t('form.errGenre'));
    setBusy(true);
    try {
      const { poster_image_uri: _keep, ...row } = { ...s, title: s.title.trim(), synopsis: s.synopsis.trim(), cast_members: textToCast(castText) };
      void _keep;
      await api.saveSeries(row, isNew);
      if (poster) await api.uploadPoster(s.id, poster);
      onSaved(s.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes('duplicate key') ? t('form.errDuplicate') : msg);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? t('form.newTitle') : t('form.editTitle', { title: initial.title })}
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
        <div className="grid-2">
          <label className="field">
            <span>{t('form.title')}</span>
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
            <span>{t('form.id')}</span>
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
          <span>{t('form.synopsis')}</span>
          <textarea className="textarea" value={s.synopsis} onChange={(e) => set('synopsis', e.target.value)} />
        </label>

        <div className="field">
          <span>{t('form.genres')}</span>
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
            <span>{t('form.language')}</span>
            <select className="select" value={s.language} onChange={(e) => set('language', e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('form.status')}</span>
            <select className="select" value={s.status} onChange={(e) => set('status', e.target.value as Series['status'])}>
              <option value="ongoing">{t('form.ongoing')}</option>
              <option value="completed">{t('form.completed')}</option>
            </select>
          </label>
          <label className="field">
            <span>{t('form.rating')}</span>
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
            <span>{t('form.popularity')}</span>
            <input className="input mono" type="number" value={s.popularity} onChange={(e) => set('popularity', Math.round(Number(e.target.value)))} />
          </label>
        </div>

        <div className="grid-4">
          {(
            [
              ['poster_color_from', 'form.posterFrom'],
              ['poster_color_to', 'form.posterTo'],
              ['banner_color_from', 'form.bannerFrom'],
              ['banner_color_to', 'form.bannerTo'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="field">
              <span>{t(label)}</span>
              <input className="input" type="color" value={s[key]} onChange={(e) => set(key, e.target.value.toUpperCase())} style={{ height: 36, padding: 3 }} />
            </label>
          ))}
        </div>

        <div className="grid-2">
          <label className="field">
            <span>{t('form.cast')}</span>
            <textarea className="textarea mono" value={castText} onChange={(e) => setCastText(e.target.value)} placeholder="Elena Marsh | Wren Hale" />
          </label>
          <div className="stack" style={{ gap: 14 }}>
            <label className="field">
              <span>{t('form.poster')}</span>
              <input className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPoster(e.target.files?.[0] ?? null)} />
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" checked={s.is_new} onChange={(e) => set('is_new', e.target.checked)} />
              <span style={{ color: 'var(--text-2)', fontSize: 13 }}>{t('form.isNew')}</span>
            </label>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
      </div>
    </Modal>
  );
}
