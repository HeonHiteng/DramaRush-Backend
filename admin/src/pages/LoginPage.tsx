import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { LangSwitch, useI18n, type MsgKey } from '../lib/i18n';

/** A sign-in link that failed (expired / already used) comes back with ?error_code=… or #error_code=…. */
function linkError(): MsgKey | null {
  const params = new URLSearchParams(window.location.search + '&' + window.location.hash.slice(1));
  const code = params.get('error_code');
  if (!code) return null;
  window.history.replaceState(window.history.state, '', window.location.pathname);
  return code === 'otp_expired' ? 'login.linkExpired' : 'login.linkInvalid';
}

export function LoginPage() {
  const { status, sendLink, notice } = useAuth();
  const { t } = useI18n();
  const [linkProblem, setLinkProblem] = useState<MsgKey | null>(linkError);
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'admin') return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLinkProblem(null);
    try {
      await sendLink(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-art" aria-hidden="true">
        <div className="strip" />
        <div className="slate">
          Key
          <br />
          box<span>.</span>
        </div>
        <p>{t('login.tagline')}</p>
      </section>
      <section className="login-form">
        <LangSwitch className="corner" />
        <form onSubmit={submit}>
          <div>
            <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.16em' }}>
              ADMIN · SIGN IN
            </div>
            <h1>{t('login.title')}</h1>
          </div>
          {sentTo ? (
            <>
              <p style={{ margin: 0 }}>{t('login.sent', { email: sentTo })}</p>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                {t('login.notReceived')}
              </p>
              <button className="btn ghost" type="button" onClick={() => setSentTo(null)}>
                {t('login.again')}
              </button>
            </>
          ) : (
            <>
              <label className="field">
                <span>{t('login.email')}</span>
                <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              {(error || linkProblem || notice) && <p className="error-text">{error ?? t((linkProblem ?? notice)!)}</p>}
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? t('login.sending') : t('login.send')}
              </button>
            </>
          )}
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            {t('login.footer')}
          </p>
        </form>
      </section>
    </div>
  );
}
