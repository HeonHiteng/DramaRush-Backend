import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { EpisodeAccess } from './lib/episodes';
import type { VideoAsset } from './lib/api';
import { currentLocale, t, useI18n, type MsgKey } from './lib/i18n';
import { orientationOf } from './lib/videoSize';

// ---------------------------------------------------------------- format

export function fmtDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return '—';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  // Show the year only when it isn't this year (e.g. a membership ending next year).
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {};
  return d.toLocaleString(currentLocale(), { ...year, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function fmtNumber(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

export const ACCESS_KEYS: Record<EpisodeAccess, MsgKey> = {
  free: 'access.free',
  coin: 'access.coin',
  ad_unlock: 'access.ad_unlock',
  subscriber: 'access.subscriber',
};

export function accessLabel(access: EpisodeAccess): string {
  return t(ACCESS_KEYS[access]);
}

export function AccessBadge({ access, coinPrice }: { access: EpisodeAccess; coinPrice: number | null }) {
  const { t } = useI18n();
  if (access === 'coin') return <span className="badge gold plain mono">🪙 {coinPrice}</span>;
  if (access === 'free') return <span className="badge green plain">{t('badge.free')}</span>;
  if (access === 'subscriber') return <span className="badge blue plain">{t('badge.member')}</span>;
  return <span className="badge amber plain">{t('badge.ad')}</span>;
}

export function VideoBadge({ video }: { video: VideoAsset | undefined }) {
  const { t } = useI18n();
  if (!video) return <span className="badge">{t('video.none')}</span>;
  if (video.status === 'ready') return <span className="badge green">{t('video.ready', { duration: fmtDuration(video.duration_sec) })}</span>;
  if (video.status === 'error')
    return (
      <span className="badge red" title={video.error_reason ?? ''}>
        {t('video.failed')}
      </span>
    );
  if (video.status === 'pending_upload') return <span className="badge amber pulse">{t('video.pending')}</span>;
  return <span className="badge amber pulse">{t('video.processing')}</span>;
}

/** Landscape / portrait tag with the picture size; landscape is highlighted (black bars in the app). */
export function OrientationTag({ width, height }: { width: number | null | undefined; height: number | null | undefined }) {
  const { t } = useI18n();
  const o = orientationOf(width, height);
  if (!o) return null;
  return (
    <span className={`badge plain ${o === 'landscape' ? 'amber' : ''}`} title={`${width}×${height}`}>
      {t(o === 'landscape' ? 'video.landscape' : o === 'portrait' ? 'video.portrait' : 'video.square')} <span className="mono">{width}×{height}</span>
    </span>
  );
}

// ---------------------------------------------------------------- toast

interface ToastState {
  show: (text: string, kind?: 'ok' | 'err') => void;
}
const ToastContext = createContext<ToastState>({ show: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err'; id: number } | null>(null);
  const show = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => setToast({ text, kind, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'err' ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast && (
        <div key={toast.id} className={`toast ${toast.kind === 'err' ? 'err' : ''}`} role="status">
          {toast.text}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---------------------------------------------------------------- modal

export function Modal({
  title,
  onClose,
  children,
  footer,
  small,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  small?: boolean;
}) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${small ? 'sm' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          <h2>{title}</h2>
          <div className="right">
            <button className="btn ghost sm" onClick={onClose} aria-label={t('common.close')}>
              ✕
            </button>
          </div>
        </div>
        <div className="panel-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      small
      title={title}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            }}
          >
            {busy ? t('common.working') : confirmLabel}
          </button>
        </>
      }
    >
      <div className="dim">{body}</div>
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- data hook

/** Tiny loader: { data, error, loading, reload }. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    load()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((e) => alive && setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function Loading() {
  const { t } = useI18n();
  return <div className="empty">{t('common.loading')}</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <p className="error-text">{message}</p>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}
