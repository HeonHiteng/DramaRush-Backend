import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/** A sign-in link that failed (expired / already used) comes back with ?error_code=… or #error_code=…. */
function linkError(): string | null {
  const params = new URLSearchParams(window.location.search + '&' + window.location.hash.slice(1));
  const code = params.get('error_code');
  if (!code) return null;
  window.history.replaceState(window.history.state, '', window.location.pathname);
  return code === 'otp_expired' ? '登录链接已失效或已用过，请重新获取。' : '登录链接无效，请重新获取。';
}

export function LoginPage() {
  const { status, sendLink, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(linkError);
  const [busy, setBusy] = useState(false);

  if (status === 'admin') return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
        <p>内容后台 · 上传整部剧、管理剧集与付费方式、盯住播放成本和异常账号。</p>
      </section>
      <section className="login-form">
        <form onSubmit={submit}>
          <div>
            <div className="mono muted" style={{ fontSize: 11, letterSpacing: '0.16em' }}>
              ADMIN · SIGN IN
            </div>
            <h1>管理员登录</h1>
          </div>
          {sentTo ? (
            <>
              <p style={{ margin: 0 }}>
                如果 <b>{sentTo}</b> 是管理员邮箱，登录链接已经发过去了。请在<b>这个浏览器</b>里打开邮件中的链接。
              </p>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                没收到？看看垃圾邮件，或稍等一分钟再试。
              </p>
              <button className="btn ghost" type="button" onClick={() => setSentTo(null)}>
                换个邮箱 / 重新发送
              </button>
            </>
          ) : (
            <>
              <label className="field">
                <span>邮箱</span>
                <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              {(error || notice) && <p className="error-text">{error ?? notice}</p>}
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? '发送中…' : '发送登录链接'}
              </button>
            </>
          )}
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            不用密码：每次登录发一封一次性链接。只有被开通为管理员的邮箱才能进入。
          </p>
        </form>
      </section>
    </div>
  );
}
