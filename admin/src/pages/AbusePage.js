import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { api } from '../lib/api';
import { Confirm, ErrorBox, fmtDateTime, fmtNumber, Loading, Modal, useLoad, useToast } from '../ui';
const DECISION_LABEL = {
    granted: { text: '放行', cls: 'green' },
    not_entitled: { text: '未解锁', cls: '' },
    unavailable: { text: '无视频', cls: '' },
    rate_limited: { text: '触发限流', cls: 'red' },
    blocked: { text: '封禁中', cls: 'red' },
    budget: { text: '预算暂停', cls: 'amber' },
};
const REASON_LABEL = {
    playback_rate_limit: '取片过于频繁',
    manual_block: '管理员手动封禁',
};
export function AbusePage() {
    const toast = useToast();
    const [openOnly, setOpenOnly] = useState(true);
    const [query, setQuery] = useState('');
    const [found, setFound] = useState(null);
    const [searchError, setSearchError] = useState(null);
    const [selected, setSelected] = useState(null);
    const [resolving, setResolving] = useState(null);
    const flags = useLoad(() => api.abuseFlags(openOnly), [openOnly]);
    const recent = useLoad(() => api.playbackEvents(null, 60), []);
    const search = async (e) => {
        e.preventDefault();
        setSearchError(null);
        try {
            setFound(await api.findUser(query.trim()));
        }
        catch (err) {
            setFound(null);
            setSearchError(err instanceof Error ? err.message.replace(/^invalid_value: /, '') : String(err));
        }
    };
    const openUser = async (userId, code) => {
        try {
            const users = code ? await api.findUser(code) : [];
            const u = users.find((x) => x.user_id === userId);
            if (u)
                setSelected(u);
            else
                toast.show('找不到这个账号的详情', 'err');
        }
        catch (e) {
            toast.show(e instanceof Error ? e.message : String(e), 'err');
        }
    };
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "page-head", children: _jsxs("div", { children: [_jsx("div", { className: "kicker", children: "Abuse & logs" }), _jsx("h1", { children: "\u5F02\u5E38\u4E0E\u65E5\u5FD7" })] }) }), _jsxs("div", { className: "stack", children: [_jsxs("div", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "\u6309\u6C34\u5370\u7801\u67E5\u8D26\u53F7" }), _jsx("span", { className: "hint", children: "\u76D7\u7248\u89C6\u9891\u4E0A\u7684 7 \u4F4D\u7801 = \u6CC4\u9732\u7684\u8D26\u53F7\uFF1B\u4E5F\u53EF\u4EE5\u8F93\u5165\u90AE\u7BB1\u67E5\u627E" })] }), _jsxs("div", { className: "panel-body", children: [_jsxs("form", { onSubmit: search, style: { display: 'flex', gap: 10 }, children: [_jsx("input", { className: "input mono", style: { maxWidth: 320 }, placeholder: "\u4F8B\u5982 ZLG4FVC \u6216 name@mail.com", value: query, onChange: (e) => setQuery(e.target.value) }), _jsx("button", { className: "btn primary", type: "submit", disabled: query.trim().length < 3, children: "\u67E5\u627E" })] }), searchError && _jsx("p", { className: "error-text", children: searchError }), found && (_jsx("div", { className: "table-wrap", style: { marginTop: 14 }, children: found.length === 0 ? (_jsx("div", { className: "empty", children: "\u6CA1\u6709\u627E\u5230" })) : (_jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u6C34\u5370\u7801" }), _jsx("th", { children: "\u8D26\u53F7" }), _jsx("th", { children: "\u6CE8\u518C\u65F6\u95F4" }), _jsx("th", { children: "\u4F59\u989D" }), _jsx("th", { children: "\u4F1A\u5458" }), _jsx("th", { children: "\u72B6\u6001" }), _jsx("th", {})] }) }), _jsx("tbody", { children: found.map((u) => (_jsx(UserRow, { user: u, onOpen: () => setSelected(u) }, u.user_id))) })] })) }))] })] }), _jsxs("div", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "\u5F02\u5E38\u8D26\u53F7" }), _jsx("span", { className: "hint", children: "\u53D6\u7247\u8FC7\u4E8E\u9891\u7E41\u7684\u8D26\u53F7\u4F1A\u88AB\u81EA\u52A8\u6682\u505C\u64AD\u653E" }), _jsxs("div", { className: "right", children: [_jsxs("label", { className: "dim", style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }, children: [_jsx("input", { type: "checkbox", checked: !openOnly, onChange: (e) => setOpenOnly(!e.target.checked) }), "\u5305\u542B\u5DF2\u5904\u7406"] }), _jsx("button", { className: "btn sm", onClick: flags.reload, children: "\u5237\u65B0" })] })] }), flags.loading && !flags.data ? (_jsx(Loading, {})) : flags.error ? (_jsx(ErrorBox, { message: flags.error, onRetry: flags.reload })) : flags.data.length === 0 ? (_jsx("div", { className: "empty", children: openOnly ? '目前没有待处理的异常 👍' : '还没有任何异常记录' })) : (_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u65F6\u95F4" }), _jsx("th", { children: "\u8D26\u53F7" }), _jsx("th", { children: "\u539F\u56E0" }), _jsx("th", { children: "\u8BE6\u60C5" }), _jsx("th", { children: "\u5C01\u7981\u5230" }), _jsx("th", {})] }) }), _jsx("tbody", { children: flags.data.map((f) => {
                                                const active = !f.resolved_at && f.blocks_playback_until && new Date(f.blocks_playback_until) > new Date();
                                                return (_jsxs("tr", { children: [_jsx("td", { className: "num", children: fmtDateTime(f.created_at) }), _jsxs("td", { children: [_jsx("button", { className: "btn ghost sm mono", onClick: () => openUser(f.user_id, f.public_code), children: f.public_code ?? '—' }), _jsx("div", { className: "muted", style: { fontSize: 12 }, children: f.is_anonymous ? '游客' : f.email })] }), _jsx("td", { children: REASON_LABEL[f.reason] ?? f.reason }), _jsx("td", { className: "mono muted", style: { fontSize: 12 }, children: describeDetails(f.details) }), _jsx("td", { children: f.resolved_at ? (_jsx("span", { className: "badge plain", children: "\u5DF2\u89E3\u9664" })) : active ? (_jsx("span", { className: "badge red", children: fmtDateTime(f.blocks_playback_until) })) : (_jsx("span", { className: "badge plain", children: "\u5DF2\u8FC7\u671F" })) }), _jsx("td", { style: { textAlign: 'right' }, children: active && (_jsx("button", { className: "btn sm", onClick: () => setResolving(f.id), children: "\u89E3\u9664" })) })] }, f.id));
                                            }) })] }) }))] }), _jsxs("div", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "\u6700\u8FD1\u64AD\u653E\u8BF7\u6C42" }), _jsx("span", { className: "hint", children: "\u6BCF\u6B21 App \u7533\u8BF7\u64AD\u653E\u94FE\u63A5\u90FD\u4F1A\u8BB0\u5F55" }), _jsx("div", { className: "right", children: _jsx("button", { className: "btn sm", onClick: recent.reload, children: "\u5237\u65B0" }) })] }), recent.loading && !recent.data ? _jsx(Loading, {}) : recent.error ? _jsx(ErrorBox, { message: recent.error }) : _jsx(EventsTable, { events: recent.data })] })] }), resolving !== null && (_jsx(Confirm, { title: "\u89E3\u9664\u5C01\u7981\uFF1F", confirmLabel: "\u89E3\u9664", body: "\u8FD9\u4E2A\u8D26\u53F7\u4F1A\u7ACB\u523B\u6062\u590D\u64AD\u653E\u3002", onClose: () => setResolving(null), onConfirm: async () => {
                    await api.resolveFlag(resolving);
                    toast.show('已解除');
                    flags.reload();
                } })), selected && (_jsx(UserDetail, { user: selected, onClose: () => setSelected(null), onChanged: () => {
                    flags.reload();
                    setSelected(null);
                } }))] }));
}
function describeDetails(d) {
    if (d.note)
        return String(d.note);
    const parts = [];
    if (d.tokens_10min !== undefined)
        parts.push(`10分钟 ${d.tokens_10min} 次`);
    if (d.episodes_1h !== undefined)
        parts.push(`1小时 ${d.episodes_1h} 集`);
    if (d.client_ip)
        parts.push(String(d.client_ip));
    return parts.join(' · ') || '—';
}
function UserRow({ user: u, onOpen }) {
    return (_jsxs("tr", { children: [_jsx("td", { className: "mono", children: u.public_code }), _jsxs("td", { children: [u.display_name, _jsxs("div", { className: "muted", style: { fontSize: 12 }, children: [u.is_anonymous ? '游客' : u.email, u.is_admin && ' · 管理员'] })] }), _jsx("td", { className: "num", children: fmtDateTime(u.created_at) }), _jsx("td", { className: "num", children: fmtNumber(u.balance) }), _jsx("td", { children: u.is_member ? _jsxs("span", { className: "badge blue", children: ["\u5230 ", fmtDateTime(u.member_until)] }) : _jsx("span", { className: "muted", children: "\u2014" }) }), _jsx("td", { children: u.blocked_until ? _jsx("span", { className: "badge red", children: "\u5C01\u7981\u4E2D" }) : _jsx("span", { className: "badge green", children: "\u6B63\u5E38" }) }), _jsx("td", { style: { textAlign: 'right' }, children: _jsx("button", { className: "btn sm", onClick: onOpen, children: "\u8BE6\u60C5" }) })] }));
}
function EventsTable({ events }) {
    if (events.length === 0)
        return _jsx("div", { className: "empty", children: "\u8FD8\u6CA1\u6709\u64AD\u653E\u8BB0\u5F55" });
    return (_jsx("div", { className: "table-wrap", style: { maxHeight: 460 }, children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u65F6\u95F4" }), _jsx("th", { children: "\u8D26\u53F7" }), _jsx("th", { children: "\u5267\u96C6" }), _jsx("th", { children: "\u7ED3\u679C" }), _jsx("th", { children: "IP" })] }) }), _jsx("tbody", { children: events.map((e) => {
                        const d = DECISION_LABEL[e.decision] ?? { text: e.decision, cls: '' };
                        return (_jsxs("tr", { children: [_jsx("td", { className: "num", children: fmtDateTime(e.created_at) }), _jsx("td", { className: "mono", children: e.public_code ?? '—' }), _jsxs("td", { children: [e.series_title ?? e.episode_id, e.episode_number !== null && _jsxs("span", { className: "muted mono", children: [" \u00B7 EP", e.episode_number] })] }), _jsx("td", { children: _jsx("span", { className: `badge ${d.cls}`, children: d.text }) }), _jsx("td", { className: "mono muted", style: { fontSize: 12 }, children: e.client_ip ?? '—' })] }, e.id));
                    }) })] }) }));
}
function UserDetail({ user, onClose, onChanged }) {
    const toast = useToast();
    const events = useLoad(() => api.playbackEvents(user.user_id, 100), [user.user_id]);
    const [minutes, setMinutes] = useState(1440);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const block = async () => {
        setBusy(true);
        try {
            await api.blockUser(user.user_id, minutes, reason);
            toast.show(`已封禁 ${user.public_code} 的播放`);
            onChanged();
        }
        catch (e) {
            toast.show(e instanceof Error ? e.message : String(e), 'err');
            setBusy(false);
        }
    };
    return (_jsx(Modal, { title: `账号 ${user.public_code}`, onClose: onClose, children: _jsxs("div", { className: "stack", style: { gap: 18 }, children: [_jsxs("dl", { className: "kv", style: { gridTemplateColumns: 'repeat(4, auto)' }, children: [_jsx("dt", { children: "\u6635\u79F0" }), _jsx("dt", { children: "\u8D26\u53F7" }), _jsx("dt", { children: "\u4F59\u989D" }), _jsx("dt", { children: "\u89E3\u9501\u96C6\u6570" }), _jsx("dd", { style: { fontFamily: 'var(--font-ui)' }, children: user.display_name }), _jsx("dd", { children: user.is_anonymous ? '游客' : user.email }), _jsx("dd", { children: fmtNumber(user.balance) }), _jsx("dd", { children: fmtNumber(user.unlock_count) })] }), _jsxs("div", { className: "panel", style: { boxShadow: 'none' }, children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "\u5C01\u7981\u64AD\u653E" }), user.blocked_until && _jsxs("span", { className: "badge red", children: ["\u5DF2\u5C01\u7981\u5230 ", fmtDateTime(user.blocked_until)] })] }), _jsxs("div", { className: "panel-body", style: { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }, children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u65F6\u957F" }), _jsxs("select", { className: "select", value: minutes, onChange: (e) => setMinutes(Number(e.target.value)), children: [_jsx("option", { value: 60, children: "1 \u5C0F\u65F6" }), _jsx("option", { value: 1440, children: "1 \u5929" }), _jsx("option", { value: 10080, children: "7 \u5929" }), _jsx("option", { value: 43200, children: "30 \u5929" }), _jsx("option", { value: 525600, children: "1 \u5E74" })] })] }), _jsxs("label", { className: "field", style: { flex: 1, minWidth: 200 }, children: [_jsx("span", { children: "\u539F\u56E0\uFF08\u5185\u90E8\u5907\u6CE8\uFF09" }), _jsx("input", { className: "input", value: reason, onChange: (e) => setReason(e.target.value), placeholder: "\u4F8B\u5982\uFF1A\u5728\u67D0\u5E73\u53F0\u53D1\u73B0\u6CC4\u9732\u7684\u7B2C 12 \u96C6" })] }), _jsx("button", { className: "btn danger", disabled: busy, onClick: block, children: "\u5C01\u7981" })] })] }), _jsxs("div", { children: [_jsx("h2", { style: { fontSize: 15, margin: '0 0 8px' }, children: "\u64AD\u653E\u8BB0\u5F55" }), events.loading && !events.data ? _jsx(Loading, {}) : events.error ? _jsx(ErrorBox, { message: events.error }) : _jsx(EventsTable, { events: events.data })] })] }) }));
}
