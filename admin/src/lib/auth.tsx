import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

interface AuthState {
  status: 'loading' | 'signed_out' | 'admin';
  session: Session | null;
  /** Shown on the login screen (e.g. "this account is not an admin"). */
  notice: string | null;
  signIn: (email: string, password: string) => Promise<void>;
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
    signIn: async (email, password) => {
      setNotice(null);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message === 'Invalid login credentials' ? '邮箱或密码不正确' : error.message);
    },
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
