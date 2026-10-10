import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { api } from '../lib/api';
import { budgetLevel, deliveryCost, storageCost, usd } from '../lib/costs';
import { ErrorBox, fmtDateTime, fmtNumber, Loading, useLoad, useToast } from '../ui';
/** Settings the console can change (same whitelist as admin_set_config). */
const SETTINGS = [
    { key: 'daily_minutes_budget', label: '每日播放预算', hint: '0 = 不限制。超过 80% 暂停免费集，100% 只放行付费集', kind: 'int', unit: '分钟' },
    { key: 'budget_soft_ratio', label: '预算预警线', hint: '到这个比例开始暂停免费集（0.1–1）', kind: 'ratio' },
    { key: 'playback_max_tokens_per_10min', label: '每人 10 分钟最多取片次数', hint: '超过即暂停该账号播放，并记为异常', kind: 'int', unit: '次' },
    { key: 'playback_max_episodes_per_hour', label: '每人每小时最多看几集', hint: '防批量扒片', kind: 'int', unit: '集' },
    { key: 'playback_block_minutes', label: '触发限流后封禁时长', hint: '', kind: 'int', unit: '分钟' },
    { key: 'playback_token_ttl_seconds', label: '播放链接有效期', hint: '越短越难转发，App 会自动续', kind: 'int', unit: '秒' },
    { key: 'starting_coins_guest', label: '游客注册赠币', hint: '游客号免费注册，给少一点防刷', kind: 'int', unit: '币' },
    { key: 'starting_coins_member', label: '正式会员注册赠币', hint: '', kind: 'int', unit: '币' },
    { key: 'ad_unlocks_per_day', label: '每人每天看广告解锁上限', hint: '', kind: 'int', unit: '集' },
    { key: 'daily_mission_reward', label: '每日任务奖励', hint: '', kind: 'int', unit: '币' },
    { key: 'simulated_payments', label: '模拟支付', hint: '上线接入真实支付前保持开启；关闭后模拟买币/开会员/重置都会失效', kind: 'bool' },
];
export function CostsPage() {
    const { data, error, loading, reload } = useLoad(async () => {
        const [usage, config, stats] = await Promise.all([api.usage(30), api.config(), api.dashboard()]);
        return { usage, config, stats };
    }, []);
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "page-head", children: [_jsxs("div", { children: [_jsx("div", { className: "kicker", children: "Costs" }), _jsx("h1", { children: "\u6210\u672C\u4E0E\u9884\u7B97" })] }), _jsx("div", { className: "actions", children: _jsx("button", { className: "btn", onClick: reload, children: "\u5237\u65B0" }) })] }), loading && !data ? _jsx(Loading, {}) : error ? _jsx(ErrorBox, { message: error, onRetry: reload }) : data && _jsx(Costs, { ...data, onSaved: reload })] }));
}
function Costs({ usage, config, stats, onSaved, }) {
    const cfg = new Map(config.map((c) => [c.key, c.value]));
    const budget = Number(cfg.get('daily_minutes_budget') ?? 0);
    const soft = Number(cfg.get('budget_soft_ratio') ?? 0.8);
    const days = fillDays(usage, 30);
    const total30 = days.reduce((s, d) => s + d.minutes, 0);
    const max = Math.max(1, budget, ...days.map((d) => d.minutes));
    const today = days[days.length - 1]?.minutes ?? 0;
    const level = budgetLevel(today, budget, soft);
    return (_jsxs("div", { className: "stack", children: [_jsxs("div", { className: "stats", children: [_jsxs("div", { className: "stat money", children: [_jsx("div", { className: "label", children: "\u8FD1 30 \u5929\u64AD\u653E" }), _jsx("div", { className: "value", children: fmtNumber(Math.round(total30)) }), _jsxs("div", { className: "sub", children: ["\u5206\u949F \u00B7 \u7EA6 ", usd(deliveryCost(total30))] })] }), _jsxs("div", { className: "stat money", children: [_jsx("div", { className: "label", children: "\u7247\u5E93\u5B58\u50A8" }), _jsx("div", { className: "value", children: fmtNumber(stats.stored_minutes) }), _jsxs("div", { className: "sub", children: ["\u5206\u949F \u00B7 \u7EA6 ", usd(storageCost(stats.stored_minutes)), " / \u6708\uFF08\u6309 1,000 \u5206\u949F\u4E00\u6863\uFF09"] })] }), _jsxs("div", { className: `stat ${level === 'hard' ? 'alert' : level === 'soft' ? 'money' : ''}`, children: [_jsx("div", { className: "label", children: "\u4ECA\u5929" }), _jsx("div", { className: "value", children: fmtNumber(Math.round(today)) }), _jsxs("div", { className: "sub", children: [budget > 0 ? `预算 ${fmtNumber(budget)} 分钟` : '未设预算', " \u00B7 \u540C\u6B65\u4E8E ", fmtDateTime(stats.usage_synced_at)] })] })] }), _jsxs("div", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "\u6BCF\u65E5\u64AD\u653E\u5206\u949F\uFF08Cloudflare Stream\uFF09" }), _jsx("span", { className: "hint", children: "\u6BCF\u5C0F\u65F6\u540C\u6B65\u4E00\u6B21 \u00B7 \u4EF7\u683C $1 / 1,000 \u5206\u949F \u00B7 \u4EC5\u4E3A\u4F30\u7B97\uFF0C\u4EE5 Cloudflare \u8D26\u5355\u4E3A\u51C6" })] }), _jsxs("div", { className: "panel-body", children: [_jsxs("div", { className: "bars", children: [budget > 0 && (_jsx("div", { className: "budget-line", style: { bottom: `${(budget / max) * 100}%` }, children: _jsxs("span", { children: ["\u9884\u7B97 ", fmtNumber(budget)] }) })), days.map((d) => (_jsx("div", { className: "bar", style: { height: `${(d.minutes / max) * 100}%` }, children: _jsxs("div", { className: "tip", children: [d.day.slice(5), " \u00B7 ", fmtNumber(Math.round(d.minutes)), " \u5206\u949F \u00B7 ", usd(deliveryCost(d.minutes))] }) }, d.day)))] }), _jsxs("div", { className: "axis", children: [_jsx("span", { children: days[0]?.day.slice(5) }), _jsx("span", { children: "\u4ECA\u5929" })] })] })] }), _jsxs("div", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "\u9884\u7B97\u4E0E\u9650\u5236" }), _jsx("span", { className: "hint", children: "\u6539\u5B8C\u7ACB\u5373\u751F\u6548" })] }), _jsx("div", { className: "table-wrap", children: _jsx("table", { className: "table", children: _jsx("tbody", { children: SETTINGS.map((s) => (_jsx(SettingRow, { setting: s, value: cfg.get(s.key), onSaved: onSaved }, s.key))) }) }) })] })] }));
}
function SettingRow({ setting, value, onSaved }) {
    const toast = useToast();
    const [draft, setDraft] = useState(String(value ?? ''));
    const [busy, setBusy] = useState(false);
    const dirty = setting.kind !== 'bool' && draft !== String(value ?? '');
    const save = async (next) => {
        setBusy(true);
        try {
            await api.setConfig(setting.key, next);
            toast.show(`「${setting.label}」已更新`);
            onSaved();
        }
        catch (e) {
            toast.show(friendlyConfigError(e instanceof Error ? e.message : String(e)), 'err');
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("tr", { children: [_jsxs("td", { style: { width: '42%' }, children: [_jsx("div", { children: setting.label }), setting.hint && _jsx("div", { className: "muted", style: { fontSize: 12 }, children: setting.hint })] }), _jsx("td", { children: setting.kind === 'bool' ? (_jsx("button", { className: `toggle ${value === true ? 'on' : ''}`, disabled: busy, onClick: () => save(value !== true), "aria-label": setting.label })) : (_jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [_jsx("input", { className: "input mono", style: { width: 160 }, type: "number", step: setting.kind === 'ratio' ? 0.05 : 1, value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => e.key === 'Enter' && dirty && save(Number(draft)) }), setting.unit && _jsx("span", { className: "muted", children: setting.unit }), dirty && (_jsx("button", { className: "btn primary sm", disabled: busy || draft === '', onClick: () => save(Number(draft)), children: "\u4FDD\u5B58" }))] })) })] }));
}
/** admin_set_config raises English messages; show them in plain Chinese. */
function friendlyConfigError(message) {
    const range = /between ([\d.]+) and ([\d.]+)/.exec(message);
    if (message.startsWith('invalid_value') && range) {
        return message.includes('whole number') ? `请输入 ${range[1]}–${range[2]} 之间的整数` : `请输入 ${range[1]}–${range[2]} 之间的数`;
    }
    if (message.startsWith('invalid_value'))
        return '这个值不合法';
    if (message.startsWith('unknown_setting'))
        return '这个设置不能在后台修改';
    if (message === 'admin_only')
        return '只有管理员可以修改';
    return message;
}
/** One entry per UTC day for the last `n` days, zero-filled. */
function fillDays(usage, n) {
    const byDay = new Map(usage.map((u) => [u.day, Number(u.minutes_viewed)]));
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
        out.push({ day, minutes: byDay.get(day) ?? 0 });
    }
    return out;
}
