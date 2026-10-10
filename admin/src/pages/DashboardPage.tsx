import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { budgetLevel, deliveryCost, storageCost, usd } from '../lib/costs';
import { useI18n } from '../lib/i18n';
import { ErrorBox, fmtDateTime, fmtNumber, Loading, useLoad } from '../ui';

export function DashboardPage() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useLoad(async () => {
    const [stats, config] = await Promise.all([api.dashboard(), api.config()]);
    const soft = Number(config.find((c) => c.key === 'budget_soft_ratio')?.value ?? 0.8);
    return { stats, soft };
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">Overview</div>
          <h1>{t('dash.title')}</h1>
        </div>
        <div className="actions">
          <button className="btn" onClick={reload}>
            {t('common.refresh')}
          </button>
          <Link className="btn primary" to="/series">
            {t('dash.upload')}
          </Link>
        </div>
      </div>

      {loading && !data ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : data && <Overview d={data.stats} softRatio={data.soft} />}
    </>
  );
}

function Overview({ d, softRatio }: { d: Awaited<ReturnType<typeof api.dashboard>>; softRatio: number }) {
  const { t } = useI18n();
  const level = budgetLevel(d.today_minutes, d.daily_minutes_budget, softRatio);
  const pct = d.daily_minutes_budget > 0 ? Math.min(100, (d.today_minutes / d.daily_minutes_budget) * 100) : 0;
  return (
    <div className="stack">
      <div className="stats">
        <div className="stat">
          <div className="label">{t('dash.series')}</div>
          <div className="value">{fmtNumber(d.series)}</div>
          <div className="sub">{t('dash.publishedOf', { published: fmtNumber(d.episodes_published), total: fmtNumber(d.episodes_total) })}</div>
        </div>
        <div className="stat accent">
          <div className="label">{t('dash.readyVideos')}</div>
          <div className="value">{fmtNumber(d.videos_ready)}</div>
          <div className="sub">{t('dash.processingFailed', { processing: d.videos_processing, failed: d.videos_failed })}</div>
        </div>
        <div className="stat money">
          <div className="label">{t('dash.storage')}</div>
          <div className="value">{t('dash.minutesValue', { n: fmtNumber(d.stored_minutes) })}</div>
          <div className="sub">{t('dash.perMonth', { cost: usd(storageCost(d.stored_minutes)) })}</div>
        </div>
        <div className="stat money">
          <div className="label">{t('dash.today')}</div>
          <div className="value">{t('dash.minutesValue', { n: fmtNumber(Math.round(d.today_minutes)) })}</div>
          <div className="sub">{t('dash.todaySub', { cost: usd(deliveryCost(d.today_minutes)), at: fmtDateTime(d.usage_synced_at) })}</div>
        </div>
        <div className="stat">
          <div className="label">{t('dash.users')}</div>
          <div className="value">{fmtNumber(d.users_total)}</div>
          <div className="sub">{t('dash.usersSub', { guests: fmtNumber(d.users_guest), tokens: fmtNumber(d.tokens_today) })}</div>
        </div>
        <Link to="/abuse" className={`stat ${d.open_abuse_flags > 0 ? 'alert' : ''}`}>
          <div className="label">{t('dash.openFlags')}</div>
          <div className="value">{fmtNumber(d.open_abuse_flags)}</div>
          <div className="sub">{t('dash.openFlagsSub')}</div>
        </Link>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{t('dash.budgetTitle')}</h2>
          <span className="hint">{t('dash.budgetHint', { pct: Math.round(softRatio * 100) })}</span>
          <div className="right">
            <Link className="btn sm" to="/costs">
              {t('dash.setBudget')}
            </Link>
          </div>
        </div>
        <div className="panel-body">
          {level === 'off' ? (
            <p className="dim" style={{ margin: 0 }}>
              {t('dash.noBudget')}
            </p>
          ) : (
            <>
              <div className={`meter ${level === 'soft' ? 'soft' : level === 'hard' ? 'hard' : ''}`}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <p className="mono dim" style={{ margin: '8px 0 0' }}>
                {t('dash.meter', { used: fmtNumber(Math.round(d.today_minutes)), budget: fmtNumber(d.daily_minutes_budget), pct: pct.toFixed(0) })}
                {level === 'soft' && t('dash.softOn')}
                {level === 'hard' && t('dash.hardOn')}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
