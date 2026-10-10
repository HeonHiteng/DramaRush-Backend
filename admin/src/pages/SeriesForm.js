import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { api } from '../lib/api';
import { SERIES_ID_RE, slugify } from '../lib/episodes';
import { Modal } from '../ui';
/** Same lists the app filters by (DramaRush/src/types/content.ts). */
export const GENRES = ['Romance', 'Suspense', 'Revenge', 'Comedy', 'Fantasy', 'Youth', 'Mystery', 'Workplace'];
export const LANGUAGES = ['English', 'Spanish', 'Korean', 'Portuguese'];
const BLANK = {
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
function castToText(cast) {
    return cast.map((c) => `${c.name} | ${c.role}`).join('\n');
}
function textToCast(text) {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
        const [name, role = ''] = line.split('|').map((s) => s.trim());
        return { name, role };
    });
}
export function SeriesForm({ initial, onClose, onSaved }) {
    const isNew = !initial;
    const [s, setS] = useState(initial ?? BLANK);
    const [idTouched, setIdTouched] = useState(false);
    const [castText, setCastText] = useState(castToText(s.cast_members));
    const [poster, setPoster] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const set = (key, value) => setS((prev) => ({ ...prev, [key]: value }));
    const save = async () => {
        setError(null);
        if (!s.title.trim())
            return setError('请填写剧名');
        if (!SERIES_ID_RE.test(s.id))
            return setError('剧集 ID 只能用小写字母、数字和横线（2–60 个字符）');
        if (!s.synopsis.trim())
            return setError('请填写简介');
        if (s.genres.length === 0)
            return setError('至少选一个类型');
        setBusy(true);
        try {
            const { poster_image_uri: _keep, ...row } = { ...s, title: s.title.trim(), synopsis: s.synopsis.trim(), cast_members: textToCast(castText) };
            void _keep;
            await api.saveSeries(row, isNew);
            if (poster)
                await api.uploadPoster(s.id, poster);
            onSaved(s.id);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg.includes('duplicate key') ? '这个剧集 ID 已被占用，换一个' : msg);
            setBusy(false);
        }
    };
    return (_jsx(Modal, { title: isNew ? '新建剧集' : `编辑《${initial.title}》`, onClose: busy ? () => { } : onClose, footer: _jsxs(_Fragment, { children: [_jsx("button", { className: "btn ghost", onClick: onClose, disabled: busy, children: "\u53D6\u6D88" }), _jsx("button", { className: "btn primary", onClick: save, disabled: busy, children: busy ? '保存中…' : '保存' })] }), children: _jsxs("div", { className: "stack", style: { gap: 14 }, children: [_jsxs("div", { className: "grid-2", children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u5267\u540D" }), _jsx("input", { className: "input", value: s.title, onChange: (e) => {
                                        set('title', e.target.value);
                                        if (isNew && !idTouched)
                                            set('id', slugify(e.target.value));
                                    } })] }), _jsxs("label", { className: "field", children: [_jsx("span", { children: "\u5267\u96C6 ID\uFF08\u7F51\u5740\u91CC\u7528\uFF0C\u521B\u5EFA\u540E\u4E0D\u80FD\u6539\uFF09" }), _jsx("input", { className: "input mono", value: s.id, disabled: !isNew, onChange: (e) => {
                                        setIdTouched(true);
                                        set('id', e.target.value.toLowerCase());
                                    } })] })] }), _jsxs("label", { className: "field", children: [_jsx("span", { children: "\u7B80\u4ECB" }), _jsx("textarea", { className: "textarea", value: s.synopsis, onChange: (e) => set('synopsis', e.target.value) })] }), _jsxs("div", { className: "field", children: [_jsx("span", { children: "\u7C7B\u578B" }), _jsx("div", { className: "chips", children: GENRES.map((g) => (_jsx("button", { type: "button", className: `chip ${s.genres.includes(g) ? 'on' : ''}`, onClick: () => set('genres', s.genres.includes(g) ? s.genres.filter((x) => x !== g) : [...s.genres, g]), children: g }, g))) })] }), _jsxs("div", { className: "grid-4", children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u8BED\u8A00" }), _jsx("select", { className: "select", value: s.language, onChange: (e) => set('language', e.target.value), children: LANGUAGES.map((l) => (_jsx("option", { children: l }, l))) })] }), _jsxs("label", { className: "field", children: [_jsx("span", { children: "\u72B6\u6001" }), _jsxs("select", { className: "select", value: s.status, onChange: (e) => set('status', e.target.value), children: [_jsx("option", { value: "ongoing", children: "\u8FDE\u8F7D\u4E2D" }), _jsx("option", { value: "completed", children: "\u5DF2\u5B8C\u7ED3" })] })] }), _jsxs("label", { className: "field", children: [_jsx("span", { children: "\u8BC4\u5206\uFF080\u20135\uFF09" }), _jsx("input", { className: "input mono", type: "number", step: "0.1", min: 0, max: 5, value: s.rating, onChange: (e) => set('rating', Math.min(5, Math.max(0, Number(e.target.value)))) })] }), _jsxs("label", { className: "field", children: [_jsx("span", { children: "\u70ED\u5EA6\uFF08\u6392\u5E8F\u7528\uFF09" }), _jsx("input", { className: "input mono", type: "number", value: s.popularity, onChange: (e) => set('popularity', Math.round(Number(e.target.value))) })] })] }), _jsx("div", { className: "grid-4", children: [
                        ['poster_color_from', '海报渐变 起'],
                        ['poster_color_to', '海报渐变 止'],
                        ['banner_color_from', '横幅渐变 起'],
                        ['banner_color_to', '横幅渐变 止'],
                    ].map(([key, label]) => (_jsxs("label", { className: "field", children: [_jsx("span", { children: label }), _jsx("input", { className: "input", type: "color", value: s[key], onChange: (e) => set(key, e.target.value.toUpperCase()), style: { height: 36, padding: 3 } })] }, key))) }), _jsxs("div", { className: "grid-2", children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u6F14\u5458\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF1A\u59D3\u540D | \u89D2\u8272\uFF09" }), _jsx("textarea", { className: "textarea mono", value: castText, onChange: (e) => setCastText(e.target.value), placeholder: "Elena Marsh | Wren Hale" })] }), _jsxs("div", { className: "stack", style: { gap: 14 }, children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u6D77\u62A5\u56FE\u7247\uFF08\u53EF\u9009\uFF0CJPG/PNG/WebP\uFF0C\u7AD6\u7248 3:4\uFF09" }), _jsx("input", { className: "input", type: "file", accept: "image/jpeg,image/png,image/webp", onChange: (e) => setPoster(e.target.files?.[0] ?? null) })] }), _jsxs("label", { className: "field", style: { flexDirection: 'row', alignItems: 'center', gap: 10 }, children: [_jsx("input", { type: "checkbox", checked: s.is_new, onChange: (e) => set('is_new', e.target.checked) }), _jsx("span", { style: { color: 'var(--text-2)', fontSize: 13 }, children: "\u6807\u8BB0\u4E3A\u300C\u65B0\u5267\u300D" })] })] })] }), error && _jsx("p", { className: "error-text", children: error })] }) }));
}
