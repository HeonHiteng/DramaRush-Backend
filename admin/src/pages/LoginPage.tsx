import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { status, signIn, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'admin') return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
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
          <label className="field">
            <span>邮箱</span>
            <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {(error || notice) && <p className="error-text">{error ?? notice}</p>}
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            只有被开通为管理员的账号才能进入。
          </p>
        </form>
      </section>
    </div>
  );
}
