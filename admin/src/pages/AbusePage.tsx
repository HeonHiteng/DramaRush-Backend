import { useState, type FormEvent } from 'react';
import { api, type AdminUser } from '../lib/api';
import { useI18n, type MsgKey } from '../lib/i18n';
import { Confirm, ErrorBox, fmtDateTime, fmtNumber, Loading, Modal, useLoad, useToast } from '../ui';

const DECISION_LABEL: Record<string, { text: MsgKey; cls: string }> = {
  granted: { text: 'decision.granted', cls: 'green' },
  preview: { text: 'decision.preview', cls: 'green' },
  account_required: { text: 'decision.account_required', cls: '' },
  not_entitled: { text: 'decision.not_entitled', cls: '' },
  unavailable: { text: 'decision.unavailable', cls: '' },
  rate_limited: { text: 'decision.rate_limited', cls: 'red' },
  blocked: { text: 'decision.blocked', cls: 'red' },
  budget: { text: 'decision.budget', cls: 'amber' },
};

const REASON_LABEL: Record<string, MsgKey> = {
  playback_rate_limit: 'reason.playback_rate_limit',
  manual_block: 'reason.manual_block',
};

export function AbusePage() {
  const toast = useToast();
  const { t } = useI18n();
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
      else toast.show(t('abuse.noDetail'), 'err');
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'err');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="kicker">Abuse &amp; logs</div>
          <h1>{t('abuse.title')}</h1>
        </div>
      </div>

      <div className="stack">
        <div className="panel">
          <div className="panel-head">
            <h2>{t('abuse.findTitle')}</h2>
            <span className="hint">{t('abuse.findHint')}</span>
          </div>
          <div className="panel-body">
            <form onSubmit={search} style={{ display: 'flex', gap: 10 }}>
              <input className="input mono" style={{ maxWidth: 320 }} placeholder={t('abuse.findPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
              <button className="btn primary" type="submit" disabled={query.trim().length < 3}>
                {t('abuse.find')}
              </button>
            </form>
            {searchError && <p className="error-text">{searchError}</p>}
            {found && (
              <div className="table-wrap" style={{ marginTop: 14 }}>
                {found.length === 0 ? (
                  <div className="empty">{t('abuse.notFound')}</div>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('col.code')}</th>
                        <th>{t('col.account')}</th>
                        <th>{t('col.joined')}</th>
                        <th>{t('col.balance')}</th>
                        <th>{t('col.member')}</th>
                        <th>{t('col.status')}</th>
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
            <h2>{t('abuse.flagsTitle')}</h2>
            <span className="hint">{t('abuse.flagsHint')}</span>
            <div className="right">
              <label className="dim" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={!openOnly} onChange={(e) => setOpenOnly(!e.target.checked)} />
                {t('abuse.includeResolved')}
              </label>
              <button className="btn sm" onClick={flags.reload}>
                {t('common.refresh')}
              </button>
            </div>
          </div>
          {flags.loading && !flags.data ? (
            <Loading />
          ) : flags.error ? (
            <ErrorBox message={flags.error} onRetry={flags.reload} />
          ) : flags.data!.length === 0 ? (
            <div className="empty">{openOnly ? t('abuse.noOpen') : t('abuse.noFlags')}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('col.time')}</th>
                    <th>{t('col.account')}</th>
                    <th>{t('col.reason')}</th>
                    <th>{t('col.details')}</th>
                    <th>{t('col.blockedUntil')}</th>
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
                            {f.is_anonymous ? t('common.guest') : f.email}
                          </div>
                        </td>
                        <td>{REASON_LABEL[f.reason] ? t(REASON_LABEL[f.reason]) : f.reason}</td>
                        <td className="mono muted" style={{ fontSize: 12 }}>
                          {describeDetails(f.details, t)}
                        </td>
                        <td>
                          {f.resolved_at ? (
                            <span className="badge plain">{t('abuse.resolved')}</span>
                          ) : active ? (
                            <span className="badge red">{fmtDateTime(f.blocks_playback_until)}</span>
                          ) : (
                            <span className="badge plain">{t('abuse.expired')}</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {active && (
                            <button className="btn sm" onClick={() => setResolving(f.id)}>
                              {t('abuse.unblock')}
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
            <h2>{t('abuse.recentTitle')}</h2>
            <span className="hint">{t('abuse.recentHint')}</span>
            <div className="right">
              <button className="btn sm" onClick={recent.reload}>
                {t('common.refresh')}
              </button>
            </div>
          </div>
          {recent.loading && !recent.data ? <Loading /> : recent.error ? <ErrorBox message={recent.error} /> : <EventsTable events={recent.data!} />}
        </div>
      </div>

      {resolving !== null && (
        <Confirm
          title={t('abuse.unblockTitle')}
          confirmLabel={t('abuse.unblock')}
          body={t('abuse.unblockBody')}
          onClose={() => setResolving(null)}
          onConfirm={async () => {
            await api.resolveFlag(resolving);
            toast.show(t('abuse.unblocked'));
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

function describeDetails(d: Record<string, unknown>, t: ReturnType<typeof useI18n>['t']): string {
  if (d.note) return String(d.note);
  const parts: string[] = [];
  if (d.tokens_10min !== undefined) parts.push(t('abuse.detail10m', { n: String(d.tokens_10min) }));
  if (d.episodes_1h !== undefined) parts.push(t('abuse.detail1h', { n: String(d.episodes_1h) }));
  if (d.client_ip) parts.push(String(d.client_ip));
  return parts.join(' · ') || '—';
}

function UserRow({ user: u, onOpen }: { user: AdminUser; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <tr>
      <td className="mono">{u.public_code}</td>
      <td>
        {u.display_name}
        <div className="muted" style={{ fontSize: 12 }}>
          {u.is_anonymous ? t('common.guest') : u.email}
          {u.is_admin && t('abuse.adminSuffix')}
        </div>
      </td>
      <td className="num">{fmtDateTime(u.created_at)}</td>
      <td className="num">{fmtNumber(u.balance)}</td>
      <td>{u.is_member ? <span className="badge blue">{t('abuse.memberUntil', { at: fmtDateTime(u.member_until) })}</span> : <span className="muted">—</span>}</td>
      <td>{u.blocked_until ? <span className="badge red">{t('abuse.statusBlocked')}</span> : <span className="badge green">{t('abuse.statusOk')}</span>}</td>
      <td style={{ textAlign: 'right' }}>
        <button className="btn sm" onClick={onOpen}>
          {t('abuse.details')}
        </button>
      </td>
    </tr>
  );
}

function EventsTable({ events }: { events: Awaited<ReturnType<typeof api.playbackEvents>> }) {
  const { t } = useI18n();
  if (events.length === 0) return <div className="empty">{t('abuse.noEvents')}</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 460 }}>
      <table className="table">
        <thead>
          <tr>
            <th>{t('col.time')}</th>
            <th>{t('col.account')}</th>
            <th>{t('col.series')}</th>
            <th>{t('col.result')}</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const known = DECISION_LABEL[e.decision];
            const d = known ? { text: t(known.text), cls: known.cls } : { text: e.decision, cls: '' };
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
  const { t } = useI18n();
  const events = useLoad(() => api.playbackEvents(user.user_id, 100), [user.user_id]);
  const [minutes, setMinutes] = useState(1440);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const block = async () => {
    setBusy(true);
    try {
      await api.blockUser(user.user_id, minutes, reason);
      toast.show(t('abuse.blockedToast', { code: user.public_code }));
      onChanged();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), 'err');
      setBusy(false);
    }
  };

  return (
    <Modal title={t('abuse.accountTitle', { code: user.public_code })} onClose={onClose}>
      <div className="stack" style={{ gap: 18 }}>
        <dl className="kv" style={{ gridTemplateColumns: 'repeat(4, auto)' }}>
          <dt>{t('abuse.kvName')}</dt>
          <dt>{t('col.account')}</dt>
          <dt>{t('col.balance')}</dt>
          <dt>{t('abuse.kvUnlocks')}</dt>
          <dd style={{ fontFamily: 'var(--font-ui)' }}>{user.display_name}</dd>
          <dd>{user.is_anonymous ? t('common.guest') : user.email}</dd>
          <dd>{fmtNumber(user.balance)}</dd>
          <dd>{fmtNumber(user.unlock_count)}</dd>
        </dl>

        <div className="panel" style={{ boxShadow: 'none' }}>
          <div className="panel-head">
            <h2>{t('abuse.blockTitle')}</h2>
            {user.blocked_until && <span className="badge red">{t('abuse.blockedUntil', { at: fmtDateTime(user.blocked_until) })}</span>}
          </div>
          <div className="panel-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label className="field">
              <span>{t('abuse.duration')}</span>
              <select className="select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                <option value={60}>{t('abuse.d1h')}</option>
                <option value={1440}>{t('abuse.d1d')}</option>
                <option value={10080}>{t('abuse.d7d')}</option>
                <option value={43200}>{t('abuse.d30d')}</option>
                <option value={525600}>{t('abuse.d1y')}</option>
              </select>
            </label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}>
              <span>{t('abuse.reasonField')}</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('abuse.reasonPlaceholder')} />
            </label>
            <button className="btn danger" disabled={busy} onClick={block}>
              {t('abuse.block')}
            </button>
          </div>
        </div>

        <div>
          <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>{t('abuse.history')}</h2>
          {events.loading && !events.data ? <Loading /> : events.error ? <ErrorBox message={events.error} /> : <EventsTable events={events.data!} />}
        </div>
      </div>
    </Modal>
  );
}
