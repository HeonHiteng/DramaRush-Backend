import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ACCESS_LABEL, AccessBadge, Confirm, ErrorBox, fmtBytes, fmtDuration, Loading, Modal, useLoad, useToast, VideoBadge } from '../ui';
import { BulkUpload } from './BulkUpload';
import { PosterArt } from './SeriesListPage';
import { SeriesForm } from './SeriesForm';
import { useUploads } from './useUploads';
export function SeriesPage() {
    const { id = '' } = useParams();
    const navigate = useNavigate();
    const toast = useToast();
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const { data, error, loading, reload } = useLoad(async () => {
        const [series, episodes] = await Promise.all([api.series(id), api.episodes(id)]);
        const videos = await api.videos(episodes.map((e) => e.id));
        return { series, episodes, videos };
    }, [id]);
    const uploads = useUploads(id, reload);
    if (loading && !data)
        return _jsx(Loading, {});
    if (error)
        return _jsx(ErrorBox, { message: error, onRetry: reload });
    if (!data?.series)
        return _jsx(ErrorBox, { message: "\u627E\u4E0D\u5230\u8FD9\u90E8\u5267" });
    const { series, episodes, videos } = data;
    const readyCount = episodes.filter((e) => videos.get(e.id)?.status === 'ready').length;
    const publishedCount = episodes.filter((e) => e.published).length;
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "page-head", children: [_jsxs("div", { children: [_jsxs("div", { className: "kicker", children: [_jsx(Link, { to: "/series", children: "\u5267\u96C6" }), " / ", series.id] }), _jsx("h1", { children: series.title })] }), _jsxs("div", { className: "actions", children: [_jsx("button", { className: "btn", onClick: () => setEditing(true), children: "\u7F16\u8F91\u5267\u96C6\u4FE1\u606F" }), _jsx("button", { className: "btn danger", onClick: () => setDeleting(true), disabled: uploads.busy, children: "\u5220\u9664\u6574\u90E8\u5267" })] })] }), _jsxs("div", { className: "stack", children: [_jsxs("div", { className: "series-hero", children: [_jsx(PosterArt, { series: series }), _jsxs("div", { children: [_jsx("p", { className: "dim", style: { marginTop: 0, maxWidth: 760 }, children: series.synopsis }), _jsx("div", { className: "chips", children: series.genres.map((g) => (_jsx("span", { className: "badge plain", children: g }, g))) }), _jsxs("dl", { className: "kv", children: [_jsx("dt", { children: "\u96C6\u6570" }), _jsx("dt", { children: "\u5DF2\u6709\u89C6\u9891" }), _jsx("dt", { children: "\u5DF2\u53D1\u5E03" }), _jsx("dt", { children: "\u8BC4\u5206 \u00B7 \u70ED\u5EA6" }), _jsx("dd", { children: episodes.length }), _jsx("dd", { children: readyCount }), _jsx("dd", { children: publishedCount }), _jsxs("dd", { children: [series.rating, " \u00B7 ", series.popularity] })] })] })] }), _jsx(BulkUpload, { seriesId: series.id, episodes: episodes, videos: videos, uploads: uploads }), _jsx(EpisodeTable, { seriesId: series.id, episodes: episodes, videos: videos, uploads: uploads, onChanged: reload })] }), editing && (_jsx(SeriesForm, { initial: series, onClose: () => setEditing(false), onSaved: () => {
                    setEditing(false);
                    toast.show('已保存');
                    reload();
                } })), deleting && (_jsx(Confirm, { title: "\u5220\u9664\u6574\u90E8\u5267\uFF1F", danger: true, confirmLabel: `删除《${series.title}》`, body: _jsxs(_Fragment, { children: ["\u4F1A\u5220\u9664\u8FD9\u90E8\u5267\u7684 ", episodes.length, " \u96C6\u548C\u5B83\u4EEC\u5728 Cloudflare \u4E0A\u7684\u5168\u90E8\u89C6\u9891\uFF0C\u7528\u6237\u7684\u89E3\u9501\u8BB0\u5F55\u4E5F\u4F1A\u4E00\u8D77\u6D88\u5931\u3002", _jsx("b", { children: "\u65E0\u6CD5\u6062\u590D\u3002" })] }), onClose: () => setDeleting(false), onConfirm: async () => {
                    await api.deleteSeries(series.id, episodes.map((e) => e.id));
                    toast.show('已删除');
                    navigate('/series');
                } }))] }));
}
function JobProgress({ job, uploads }) {
    const pct = job.file.size ? Math.round((job.sent / job.file.size) * 100) : 0;
    const label = {
        queued: '排队中',
        saving: '保存剧集…',
        uploading: `上传 ${pct}% · ${fmtBytes(job.sent)} / ${fmtBytes(job.file.size)}`,
        processing: 'Cloudflare 处理中…',
        ready: '完成',
        failed: '失败',
        cancelled: '已取消',
    };
    const done = job.state === 'ready';
    const fail = job.state === 'failed' || job.state === 'cancelled';
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 220 }, children: [_jsx("div", { className: `reel ${done ? 'done' : ''} ${fail ? 'fail' : ''}`, children: _jsx("i", { style: { width: `${job.state === 'processing' || done ? 100 : pct}%` } }) }), _jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }, children: [_jsxs("span", { className: `mono ${fail ? 'error-text' : 'dim'}`, style: { fontSize: 12 }, children: [label[job.state], job.error && `：${job.error}`] }), (job.state === 'queued' || job.state === 'uploading') && (_jsx("button", { className: "btn ghost sm", onClick: () => uploads.cancel(job.episodeId), children: "\u53D6\u6D88" })), (done || fail) && (_jsx("button", { className: "btn ghost sm", onClick: () => uploads.dismiss(job.episodeId), children: "\u2715" }))] })] }));
}
function EpisodeTable({ seriesId, episodes, videos, uploads, onChanged, }) {
    const toast = useToast();
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [toggling, setToggling] = useState(null);
    const replaceInput = useRef(null);
    const replaceTarget = useRef(null);
    // Jobs for episodes that don't exist yet (being created by a bulk upload).
    const known = new Set(episodes.map((e) => e.id));
    const orphanJobs = Object.values(uploads.jobs).filter((j) => !known.has(j.episodeId));
    const togglePublish = async (ep) => {
        if (!ep.published && videos.get(ep.id)?.status !== 'ready') {
            toast.show('这集还没有就绪的视频，发布后用户会看到「即将上线」。', 'err');
        }
        setToggling(ep.id);
        try {
            await api.updateEpisode(ep.id, { published: !ep.published });
            onChanged();
        }
        catch (e) {
            toast.show(e instanceof Error ? e.message : String(e), 'err');
        }
        finally {
            setToggling(null);
        }
    };
    return (_jsxs("div", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "\u5355\u96C6" }), _jsx("span", { className: "hint", children: "\u672A\u53D1\u5E03\u7684\u96C6\u7528\u6237\u770B\u4E0D\u5230\uFF1B\u89C6\u9891\u8981\u300C\u5C31\u7EEA\u300D\u624D\u80FD\u64AD\u653E" }), _jsx("div", { className: "right", children: _jsx("button", { className: "btn sm", onClick: onChanged, children: "\u5237\u65B0" }) })] }), _jsx("input", { ref: replaceInput, type: "file", accept: "video/*", hidden: true, onChange: (e) => {
                    const file = e.target.files?.[0];
                    const ep = replaceTarget.current;
                    e.target.value = '';
                    if (!file || !ep)
                        return;
                    uploads.enqueue([
                        {
                            job: { episodeId: ep.id, number: ep.number, file, state: 'queued', sent: 0 },
                            isNewEpisode: false,
                            episodePatch: {},
                            publishWhenReady: false,
                        },
                    ]);
                } }), episodes.length === 0 && orphanJobs.length === 0 ? (_jsx("div", { className: "empty", children: "\u8FD8\u6CA1\u6709\u5355\u96C6\u3002\u628A\u89C6\u9891\u62D6\u5230\u4E0A\u9762\u7684\u300C\u6279\u91CF\u4E0A\u4F20\u300D\u5373\u53EF\u81EA\u52A8\u5EFA\u96C6\u3002" })) : (_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { style: { width: 64 }, children: "\u96C6" }), _jsx("th", { children: "\u6807\u9898" }), _jsx("th", { style: { width: 110 }, children: "\u4ED8\u8D39" }), _jsx("th", { style: { width: 150 }, children: "\u89C6\u9891" }), _jsx("th", { style: { width: 70 }, children: "\u53D1\u5E03" }), _jsx("th", { style: { width: 250 }, children: "\u4E0A\u4F20" }), _jsx("th", { style: { width: 210 } })] }) }), _jsxs("tbody", { children: [episodes.map((ep) => {
                                    const job = uploads.jobs[ep.id];
                                    const active = job && !['ready', 'failed', 'cancelled'].includes(job.state);
                                    return (_jsxs("tr", { children: [_jsxs("td", { className: "num", children: ["EP", String(ep.number).padStart(2, '0')] }), _jsxs("td", { children: [ep.title, _jsx("div", { className: "muted mono", style: { fontSize: 11 }, children: fmtDuration(ep.duration_sec) })] }), _jsx("td", { children: _jsx(AccessBadge, { access: ep.access, coinPrice: ep.coin_price }) }), _jsx("td", { children: _jsx(VideoBadge, { video: videos.get(ep.id) }) }), _jsx("td", { children: _jsx("button", { className: `toggle ${ep.published ? 'on' : ''}`, "aria-label": ep.published ? '已发布，点击取消发布' : '草稿，点击发布', disabled: toggling === ep.id, onClick: () => togglePublish(ep) }) }), _jsx("td", { children: job ? _jsx(JobProgress, { job: job, uploads: uploads }) : _jsx("span", { className: "muted", children: "\u2014" }) }), _jsxs("td", { style: { textAlign: 'right' }, children: [_jsx("button", { className: "btn ghost sm", onClick: () => setEditing(ep), children: "\u7F16\u8F91" }), _jsx("button", { className: "btn ghost sm", disabled: !!active, onClick: () => {
                                                            replaceTarget.current = ep;
                                                            replaceInput.current?.click();
                                                        }, children: videos.get(ep.id) ? '替换视频' : '上传视频' }), _jsx("button", { className: "btn ghost sm", style: { color: 'var(--red)' }, disabled: !!active, onClick: () => setDeleting(ep), children: "\u5220\u9664" })] })] }, ep.id));
                                }), orphanJobs.map((job) => (_jsxs("tr", { children: [_jsxs("td", { className: "num", children: ["EP", String(job.number).padStart(2, '0')] }), _jsx("td", { className: "muted", children: "\u65B0\u5EFA\u4E2D\u2026" }), _jsx("td", {}), _jsx("td", {}), _jsx("td", {}), _jsx("td", { children: _jsx(JobProgress, { job: job, uploads: uploads }) }), _jsx("td", {})] }, job.episodeId)))] })] }) })), editing && (_jsx(EpisodeEditor, { episode: editing, onClose: () => setEditing(null), onSaved: () => {
                    setEditing(null);
                    toast.show('已保存');
                    onChanged();
                } })), deleting && (_jsx(Confirm, { title: `删除第 ${deleting.number} 集？`, danger: true, confirmLabel: "\u5220\u9664", body: "\u4F1A\u540C\u65F6\u5220\u6389\u5B83\u5728 Cloudflare \u4E0A\u7684\u89C6\u9891\uFF08\u505C\u6B62\u8BA1\u8D39\uFF09\uFF0C\u7528\u6237\u5BF9\u8FD9\u96C6\u7684\u89E3\u9501\u8BB0\u5F55\u4E5F\u4F1A\u6D88\u5931\u3002\u65E0\u6CD5\u6062\u590D\u3002", onClose: () => setDeleting(null), onConfirm: async () => {
                    await api.deleteEpisode(deleting.id);
                    toast.show(`已删除 ${seriesId} 第 ${deleting.number} 集`);
                    onChanged();
                } }))] }));
}
function EpisodeEditor({ episode, onClose, onSaved }) {
    const [title, setTitle] = useState(episode.title);
    const [access, setAccess] = useState(episode.access);
    const [price, setPrice] = useState(episode.coin_price ?? 20);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const save = async () => {
        if (!title.trim())
            return setError('请填写标题');
        if (access === 'coin' && (!Number.isInteger(price) || price < 1))
            return setError('金币价格要是正整数');
        setBusy(true);
        try {
            await api.updateEpisode(episode.id, { title: title.trim(), access, coin_price: access === 'coin' ? price : null });
            onSaved();
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    };
    return (_jsx(Modal, { small: true, title: `编辑第 ${episode.number} 集`, onClose: busy ? () => { } : onClose, footer: _jsxs(_Fragment, { children: [_jsx("button", { className: "btn ghost", onClick: onClose, disabled: busy, children: "\u53D6\u6D88" }), _jsx("button", { className: "btn primary", onClick: save, disabled: busy, children: busy ? '保存中…' : '保存' })] }), children: _jsxs("div", { className: "stack", style: { gap: 14 }, children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u6807\u9898" }), _jsx("input", { className: "input", value: title, onChange: (e) => setTitle(e.target.value) })] }), _jsxs("div", { className: "field", children: [_jsx("span", { children: "\u4ED8\u8D39\u65B9\u5F0F" }), _jsx("div", { className: "chips", children: Object.keys(ACCESS_LABEL).map((a) => (_jsx("button", { type: "button", className: `chip ${access === a ? 'on' : ''}`, onClick: () => setAccess(a), children: ACCESS_LABEL[a] }, a))) })] }), access === 'coin' && (_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u91D1\u5E01\u4EF7\u683C" }), _jsx("input", { className: "input mono", type: "number", min: 1, value: price, onChange: (e) => setPrice(Number(e.target.value)) })] })), error && _jsx("p", { className: "error-text", children: error })] }) }));
}
