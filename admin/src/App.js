import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
    if (configError)
        return _jsx("div", { className: "empty error-text", children: configError });
    return (_jsx(AuthProvider, { children: _jsx(ToastProvider, { children: _jsx(BrowserRouter, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { element: _jsx(RequireAdmin, {}), children: _jsxs(Route, { element: _jsx(Shell, {}), children: [_jsx(Route, { index: true, element: _jsx(DashboardPage, {}) }), _jsx(Route, { path: "series", element: _jsx(SeriesListPage, {}) }), _jsx(Route, { path: "series/:id", element: _jsx(SeriesPage, {}) }), _jsx(Route, { path: "costs", element: _jsx(CostsPage, {}) }), _jsx(Route, { path: "abuse", element: _jsx(AbusePage, {}) })] }) }), _jsx(Route, { path: "*", element: _jsx(Navigate, { to: "/", replace: true }) })] }) }) }) }));
}
function RequireAdmin() {
    const { status } = useAuth();
    if (status === 'loading')
        return _jsx("div", { className: "empty", children: "\u9A8C\u8BC1\u767B\u5F55\u2026" });
    if (status !== 'admin')
        return _jsx(Navigate, { to: "/login", replace: true });
    return _jsx(Outlet, {});
}
function Shell() {
    const { session, signOut } = useAuth();
    const flags = useLoad(() => api.dashboard().then((d) => d.open_abuse_flags), []);
    return (_jsxs("div", { className: "shell", children: [_jsxs("aside", { className: "sidebar", children: [_jsxs("div", { className: "brand", children: [_jsxs("div", { className: "brand-mark", children: ["Keybox", _jsx("span", { children: "." })] }), _jsx("div", { className: "brand-tag", children: "Admin" })] }), _jsxs("nav", { className: "nav", children: [_jsx(NavLink, { to: "/", end: true, children: "\u603B\u89C8" }), _jsx(NavLink, { to: "/series", children: "\u5267\u96C6\u4E0E\u4E0A\u4F20" }), _jsx(NavLink, { to: "/costs", children: "\u6210\u672C\u4E0E\u9884\u7B97" }), _jsxs(NavLink, { to: "/abuse", children: ["\u5F02\u5E38\u4E0E\u65E5\u5FD7", !!flags.data && _jsx("span", { className: "count", children: flags.data })] })] }), _jsxs("div", { className: "sidebar-foot", children: [_jsx("div", { className: "who", children: session?.user.email }), _jsx("button", { className: "btn sm", onClick: signOut, children: "\u9000\u51FA\u767B\u5F55" })] })] }), _jsx("main", { className: "main", children: _jsx(Outlet, {}) })] }));
}
