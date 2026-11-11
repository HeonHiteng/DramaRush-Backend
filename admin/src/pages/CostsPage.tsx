import { useState } from 'react';
import { api, type ConfigRow, type UsageDay } from '../lib/api';
import { budgetLevel, deliveryCost, storageCost, usd } from '../lib/costs';
import { t as translate, useI18n, type MsgKey } from '../lib/i18n';
import { ErrorBox, fmtDateTime, fmtNumber, Loading, useLoad, useToast } from '../ui';

/** Settings the console can change (same whitelist as admin_set_config). */
const SETTINGS: { key: string; label: MsgKey; hint?: MsgKey; kind: 'int' | 'ratio' | 'bool'; unit?: MsgKey }[] = [
  { key: 'daily_minutes_budget', label: 'set.daily_minutes_budget', hint: 'set.daily_minutes_budget.hint', kind: 'int', unit: 'unit.minutes' },
  { key: 'budget_soft_ratio', label: 'set.budget_soft_ratio', hint: 'set.budget_soft_ratio.hint', kind: 'ratio' },
  { key: 'playback_max_tokens_per_10min', label: 'set.playback_max_tokens_per_10min', hint: 'set.playback_max_tokens_per_10min.hint', kind: 'int', unit: 'unit.times' },
  { key: 'playback_max_episodes_per_hour', label: 'set.playback_max_episodes_per_hour', hint: 'set.playback_max_episodes_per_hour.hint', kind: 'int', unit: 'unit.episodes' },
  { key: 'playback_block_minutes', label: 'set.playback_block_minutes', kind: 'int', unit: 'unit.minutes' },
  { key: 'playback_token_ttl_seconds', label: 'set.playback_token_ttl_seconds', hint: 'set.playback_token_ttl_seconds.hint', kind: 'int', unit: 'unit.seconds' },
  { key: 'welcome_bonus_coins', label: 'set.welcome_bonus_coins', hint: 'set.welcome_bonus_coins.hint', kind: 'int', unit: 'unit.coins' },
  { key: 'guest_new_per_ip_per_day', label: 'set.guest_new_per_ip_per_day', hint: 'set.guest_new_per_ip_per_day.hint', kind: 'int', unit: 'unit.accounts' },
  { key: 'starting_coins_guest', label: 'set.starting_coins_guest', hint: 'set.starting_coins_guest.hint', kind: 'int', unit: 'unit.coins' },
  { key: 'starting_coins_member', label: 'set.starting_coins_member', hint: 'set.starting_coins_member.hint', kind: 'int', unit: 'unit.coins' },
  { key: 'ad_unlocks_per_day', label: 'set.ad_unlocks_per_day', kind: 'int', unit: 'unit.episodes' },
  { key: 'daily_mission_reward', label: 'set.daily_mission_reward', kind: 'int', unit: 'unit.coins' },
  { key: 'simulated_payments', label: 'set.simulated_payments', hint: 'set.simulated_payments.hint', kind: 'bool' },
];

export function CostsPage() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useLoad(async () => {
    const [usage, config, stats] = await Promise.all([api.usage(30), api.config(), api.dashboard()]);
    return { usage, config, stats };
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">Costs</div>
          <h1>{t('costs.title')}</h1>
        </div>
        <div className="actions">
          <button className="btn" onClick={reload}>
            {t('common.refresh')}
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
  const { t } = useI18n();
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
          <div className="label">{t('costs.last30')}</div>
          <div className="value">{fmtNumber(Math.round(total30))}</div>
          <div className="sub">{t('costs.minutesApprox', { cost: usd(deliveryCost(total30)) })}</div>
        </div>
        <div className="stat money">
          <div className="label">{t('costs.storage')}</div>
          <div className="value">{fmtNumber(stats.stored_minutes)}</div>
          <div className="sub">{t('costs.storageSub', { cost: usd(storageCost(stats.stored_minutes)) })}</div>
        </div>
        <div className={`stat ${level === 'hard' ? 'alert' : level === 'soft' ? 'money' : ''}`}>
          <div className="label">{t('costs.today')}</div>
          <div className="value">{fmtNumber(Math.round(today))}</div>
          <div className="sub">
            {budget > 0 ? t('costs.budgetN', { n: fmtNumber(budget) }) : t('costs.noBudget')} · {t('costs.synced', { at: fmtDateTime(stats.usage_synced_at) })}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('costs.chartTitle')}</h2>
          <span className="hint">{t('costs.chartHint')}</span>
        </div>
        <div className="panel-body">
          <div className="bars">
            {budget > 0 && (
              <div className="budget-line" style={{ bottom: `${(budget / max) * 100}%` }}>
                <span>{t('costs.budgetLine', { n: fmtNumber(budget) })}</span>
              </div>
            )}
            {days.map((d) => (
              <div key={d.day} className="bar" style={{ height: `${(d.minutes / max) * 100}%` }}>
                <div className="tip">
                  {t('costs.tip', { day: d.day.slice(5), n: fmtNumber(Math.round(d.minutes)), cost: usd(deliveryCost(d.minutes)) })}
                </div>
              </div>
            ))}
          </div>
          <div className="axis">
            <span>{days[0]?.day.slice(5)}</span>
            <span>{t('costs.todayAxis')}</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('costs.settingsTitle')}</h2>
          <span className="hint">{t('costs.settingsHint')}</span>
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
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value ?? ''));
  const [busy, setBusy] = useState(false);
  const dirty = setting.kind !== 'bool' && draft !== String(value ?? '');

  const save = async (next: unknown) => {
    setBusy(true);
    try {
      await api.setConfig(setting.key, next);
      toast.show(t('costs.updated', { label: t(setting.label) }));
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
        <div>{t(setting.label)}</div>
        {setting.hint && (
          <div className="muted" style={{ fontSize: 12 }}>
            {t(setting.hint)}
          </div>
        )}
      </td>
      <td>
        {setting.kind === 'bool' ? (
          <button className={`toggle ${value === true ? 'on' : ''}`} disabled={busy} onClick={() => save(value !== true)} aria-label={t(setting.label)} />
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
            {setting.unit && <span className="muted">{t(setting.unit)}</span>}
            {dirty && (
              <button className="btn primary sm" disabled={busy || draft === ''} onClick={() => save(Number(draft))}>
                {t('common.save')}
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/** admin_set_config raises terse codes; show them as plain sentences. */
function friendlyConfigError(message: string): string {
  const range = /between ([\d.]+) and ([\d.]+)/.exec(message);
  if (message.startsWith('invalid_value') && range) {
    return translate(message.includes('whole number') ? 'costs.errRangeInt' : 'costs.errRange', { min: range[1], max: range[2] });
  }
  if (message.startsWith('invalid_value')) return translate('costs.errInvalid');
  if (message.startsWith('unknown_setting')) return translate('costs.errUnknown');
  if (message === 'admin_only') return translate('costs.errAdminOnly');
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
