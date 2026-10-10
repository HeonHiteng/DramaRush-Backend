import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useRef, useState } from 'react';
import { accessFor, episodeId, matchEpisodeFiles, parseNumberList } from '../lib/episodes';
import { ACCESS_LABEL, AccessBadge, fmtBytes, VideoBadge } from '../ui';
/** Collects files from a drop, including whole folders. */
async function filesFromDrop(e) {
    const items = [...e.dataTransfer.items];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length === 0)
        return [...e.dataTransfer.files];
    const out = [];
    const walk = async (entry) => {
        if (entry.isFile) {
            out.push(await new Promise((res, rej) => entry.file(res, rej)));
        }
        else if (entry.isDirectory) {
            const reader = entry.createReader();
            let batch;
            do {
                batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                for (const child of batch)
                    await walk(child);
            } while (batch.length > 0);
        }
    };
    for (const entry of entries)
        await walk(entry);
    return out;
}
export function BulkUpload({ seriesId, episodes, videos, uploads, }) {
    const [files, setFiles] = useState([]);
    const [over, setOver] = useState(false);
    const [freeCount, setFreeCount] = useState(3);
    const [adText, setAdText] = useState('');
    const [rest, setRest] = useState('coin');
    const [coinPrice, setCoinPrice] = useState(20);
    const [applyToExisting, setApplyToExisting] = useState(false);
    const [reuploadReady, setReuploadReady] = useState(false);
    const [autoPublish, setAutoPublish] = useState(true);
    const fileInput = useRef(null);
    const folderInput = useRef(null);
    const byNumber = useMemo(() => new Map(episodes.map((e) => [e.number, e])), [episodes]);
    const match = useMemo(() => matchEpisodeFiles(files), [files]);
    let rule = null;
    let ruleError = null;
    try {
        rule = { freeCount: Math.max(0, freeCount), adUnlock: parseNumberList(adText), rest, coinPrice: Math.max(1, coinPrice) };
    }
    catch (e) {
        ruleError = e instanceof Error ? e.message : String(e);
    }
    const rows = match.matched.map(({ number, file }) => {
        const existing = byNumber.get(number);
        const id = episodeId(seriesId, number);
        const video = existing ? videos.get(existing.id) : undefined;
        const planned = rule ? accessFor(number, rule) : null;
        const skip = !!video && video.status === 'ready' && !reuploadReady;
        const willSetAccess = !existing || applyToExisting;
        return { number, file, id, existing, video, planned, skip, willSetAccess };
    });
    const toUpload = rows.filter((r) => !r.skip);
    const totalBytes = toUpload.reduce((sum, r) => sum + r.file.size, 0);
    const start = () => {
        if (!rule)
            return;
        uploads.enqueue(toUpload.map((r) => ({
            job: { episodeId: r.id, number: r.number, file: r.file, state: 'queued', sent: 0 },
            isNewEpisode: !r.existing,
            episodePatch: r.willSetAccess && r.planned ? { access: r.planned.access, coin_price: r.planned.coinPrice } : {},
            publishWhenReady: autoPublish,
        })));
        setFiles([]);
    };
    const addFiles = (list) => setFiles((prev) => [...prev, ...list.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))]);
    return (_jsxs("div", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "\u6279\u91CF\u4E0A\u4F20" }), _jsx("span", { className: "hint", children: "\u6587\u4EF6\u540D\u5E26\u96C6\u53F7\u5373\u53EF\uFF1Aep01.mp4\u3001EP 2.mov\u3001003.mp4\u2026" }), files.length > 0 && (_jsx("div", { className: "right", children: _jsx("button", { className: "btn ghost sm", onClick: () => setFiles([]), children: "\u6E05\u7A7A" }) }))] }), _jsxs("div", { className: "panel-body stack", style: { gap: 16 }, children: [_jsxs("div", { className: `dropzone ${over ? 'over' : ''}`, onDragOver: (e) => {
                            e.preventDefault();
                            setOver(true);
                        }, onDragLeave: () => setOver(false), onDrop: async (e) => {
                            e.preventDefault();
                            setOver(false);
                            addFiles(await filesFromDrop(e));
                        }, onClick: () => fileInput.current?.click(), role: "button", tabIndex: 0, children: [_jsx("h3", { children: "\u628A\u6574\u90E8\u5267\u7684\u89C6\u9891\u62D6\u5230\u8FD9\u91CC" }), _jsxs("p", { children: ["\u53EF\u4EE5\u62D6\u6587\u4EF6\u5939 \u00B7 \u6216", ' ', _jsx("button", { type: "button", className: "btn ghost sm", onClick: (e) => {
                                            e.stopPropagation();
                                            folderInput.current?.click();
                                        }, children: "\u9009\u62E9\u6587\u4EF6\u5939" }), ' ', "\u00B7 \u652F\u6301\u5927\u6587\u4EF6\u548C\u65AD\u70B9\u7EED\u4F20"] }), _jsx("input", { ref: fileInput, type: "file", accept: "video/*", multiple: true, hidden: true, onChange: (e) => addFiles([...(e.target.files ?? [])]) }), _jsx("input", { ref: folderInput, type: "file", hidden: true, multiple: true, ...{ webkitdirectory: '' }, onChange: (e) => addFiles([...(e.target.files ?? [])]) })] }), files.length > 0 && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid-4", children: [_jsxs("label", { className: "field", children: [_jsx("span", { children: "\u524D\u51E0\u96C6\u514D\u8D39" }), _jsx("input", { className: "input mono", type: "number", min: 0, value: freeCount, onChange: (e) => setFreeCount(Number(e.target.value)) })] }), _jsxs("label", { className: "field", children: [_jsx("span", { children: "\u770B\u5E7F\u544A\u89E3\u9501\u7684\u96C6\uFF08\u5982 4, 6-7\uFF09" }), _jsx("input", { className: "input mono", value: adText, onChange: (e) => setAdText(e.target.value), placeholder: "\u7559\u7A7A = \u6CA1\u6709" })] }), _jsxs("label", { className: "field", children: [_jsx("span", { children: "\u5176\u4F59\u96C6" }), _jsxs("select", { className: "select", value: rest, onChange: (e) => setRest(e.target.value), children: [_jsx("option", { value: "coin", children: "\u91D1\u5E01\u89E3\u9501" }), _jsx("option", { value: "subscriber", children: "\u4F1A\u5458\u4E13\u4EAB" })] })] }), _jsxs("label", { className: "field", children: [_jsx("span", { children: "\u91D1\u5E01\u4EF7\u683C" }), _jsx("input", { className: "input mono", type: "number", min: 1, value: coinPrice, disabled: rest !== 'coin', onChange: (e) => setCoinPrice(Number(e.target.value)) })] })] }), ruleError && _jsx("p", { className: "error-text", children: ruleError }), _jsxs("div", { className: "chips", style: { gap: 18 }, children: [_jsxs("label", { className: "dim", style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }, children: [_jsx("input", { type: "checkbox", checked: autoPublish, onChange: (e) => setAutoPublish(e.target.checked) }), "\u5904\u7406\u5B8C\u81EA\u52A8\u53D1\u5E03"] }), _jsxs("label", { className: "dim", style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }, children: [_jsx("input", { type: "checkbox", checked: applyToExisting, onChange: (e) => setApplyToExisting(e.target.checked) }), "\u5DF2\u6709\u7684\u96C6\u4E5F\u6309\u4E0A\u9762\u7684\u89C4\u5219\u6539\u4ED8\u8D39\u65B9\u5F0F"] }), _jsxs("label", { className: "dim", style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }, children: [_jsx("input", { type: "checkbox", checked: reuploadReady, onChange: (e) => setReuploadReady(e.target.checked) }), "\u5DF2\u6709\u89C6\u9891\u7684\u96C6\u4E5F\u91CD\u65B0\u4E0A\u4F20\uFF08\u66FF\u6362\u65E7\u89C6\u9891\uFF09"] })] }), _jsx("div", { className: "panel table-wrap", style: { boxShadow: 'none' }, children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { style: { width: 60 }, children: "\u96C6" }), _jsx("th", { children: "\u6587\u4EF6" }), _jsx("th", { style: { width: 100 }, children: "\u5927\u5C0F" }), _jsx("th", { style: { width: 120 }, children: "\u5267\u96C6" }), _jsx("th", { style: { width: 140 }, children: "\u4ED8\u8D39\u65B9\u5F0F" }), _jsx("th", { style: { width: 130 }, children: "\u73B0\u6709\u89C6\u9891" })] }) }), _jsx("tbody", { children: rows.map((r) => (_jsxs("tr", { style: { opacity: r.skip ? 0.45 : 1 }, children: [_jsxs("td", { className: "num", children: ["EP", String(r.number).padStart(2, '0')] }), _jsxs("td", { className: "mono", style: { fontSize: 12, wordBreak: 'break-all' }, children: [r.file.name, r.skip && _jsx("span", { className: "muted", children: " \u00B7 \u5DF2\u6709\u89C6\u9891\uFF0C\u8DF3\u8FC7" })] }), _jsx("td", { className: "num", children: fmtBytes(r.file.size) }), _jsx("td", { children: r.existing ? _jsx("span", { className: "badge plain", children: "\u5DF2\u6709" }) : _jsx("span", { className: "badge blue plain", children: "\u65B0\u5EFA" }) }), _jsx("td", { children: r.willSetAccess && r.planned ? (_jsx(AccessBadge, { access: r.planned.access, coinPrice: r.planned.coinPrice })) : r.existing ? (_jsxs("span", { className: "muted", title: "\u4FDD\u6301\u4E0D\u53D8", children: [ACCESS_LABEL[r.existing.access], "\uFF08\u4E0D\u53D8\uFF09"] })) : null }), _jsx("td", { children: r.existing ? _jsx(VideoBadge, { video: r.video }) : _jsx("span", { className: "muted", children: "\u2014" }) })] }, r.id))) })] }) }), (match.unmatched.length > 0 || match.duplicates.length > 0) && (_jsxs("p", { className: "dim", style: { margin: 0, fontSize: 13 }, children: [match.unmatched.length > 0 && (_jsxs(_Fragment, { children: ["\u5FFD\u7565 ", match.unmatched.length, " \u4E2A\u8BA4\u4E0D\u51FA\u96C6\u53F7\u7684\u6587\u4EF6\uFF1A", _jsx("span", { className: "mono", children: match.unmatched.slice(0, 5).map((f) => f.name).join('、') }), match.unmatched.length > 5 && ' …'] })), match.duplicates.length > 0 && _jsxs(_Fragment, { children: [" \u00B7 \u96C6\u53F7\u91CD\u590D\uFF08\u53EA\u53D6\u7B2C\u4E00\u4E2A\uFF09\uFF1A", match.duplicates.join(', ')] })] })), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 14 }, children: [_jsxs("button", { className: "btn primary", disabled: !rule || toUpload.length === 0, onClick: start, children: ["\u5F00\u59CB\u4E0A\u4F20 ", toUpload.length, " \u96C6 \u00B7 ", fmtBytes(totalBytes)] }), _jsx("span", { className: "muted", style: { fontSize: 12 }, children: "\u540C\u65F6\u4F20 2 \u96C6\uFF1B\u4E0A\u4F20\u4E2D\u8BF7\u522B\u5173\u95ED\u8FD9\u4E2A\u9875\u9762\uFF08\u5173\u4E86\u4E5F\u80FD\u91CD\u65B0\u62D6\u5165\u540C\u6837\u7684\u6587\u4EF6\u7EE7\u7EED\u4F20\uFF09\u3002" })] })] }))] })] }));
}
