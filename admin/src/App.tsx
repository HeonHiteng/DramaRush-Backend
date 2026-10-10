import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { configError } from './lib/supabase';
import { ToastProvider, useLoad } from './ui';
import { api } from './lib/api';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { SeriesListPage } from './pages/SeriesListPage';
import { SeriesPage } from './pages/SeriesPage';
import { CostsPage } from './pages/CostsPage';
import { AbusePage } from './pages/AbusePage';

export function App() {
  if (configError) return <div className="empty error-text">{configError}</div>;
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAdmin />}>
              <Route element={<Shell />}>
                <Route index element={<DashboardPage />} />
                <Route path="series" element={<SeriesListPage />} />
                <Route path="series/:id" element={<SeriesPage />} />
                <Route path="costs" element={<CostsPage />} />
                <Route path="abuse" element={<AbusePage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}

function RequireAdmin() {
  const { status } = useAuth();
  if (status === 'loading') return <div className="empty">验证登录…</div>;
  if (status !== 'admin') return <Navigate to="/login" replace />;
  return <Outlet />;
}

function Shell() {
  const { session, signOut } = useAuth();
  const flags = useLoad(() => api.dashboard().then((d) => d.open_abuse_flags), []);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            Keybox<span>.</span>
          </div>
          <div className="brand-tag">Admin</div>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            总览
          </NavLink>
          <NavLink to="/series">剧集与上传</NavLink>
          <NavLink to="/costs">成本与预算</NavLink>
          <NavLink to="/abuse">
            异常与日志
            {!!flags.data && <span className="count">{flags.data}</span>}
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="who">{session?.user.email}</div>
          <button className="btn sm" onClick={signOut}>
            退出登录
          </button>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
