import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
/** A sign-in link that failed (expired / already used) comes back with ?error_code=… or #error_code=…. */
function linkError() {
    const params = new URLSearchParams(window.location.search + '&' + window.location.hash.slice(1));
    const code = params.get('error_code');
    if (!code)
        return null;
    window.history.replaceState(window.history.state, '', window.location.pathname);
    return code === 'otp_expired' ? '登录链接已失效或已用过，请重新获取。' : '登录链接无效，请重新获取。';
}
export function LoginPage() {
    const { status, sendLink, notice } = useAuth();
    const [email, setEmail] = useState('');
    const [sentTo, setSentTo] = useState(null);
    const [error, setError] = useState(linkError);
    const [busy, setBusy] = useState(false);
    if (status === 'admin')
        return _jsx(Navigate, { to: "/", replace: true });
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await sendLink(email.trim());
            setSentTo(email.trim());
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("div", { className: "login", children: [_jsxs("section", { className: "login-art", "aria-hidden": "true", children: [_jsx("div", { className: "strip" }), _jsxs("div", { className: "slate", children: ["Key", _jsx("br", {}), "box", _jsx("span", { children: "." })] }), _jsx("p", { children: "\u5185\u5BB9\u540E\u53F0 \u00B7 \u4E0A\u4F20\u6574\u90E8\u5267\u3001\u7BA1\u7406\u5267\u96C6\u4E0E\u4ED8\u8D39\u65B9\u5F0F\u3001\u76EF\u4F4F\u64AD\u653E\u6210\u672C\u548C\u5F02\u5E38\u8D26\u53F7\u3002" })] }), _jsx("section", { className: "login-form", children: _jsxs("form", { onSubmit: submit, children: [_jsxs("div", { children: [_jsx("div", { className: "mono muted", style: { fontSize: 11, letterSpacing: '0.16em' }, children: "ADMIN \u00B7 SIGN IN" }), _jsx("h1", { children: "\u7BA1\u7406\u5458\u767B\u5F55" })] }), sentTo ? (_jsxs(_Fragment, { children: [_jsxs("p", { style: { margin: 0 }, children: ["\u5982\u679C ", _jsx("b", { children: sentTo }), " \u662F\u7BA1\u7406\u5458\u90AE\u7BB1\uFF0C\u767B\u5F55\u94FE\u63A5\u5DF2\u7ECF\u53D1\u8FC7\u53BB\u4E86\u3002\u8BF7\u5728", _jsx("b", { children: "\u8FD9\u4E2A\u6D4F\u89C8\u5668" }), "\u91CC\u6253\u5F00\u90AE\u4EF6\u4E2D\u7684\u94FE\u63A5\u3002"] }), _jsx("p", { className: "muted", style: { fontSize: 12, margin: 0 }, children: "\u6CA1\u6536\u5230\uFF1F\u770B\u770B\u5783\u573E\u90AE\u4EF6\uFF0C\u6216\u7A0D\u7B49\u4E00\u5206\u949F\u518D\u8BD5\u3002" }), _jsx("button", { className: "btn ghost", type: "button", onClick: () => setSentTo(null), children: "\u6362\u4E2A\u90AE\u7BB1 / \u91CD\u65B0\u53D1\u9001" })] })) : (_jsxs(_Fragment, { children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u90AE\u7BB1" }), _jsx("input", { className: "input", type: "email", autoComplete: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })] }), (error || notice) && _jsx("p", { className: "error-text", children: error ?? notice }), _jsx("button", { className: "btn primary", type: "submit", disabled: busy, children: busy ? '发送中…' : '发送登录链接' })] })), _jsx("p", { className: "muted", style: { fontSize: 12, margin: 0 }, children: "\u4E0D\u7528\u5BC6\u7801\uFF1A\u6BCF\u6B21\u767B\u5F55\u53D1\u4E00\u5C01\u4E00\u6B21\u6027\u94FE\u63A5\u3002\u53EA\u6709\u88AB\u5F00\u901A\u4E3A\u7BA1\u7406\u5458\u7684\u90AE\u7BB1\u624D\u80FD\u8FDB\u5165\u3002" })] }) })] }));
}
