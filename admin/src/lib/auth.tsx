import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

interface AuthState {
  status: 'loading' | 'signed_out' | 'admin';
  session: Session | null;
  /** Shown on the login screen (e.g. "this account is not an admin"). */
  notice: string | null;
  /** Emails a one-time sign-in link. Never creates accounts. */
  sendLink: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function isAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin');
  return !error && data === true;
}

/**
 * Only accounts with profiles.is_admin may stay signed in. Anyone else is
 * signed straight back out — the database enforces this too (RLS / admin
 * RPCs), the check here just keeps them out of the UI.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function apply(next: Session | null) {
      if (!next) {
        if (alive) {
          setSession(null);
          setStatus('signed_out');
        }
        return;
      }
      if (await isAdmin()) {
        if (alive) {
          setSession(next);
          setStatus('admin');
        }
      } else {
        await supabase.auth.signOut();
        if (alive) setNotice('这个账号不是管理员。请用管理员账号登录，或联系我们开通权限。');
      }
    }
    supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') apply(next);
      else if (next) setSession(next);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value: AuthState = {
    status,
    session,
    notice,
    sendLink: async (email) => {
      setNotice(null);
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
      });
      // "Signups not allowed" means the address has no account. Treat it like
      // success so the form doesn't reveal which emails exist.
      if (error && !/signups? not allowed/i.test(error.message)) throw new Error(friendlyAuthError(error.message));
    },
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function friendlyAuthError(message: string): string {
  const wait = /after (\d+) seconds?/i.exec(message);
  if (wait) return `请求太频繁，请 ${wait[1]} 秒后再试`;
  if (/rate limit/i.test(message)) return '发送次数太多，请稍后再试（每小时有上限）';
  if (/invalid.*email|email.*invalid/i.test(message)) return '邮箱格式不正确';
  return message;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
