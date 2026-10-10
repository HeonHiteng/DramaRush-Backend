import { useState, type FormEvent } from 'react';
import { api, type AdminUser } from '../lib/api';
import { Confirm, ErrorBox, fmtDateTime, fmtNumber, Loading, Modal, useLoad, useToast } from '../ui';

const DECISION_LABEL: Record<string, { text: string; cls: string }> = {
  granted: { text: '放行', cls: 'green' },
  not_entitled: { text: '未解锁', cls: '' },
  unavailable: { text: '无视频', cls: '' },
  rate_limited: { text: '触发限流', cls: 'red' },
  blocked: { text: '封禁中', cls: 'red' },
  budget: { text: '预算暂停', cls: 'amber' },
};

const REASON_LABEL: Record<string, string> = {
  playback_rate_limit: '取片过于频繁',
  manual_block: '管理员手动封禁',
};

export function AbusePage() {
  const toast = useToast();
  const [openOnly, setOpenOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<AdminUser[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [resolving, setResolving] = useState<number | null>(null);

  const flags = useLoad(() => api.abuseFlags(openOnly), [openOnly]);
  const recent = useLoad(() => api.playbackEvents(null, 60), []);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    setSearchError(null);
    try {
      setFound(await api.findUser(query.trim()));
    } catch (err) {
      setFound(null);
      setSearchError(err instanceof Error ? err.message.replace(/^invalid_value: /, '') : String(err));
    }
  };

  const openUser = async (userId: string, code: string | null) => {
    try {
      const users = code ? await api.findUser(code) : [];
      const u = users.find((x) => x.user_id === userId);
      if (u) setSelected(u);
      else toast.show('找不到这个账号的详情', 'err');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">Abuse &amp; logs</div>
          <h1>异常与日志</h1>
        </div>
      </div>

      <div className="stack">
        <div className="panel">
          <div className="panel-head">
            <h2>按水印码查账号</h2>
            <span className="hint">盗版视频上的 7 位码 = 泄露的账号；也可以输入邮箱查找</span>
          </div>
          <div className="panel-body">
            <form onSubmit={search} style={{ display: 'flex', gap: 10 }}>
              <input className="input mono" style={{ maxWidth: 320 }} placeholder="例如 ZLG4FVC 或 name@mail.com" value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className="btn primary" type="submit" disabled={query.trim().length < 3}>
                查找
              </button>
            </form>
            {searchError && <p className="error-text">{searchError}</p>}
            {found && (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                {found.length === 0 ? (
                  <div className="empty">没有找到</div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>水印码</th>
                        <th>账号</th>
                        <th>注册时间</th>
                        <th>余额</th>
                        <th>会员</th>
                        <th>状态</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {found.map((u) => (
                        <UserRow key={u.user_id} user={u} onOpen={() => setSelected(u)} />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>异常账号</h2>
            <span className="hint">取片过于频繁的账号会被自动暂停播放</span>
            <div className="right">
              <label className="dim" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={!openOnly} onChange={(e) => setOpenOnly(!e.target.checked)} />
                包含已处理
              </label>
              <button className="btn sm" onClick={flags.reload}>
                刷新
              </button>
            </div>
          </div>
          {flags.loading && !flags.data ? (
            <Loading />
          ) : flags.error ? (
            <ErrorBox message={flags.error} onRetry={flags.reload} />
          ) : flags.data!.length === 0 ? (
            <div className="empty">{openOnly ? '目前没有待处理的异常 👍' : '还没有任何异常记录'}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>账号</th>
                    <th>原因</th>
                    <th>详情</th>
                    <th>封禁到</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {flags.data!.map((f) => {
                    const active = !f.resolved_at && f.blocks_playback_until && new Date(f.blocks_playback_until) > new Date();
                    return (
                      <tr key={f.id}>
                        <td className="num">{fmtDateTime(f.created_at)}</td>
                        <td>
                          <button className="btn ghost sm mono" onClick={() => openUser(f.user_id, f.public_code)}>
                            {f.public_code ?? '—'}
                          </button>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {f.is_anonymous ? '游客' : f.email}
                          </div>
                        </td>
                        <td>{REASON_LABEL[f.reason] ?? f.reason}</td>
                        <td className="mono muted" style={{ fontSize: 12 }}>
                          {describeDetails(f.details)}
                        </td>
                        <td>
                          {f.resolved_at ? (
                            <span className="badge plain">已解除</span>
                          ) : active ? (
                            <span className="badge red">{fmtDateTime(f.blocks_playback_until)}</span>
                          ) : (
                            <span className="badge plain">已过期</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {active && (
                            <button className="btn sm" onClick={() => setResolving(f.id)}>
                              解除
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>最近播放请求</h2>
            <span className="hint">每次 App 申请播放链接都会记录</span>
            <div className="right">
              <button className="btn sm" onClick={recent.reload}>
                刷新
              </button>
            </div>
          </div>
          {recent.loading && !recent.data ? <Loading /> : recent.error ? <ErrorBox message={recent.error} /> : <EventsTable events={recent.data!} />}
        </div>
      </div>

      {resolving !== null && (
        <Confirm
          title="解除封禁？"
          confirmLabel="解除"
          body="这个账号会立刻恢复播放。"
          onClose={() => setResolving(null)}
          onConfirm={async () => {
            await api.resolveFlag(resolving);
            toast.show('已解除');
            flags.reload();
          }}
        />
      )}
      {selected && (
        <UserDetail
          user={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            flags.reload();
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

function describeDetails(d: Record<string, unknown>): string {
  if (d.note) return String(d.note);
  const parts: string[] = [];
  if (d.tokens_10min !== undefined) parts.push(`10分钟 ${d.tokens_10min} 次`);
  if (d.episodes_1h !== undefined) parts.push(`1小时 ${d.episodes_1h} 集`);
  if (d.client_ip) parts.push(String(d.client_ip));
  return parts.join(' · ') || '—';
}

function UserRow({ user: u, onOpen }: { user: AdminUser; onOpen: () => void }) {
  return (
    <tr>
      <td className="mono">{u.public_code}</td>
      <td>
        {u.display_name}
        <div className="muted" style={{ fontSize: 12 }}>
          {u.is_anonymous ? '游客' : u.email}
          {u.is_admin && ' · 管理员'}
        </div>
      </td>
      <td className="num">{fmtDateTime(u.created_at)}</td>
      <td className="num">{fmtNumber(u.balance)}</td>
      <td>{u.is_member ? <span className="badge blue">到 {fmtDateTime(u.member_until)}</span> : <span className="muted">—</span>}</td>
      <td>{u.blocked_until ? <span className="badge red">封禁中</span> : <span className="badge green">正常</span>}</td>
      <td style={{ textAlign: 'right' }}>
        <button className="btn sm" onClick={onOpen}>
          详情
        </button>
      </td>
    </tr>
  );
}

function EventsTable({ events }: { events: Awaited<ReturnType<typeof api.playbackEvents>> }) {
  if (events.length === 0) return <div className="empty">还没有播放记录</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 460 }}>
      <table className="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>账号</th>
            <th>剧集</th>
            <th>结果</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const d = DECISION_LABEL[e.decision] ?? { text: e.decision, cls: '' };
            return (
              <tr key={e.id}>
                <td className="num">{fmtDateTime(e.created_at)}</td>
                <td className="mono">{e.public_code ?? '—'}</td>
                <td>
                  {e.series_title ?? e.episode_id}
                  {e.episode_number !== null && <span className="muted mono"> · EP{e.episode_number}</span>}
                </td>
                <td>
                  <span className={`badge ${d.cls}`}>{d.text}</span>
                </td>
                <td className="mono muted" style={{ fontSize: 12 }}>
                  {e.client_ip ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UserDetail({ user, onClose, onChanged }: { user: AdminUser; onClose: () => void; onChanged: () => void }) {
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
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'err');
      setBusy(false);
    }
  };

  return (
    <Modal title={`账号 ${user.public_code}`} onClose={onClose}>
      <div className="stack" style={{ gap: 18 }}>
        <dl className="kv" style={{ gridTemplateColumns: 'repeat(4, auto)' }}>
          <dt>昵称</dt>
          <dt>账号</dt>
          <dt>余额</dt>
          <dt>解锁集数</dt>
          <dd style={{ fontFamily: 'var(--font-ui)' }}>{user.display_name}</dd>
          <dd>{user.is_anonymous ? '游客' : user.email}</dd>
          <dd>{fmtNumber(user.balance)}</dd>
          <dd>{fmtNumber(user.unlock_count)}</dd>
        </dl>

        <div className="panel" style={{ boxShadow: 'none' }}>
          <div className="panel-head">
            <h2>封禁播放</h2>
            {user.blocked_until && <span className="badge red">已封禁到 {fmtDateTime(user.blocked_until)}</span>}
          </div>
          <div className="panel-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="field">
              <span>时长</span>
              <select className="select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                <option value={60}>1 小时</option>
                <option value={1440}>1 天</option>
                <option value={10080}>7 天</option>
                <option value={43200}>30 天</option>
                <option value={525600}>1 年</option>
              </select>
            </label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}>
              <span>原因（内部备注）</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：在某平台发现泄露的第 12 集" />
            </label>
            <button className="btn danger" disabled={busy} onClick={block}>
              封禁
            </button>
          </div>
        </div>

        <div>
          <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>播放记录</h2>
          {events.loading && !events.data ? <Loading /> : events.error ? <ErrorBox message={events.error} /> : <EventsTable events={events.data!} />}
        </div>
      </div>
    </Modal>
  );
}
