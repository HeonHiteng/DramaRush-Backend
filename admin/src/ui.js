import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
// ---------------------------------------------------------------- format
export function fmtDuration(sec) {
    if (!sec || sec <= 0)
        return '—';
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}
export function fmtDateTime(iso) {
    if (!iso)
        return '—';
    const d = new Date(iso);
    // Show the year only when it isn't this year (e.g. a membership ending next year).
    const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {};
    return d.toLocaleString('zh-CN', { ...year, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function fmtBytes(n) {
    if (n >= 1024 ** 3)
        return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2)
        return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
}
export function fmtNumber(n) {
    return (n ?? 0).toLocaleString('en-US');
}
export const ACCESS_LABEL = {
    free: '免费',
    coin: '金币解锁',
    ad_unlock: '看广告解锁',
    subscriber: '会员专享',
};
export function AccessBadge({ access, coinPrice }) {
    if (access === 'coin')
        return _jsxs("span", { className: "badge gold plain mono", children: ["\uD83E\uDE99 ", coinPrice] });
    if (access === 'free')
        return _jsx("span", { className: "badge green plain", children: "\u514D\u8D39" });
    if (access === 'subscriber')
        return _jsx("span", { className: "badge blue plain", children: "\u4F1A\u5458" });
    return _jsx("span", { className: "badge amber plain", children: "\u5E7F\u544A" });
}
export function VideoBadge({ video }) {
    if (!video)
        return _jsx("span", { className: "badge", children: "\u65E0\u89C6\u9891" });
    if (video.status === 'ready')
        return _jsxs("span", { className: "badge green", children: ["\u5C31\u7EEA \u00B7 ", fmtDuration(video.duration_sec)] });
    if (video.status === 'error')
        return _jsx("span", { className: "badge red", title: video.error_reason ?? '', children: "\u5931\u8D25" });
    if (video.status === 'pending_upload')
        return _jsx("span", { className: "badge amber pulse", children: "\u7B49\u5F85\u4E0A\u4F20" });
    return _jsx("span", { className: "badge amber pulse", children: "\u5904\u7406\u4E2D" });
}
const ToastContext = createContext({ show: () => { } });
export function ToastProvider({ children }) {
    const [toast, setToast] = useState(null);
    const show = useCallback((text, kind = 'ok') => setToast({ text, kind, id: Date.now() }), []);
    useEffect(() => {
        if (!toast)
            return;
        const t = setTimeout(() => setToast(null), toast.kind === 'err' ? 6000 : 3000);
        return () => clearTimeout(t);
    }, [toast]);
    return (_jsxs(ToastContext.Provider, { value: { show }, children: [children, toast && (_jsx("div", { className: `toast ${toast.kind === 'err' ? 'err' : ''}`, role: "status", children: toast.text }, toast.id))] }));
}
export const useToast = () => useContext(ToastContext);
// ---------------------------------------------------------------- modal
export function Modal({ title, onClose, children, footer, small, }) {
    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (_jsx("div", { className: "modal-back", onMouseDown: (e) => e.target === e.currentTarget && onClose(), children: _jsxs("div", { className: `modal ${small ? 'sm' : ''}`, role: "dialog", "aria-modal": "true", "aria-label": title, children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: title }), _jsx("div", { className: "right", children: _jsx("button", { className: "btn ghost sm", onClick: onClose, "aria-label": "\u5173\u95ED", children: "\u2715" }) })] }), _jsx("div", { className: "panel-body", children: children }), footer && _jsx("div", { className: "modal-foot", children: footer })] }) }));
}
export function Confirm({ title, body, confirmLabel, danger, onConfirm, onClose, }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    return (_jsxs(Modal, { small: true, title: title, onClose: busy ? () => { } : onClose, footer: _jsxs(_Fragment, { children: [_jsx("button", { className: "btn ghost", onClick: onClose, disabled: busy, children: "\u53D6\u6D88" }), _jsx("button", { className: `btn ${danger ? 'danger' : 'primary'}`, disabled: busy, onClick: async () => {
                        setBusy(true);
                        setError(null);
                        try {
                            await onConfirm();
                            onClose();
                        }
                        catch (e) {
                            setError(e instanceof Error ? e.message : String(e));
                            setBusy(false);
                        }
                    }, children: busy ? '处理中…' : confirmLabel })] }), children: [_jsx("div", { className: "dim", children: body }), error && _jsx("p", { className: "error-text", children: error })] }));
}
// ---------------------------------------------------------------- data hook
/** Tiny loader: { data, error, loading, reload }. */
export function useLoad(load, deps) {
    const [state, setState] = useState({
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
    return _jsx("div", { className: "empty", children: "\u52A0\u8F7D\u4E2D\u2026" });
}
export function ErrorBox({ message, onRetry }) {
    return (_jsxs("div", { className: "empty", children: [_jsx("p", { className: "error-text", children: message }), onRetry && (_jsx("button", { className: "btn sm", onClick: onRetry, children: "\u91CD\u8BD5" }))] }));
}
