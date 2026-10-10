import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
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
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "page-head", children: [_jsxs("div", { children: [_jsx("div", { className: "kicker", children: "Library" }), _jsx("h1", { children: "\u5267\u96C6\u4E0E\u4E0A\u4F20" })] }), _jsxs("div", { className: "actions", children: [_jsx("input", { className: "input", style: { width: 220 }, placeholder: "\u641C\u7D22\u5267\u540D\u6216 ID", value: query, onChange: (e) => setQuery(e.target.value) }), _jsx("button", { className: "btn primary", onClick: () => setCreating(true), children: "\uFF0B \u65B0\u5EFA\u5267\u96C6" })] })] }), loading && !data ? (_jsx(Loading, {})) : error ? (_jsx(ErrorBox, { message: error, onRetry: reload })) : list.length === 0 ? (_jsx("div", { className: "panel empty", children: query ? '没有匹配的剧集' : '还没有剧集，先新建一部再上传视频。' })) : (_jsx("div", { className: "series-grid", children: list.map((s, i) => (_jsx(SeriesCard, { series: s, counts: data.counts.get(s.id), delay: i * 0.03 }, s.id))) })), creating && _jsx(SeriesForm, { onClose: () => setCreating(false), onSaved: (id) => navigate(`/series/${id}`) })] }));
}
export function PosterArt({ series }) {
    return (_jsxs("div", { className: "poster", style: { background: `linear-gradient(160deg, ${series.poster_color_from}, ${series.poster_color_to})` }, children: [series.poster_image_uri && _jsx("img", { src: series.poster_image_uri, alt: "" }), !series.poster_image_uri && _jsx("div", { className: "title-on", children: series.title })] }));
}
function SeriesCard({ series, counts, delay }) {
    return (_jsxs(Link, { to: `/series/${series.id}`, className: "series-card", style: { animationDelay: `${delay}s` }, children: [_jsx(PosterArt, { series: series }), _jsxs("div", { className: "meta", children: [_jsx("strong", { children: series.title }), _jsxs("div", { className: "row", children: [_jsxs("span", { className: "mono", children: [counts?.published ?? 0, "/", counts?.total ?? 0, " \u96C6\u5DF2\u53D1\u5E03"] }), series.is_new && _jsx("span", { className: "badge coral plain", style: { color: 'var(--coral)', borderColor: 'rgba(255,90,95,.4)' }, children: "NEW" })] }), _jsx("div", { className: "row muted mono", style: { fontSize: 11 }, children: series.id })] })] }));
}
