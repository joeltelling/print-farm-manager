import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Fleet from './pages/Fleet';
import Webcams from './pages/Webcams';
import Printers from './pages/Printers';
import PrinterDetail from './pages/PrinterDetail';
import Projects from './pages/Projects';
import Jobs from './pages/Jobs';
import Settings from './pages/Settings';
import Decommissioned from './pages/Decommissioned';
import Login from './pages/Login';
import Users from './pages/Users';
import Account from './pages/Account';
import CommandPalette from './components/CommandPalette';
import { useAuth } from './AuthContext';

function navItems(role) {
  const items = [
    { to: '/',               label: 'Dashboard' },
    { to: '/fleet',          label: 'Fleet' },
    { to: '/webcams',        label: 'Webcams' },
    { to: '/printers',       label: 'Printers',      end: true },
    { to: '/projects',       label: 'Projects' },
    { to: '/jobs',           label: 'Jobs' },
    { to: '/decommissioned', label: 'Decommissioned' },
    { to: '/settings',       label: 'Settings' },
  ];
  if (role === 'admin') items.push({ to: '/users', label: 'Users' });
  items.push({ to: '/account', label: 'Account' });
  return items;
}

const navLinkStyle = ({ isActive }) => ({
  display: 'block',
  padding: '8px 14px',
  borderRadius: 6,
  color: isActive ? '#fff' : '#94a3b8',
  background: isActive ? '#1e40af' : 'transparent',
  textDecoration: 'none',
  fontWeight: isActive ? 700 : 400,
  fontSize: 14,
  transition: 'background 0.15s',
  whiteSpace: 'nowrap',
});

export default function App() {
  const { user, logout } = useAuth();

  // Operator-configurable farm name (Settings → Farm Name)
  const [farmName, setFarmName] = useState('Print Farm');
  useEffect(() => {
    if (!user) return; // unauthenticated: /api/settings is behind the auth gate too
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => { if (data.farm_name) setFarmName(data.farm_name); })
      .catch(() => {});

    // Settings page dispatches this on save so the sidebar/topbar update live,
    // without needing a full page refresh.
    const onFarmNameChanged = (e) => setFarmName(e.detail);
    window.addEventListener('farmNameChanged', onFarmNameChanged);
    return () => window.removeEventListener('farmNameChanged', onFarmNameChanged);
  }, [user]);

  // undefined = still checking the session; null = confirmed logged out.
  if (user === undefined) return null;
  // Login renders here, before BrowserRouter mounts (see its own comment on
  // the /backup-login path reset), so this checks the raw pathname rather
  // than a route match.
  if (user === null) return <Login forceLocal={window.location.pathname === '/backup-login'} />;

  const NAV_ITEMS = navItems(user.role);

  return (
    <BrowserRouter>
      {/* Responsive layout: sidebar on desktop, top nav bar on mobile */}
      {/* #layout is a fixed height:100vh, not min-height: with min-height, a page
          whose content is taller than the viewport stretches #layout (and the
          sidebar flex-stretched to match it) past the viewport too, pushing
          "Sign out" below the fold and forcing a whole-page scroll to reach it.
          Fixed height instead keeps the sidebar pinned to the actual viewport,
          with #main's own overflow-y: auto scrolling just the content area. */}
      <style>{`
        #layout { display: flex; height: 100vh; }
        #sidebar { width: 180px; flex-shrink: 0; background: #131720; border-right: 1px solid #1e2433; display: flex; flex-direction: column; padding: 16px 8px; gap: 4px; overflow-y: auto; }
        #topbar { display: none; background: #131720; border-bottom: 1px solid #1e2433; padding: 8px 12px; align-items: center; gap: 8px; flex-wrap: wrap; flex-shrink: 0; }
        #main { flex: 1; padding: 24px 28px; overflow-y: auto; min-width: 0; }
        @media (max-width: 600px) {
          #layout { flex-direction: column; }
          #sidebar { display: none; }
          #topbar { display: flex; }
          #main { padding: 16px 14px; }
        }
      `}</style>

      <CommandPalette />
      <div id="layout">
        {/* Sidebar (desktop) */}
        <nav id="sidebar">
          <div style={{ padding: '0 6px 16px', borderBottom: '1px solid #1e2433', marginBottom: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#e2e8f0', lineHeight: 1.3 }}>{farmName}</div>
            <div style={{ fontWeight: 400, fontSize: 11, color: '#475569' }}>Print Farm Manager</div>
          </div>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('openCommandPalette'))}
            title="Jump to a printer, project, or part"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#1e2433', border: '1px solid #2d3748', borderRadius: 6,
              color: '#64748b', padding: '6px 10px', fontSize: 12, cursor: 'pointer',
              marginBottom: 8,
            }}
          >
            Search
            <span style={{ fontSize: 10, color: '#475569', border: '1px solid #334155', borderRadius: 4, padding: '1px 5px' }}>
              ⌘K
            </span>
          </button>
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/' || !!item.end} style={navLinkStyle}>
              {item.label}
            </NavLink>
          ))}
          <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid #1e2433' }}>
            <div style={{ padding: '0 6px 6px', fontSize: 11, color: '#64748b' }}>{user.name}</div>
            <button
              onClick={logout}
              style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none', color: '#94a3b8', padding: '8px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}
            >
              Sign out
            </button>
          </div>
        </nav>

        {/* Top nav bar (mobile) */}
        <nav id="topbar">
          <span style={{ fontWeight: 800, fontSize: 14, color: '#e2e8f0', marginRight: 8 }}>{farmName}</span>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/' || !!item.end}
              style={({ isActive }) => ({
                padding: '5px 10px',
                borderRadius: 6,
                color: isActive ? '#fff' : '#94a3b8',
                background: isActive ? '#1e40af' : '#1e2433',
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: isActive ? 700 : 400,
              })}
            >
              {item.label}
            </NavLink>
          ))}
          <button
            onClick={logout}
            style={{ marginLeft: 'auto', background: '#1e2433', border: 'none', color: '#94a3b8', padding: '5px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}
          >
            Sign out
          </button>
        </nav>

        {/* Main content */}
        <main id="main">
          <Routes>
            <Route path="/"                element={<Dashboard />} />
            <Route path="/fleet"           element={<Fleet />} />
            <Route path="/webcams"         element={<Webcams />} />
            <Route path="/printers"        element={<Printers />} />
            <Route path="/printers/:id"    element={<PrinterDetail />} />
            <Route path="/projects"        element={<Projects />} />
            <Route path="/jobs"            element={<Jobs />} />
            <Route path="/decommissioned"  element={<Decommissioned />} />
            <Route path="/settings"        element={<Settings />} />
            {user.role === 'admin' && <Route path="/users" element={<Users />} />}
            <Route path="/account"         element={<Account />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
