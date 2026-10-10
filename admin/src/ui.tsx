import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { EpisodeAccess } from './lib/episodes';
import type { VideoAsset } from './lib/api';

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
  return d.toLocaleString('zh-CN', { ...year, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function fmtNumber(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString('en-US');
}

export const ACCESS_LABEL: Record<EpisodeAccess, string> = {
  free: '免费',
  coin: '金币解锁',
  ad_unlock: '看广告解锁',
  subscriber: '会员专享',
};

export function AccessBadge({ access, coinPrice }: { access: EpisodeAccess; coinPrice: number | null }) {
  if (access === 'coin') return <span className="badge gold plain mono">🪙 {coinPrice}</span>;
  if (access === 'free') return <span className="badge green plain">免费</span>;
  if (access === 'subscriber') return <span className="badge blue plain">会员</span>;
  return <span className="badge amber plain">广告</span>;
}

export function VideoBadge({ video }: { video: VideoAsset | undefined }) {
  if (!video) return <span className="badge">无视频</span>;
  if (video.status === 'ready') return <span className="badge green">就绪 · {fmtDuration(video.duration_sec)}</span>;
  if (video.status === 'error') return <span className="badge red" title={video.error_reason ?? ''}>失败</span>;
  if (video.status === 'pending_upload') return <span className="badge amber pulse">等待上传</span>;
  return <span className="badge amber pulse">处理中</span>;
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
            <button className="btn ghost sm" onClick={onClose} aria-label="关闭">
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
            取消
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
            {busy ? '处理中…' : confirmLabel}
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
  return <div className="empty">加载中…</div>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="empty">
      <p className="error-text">{message}</p>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
