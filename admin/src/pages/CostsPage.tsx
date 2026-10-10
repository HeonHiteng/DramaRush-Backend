import { useState } from 'react';
import { api, type ConfigRow, type UsageDay } from '../lib/api';
import { budgetLevel, deliveryCost, storageCost, usd } from '../lib/costs';
import { ErrorBox, fmtDateTime, fmtNumber, Loading, useLoad, useToast } from '../ui';

/** Settings the console can change (same whitelist as admin_set_config). */
const SETTINGS: { key: string; label: string; hint: string; kind: 'int' | 'ratio' | 'bool'; unit?: string }[] = [
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

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">Costs</div>
          <h1>成本与预算</h1>
        </div>
        <div className="actions">
          <button className="btn" onClick={reload}>
            刷新
          </button>
        </div>
      </div>
      {loading && !data ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : data && <Costs {...data} onSaved={reload} />}
    </>
  );
}

function Costs({
  usage,
  config,
  stats,
  onSaved,
}: {
  usage: UsageDay[];
  config: ConfigRow[];
  stats: Awaited<ReturnType<typeof api.dashboard>>;
  onSaved: () => void;
}) {
  const cfg = new Map(config.map((c) => [c.key, c.value]));
  const budget = Number(cfg.get('daily_minutes_budget') ?? 0);
  const soft = Number(cfg.get('budget_soft_ratio') ?? 0.8);
  const days = fillDays(usage, 30);
  const total30 = days.reduce((s, d) => s + d.minutes, 0);
  const max = Math.max(1, budget, ...days.map((d) => d.minutes));
  const today = days[days.length - 1]?.minutes ?? 0;
  const level = budgetLevel(today, budget, soft);

  return (
    <div className="stack">
      <div className="stats">
        <div className="stat money">
          <div className="label">近 30 天播放</div>
          <div className="value">{fmtNumber(Math.round(total30))}</div>
          <div className="sub">分钟 · 约 {usd(deliveryCost(total30))}</div>
        </div>
        <div className="stat money">
          <div className="label">片库存储</div>
          <div className="value">{fmtNumber(stats.stored_minutes)}</div>
          <div className="sub">分钟 · 约 {usd(storageCost(stats.stored_minutes))} / 月（按 1,000 分钟一档）</div>
        </div>
        <div className={`stat ${level === 'hard' ? 'alert' : level === 'soft' ? 'money' : ''}`}>
          <div className="label">今天</div>
          <div className="value">{fmtNumber(Math.round(today))}</div>
          <div className="sub">
            {budget > 0 ? `预算 ${fmtNumber(budget)} 分钟` : '未设预算'} · 同步于 {fmtDateTime(stats.usage_synced_at)}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>每日播放分钟（Cloudflare Stream）</h2>
          <span className="hint">每小时同步一次 · 价格 $1 / 1,000 分钟 · 仅为估算，以 Cloudflare 账单为准</span>
        </div>
        <div className="panel-body">
          <div className="bars">
            {budget > 0 && (
              <div className="budget-line" style={{ bottom: `${(budget / max) * 100}%` }}>
                <span>预算 {fmtNumber(budget)}</span>
              </div>
            )}
            {days.map((d) => (
              <div key={d.day} className="bar" style={{ height: `${(d.minutes / max) * 100}%` }}>
                <div className="tip">
                  {d.day.slice(5)} · {fmtNumber(Math.round(d.minutes))} 分钟 · {usd(deliveryCost(d.minutes))}
                </div>
              </div>
            ))}
          </div>
          <div className="axis">
            <span>{days[0]?.day.slice(5)}</span>
            <span>今天</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>预算与限制</h2>
          <span className="hint">改完立即生效</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {SETTINGS.map((s) => (
                <SettingRow key={s.key} setting={s} value={cfg.get(s.key)} onSaved={onSaved} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ setting, value, onSaved }: { setting: (typeof SETTINGS)[number]; value: unknown; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState(String(value ?? ''));
  const [busy, setBusy] = useState(false);
  const dirty = setting.kind !== 'bool' && draft !== String(value ?? '');

  const save = async (next: unknown) => {
    setBusy(true);
    try {
      await api.setConfig(setting.key, next);
      toast.show(`「${setting.label}」已更新`);
      onSaved();
    } catch (e) {
      toast.show(friendlyConfigError(e instanceof Error ? e.message : String(e)), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td style={{ width: '42%' }}>
        <div>{setting.label}</div>
        {setting.hint && <div className="muted" style={{ fontSize: 12 }}>{setting.hint}</div>}
      </td>
      <td>
        {setting.kind === 'bool' ? (
          <button className={`toggle ${value === true ? 'on' : ''}`} disabled={busy} onClick={() => save(value !== true)} aria-label={setting.label} />
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="input mono"
              style={{ width: 160 }}
              type="number"
              step={setting.kind === 'ratio' ? 0.05 : 1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && dirty && save(Number(draft))}
            />
            {setting.unit && <span className="muted">{setting.unit}</span>}
            {dirty && (
              <button className="btn primary sm" disabled={busy || draft === ''} onClick={() => save(Number(draft))}>
                保存
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/** admin_set_config raises English messages; show them in plain Chinese. */
function friendlyConfigError(message: string): string {
  const range = /between ([\d.]+) and ([\d.]+)/.exec(message);
  if (message.startsWith('invalid_value') && range) {
    return message.includes('whole number') ? `请输入 ${range[1]}–${range[2]} 之间的整数` : `请输入 ${range[1]}–${range[2]} 之间的数`;
  }
  if (message.startsWith('invalid_value')) return '这个值不合法';
  if (message.startsWith('unknown_setting')) return '这个设置不能在后台修改';
  if (message === 'admin_only') return '只有管理员可以修改';
  return message;
}

/** One entry per UTC day for the last `n` days, zero-filled. */
function fillDays(usage: UsageDay[], n: number): { day: string; minutes: number }[] {
  const byDay = new Map(usage.map((u) => [u.day, Number(u.minutes_viewed)]));
  const out: { day: string; minutes: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    out.push({ day, minutes: byDay.get(day) ?? 0 });
  }
  return out;
}
