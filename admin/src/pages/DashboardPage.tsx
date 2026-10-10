import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { budgetLevel, deliveryCost, storageCost, usd } from '../lib/costs';
import { ErrorBox, fmtDateTime, fmtNumber, Loading, useLoad } from '../ui';

export function DashboardPage() {
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
          <h1>总览</h1>
        </div>
        <div className="actions">
          <button className="btn" onClick={reload}>
            刷新
          </button>
          <Link className="btn primary" to="/series">
            上传视频
          </Link>
        </div>
      </div>

      {loading && !data ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : data && <Overview d={data.stats} softRatio={data.soft} />}
    </>
  );
}

function Overview({ d, softRatio }: { d: Awaited<ReturnType<typeof api.dashboard>>; softRatio: number }) {
  const level = budgetLevel(d.today_minutes, d.daily_minutes_budget, softRatio);
  const pct = d.daily_minutes_budget > 0 ? Math.min(100, (d.today_minutes / d.daily_minutes_budget) * 100) : 0;
  return (
    <div className="stack">
      <div className="stats">
        <div className="stat">
          <div className="label">剧集</div>
          <div className="value">{fmtNumber(d.series)}</div>
          <div className="sub">
            {fmtNumber(d.episodes_published)} / {fmtNumber(d.episodes_total)} 集已发布
          </div>
        </div>
        <div className="stat accent">
          <div className="label">就绪视频</div>
          <div className="value">{fmtNumber(d.videos_ready)}</div>
          <div className="sub">
            处理中 {d.videos_processing} · 失败 {d.videos_failed}
          </div>
        </div>
        <div className="stat money">
          <div className="label">片库存储</div>
          <div className="value">{fmtNumber(d.stored_minutes)} 分钟</div>
          <div className="sub">约 {usd(storageCost(d.stored_minutes))} / 月</div>
        </div>
        <div className="stat money">
          <div className="label">今日播放</div>
          <div className="value">{fmtNumber(Math.round(d.today_minutes))} 分钟</div>
          <div className="sub">
            约 {usd(deliveryCost(d.today_minutes))} · 同步于 {fmtDateTime(d.usage_synced_at)}
          </div>
        </div>
        <div className="stat">
          <div className="label">用户</div>
          <div className="value">{fmtNumber(d.users_total)}</div>
          <div className="sub">其中游客 {fmtNumber(d.users_guest)} · 今日取片 {fmtNumber(d.tokens_today)} 次</div>
        </div>
        <Link to="/abuse" className={`stat ${d.open_abuse_flags > 0 ? 'alert' : ''}`}>
          <div className="label">待处理异常</div>
          <div className="value">{fmtNumber(d.open_abuse_flags)}</div>
          <div className="sub">被限流或封禁的账号 →</div>
        </Link>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>今日播放预算</h2>
          <span className="hint">超过 {Math.round(softRatio * 100)}% 暂停免费集，100% 暂停免费和广告集，付费集照常播放</span>
          <div className="right">
            <Link className="btn sm" to="/costs">
              设置预算
            </Link>
          </div>
        </div>
        <div className="panel-body">
          {level === 'off' ? (
            <p className="dim" style={{ margin: 0 }}>
              还没设每日预算。建议在「成本与预算」里设一个上限，防止账单失控。
            </p>
          ) : (
            <>
              <div className={`meter ${level === 'soft' ? 'soft' : level === 'hard' ? 'hard' : ''}`}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <p className="mono dim" style={{ margin: '8px 0 0' }}>
                {fmtNumber(Math.round(d.today_minutes))} / {fmtNumber(d.daily_minutes_budget)} 分钟（{pct.toFixed(0)}%）
                {level === 'soft' && ' · 已暂停免费集'}
                {level === 'hard' && ' · 只放行付费集'}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
