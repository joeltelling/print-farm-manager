import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Fleet from './pages/Fleet';
import Printers from './pages/Printers';
import PrinterDetail from './pages/PrinterDetail';
import Projects from './pages/Projects';
import Jobs from './pages/Jobs';
import Settings from './pages/Settings';
import Decommissioned from './pages/Decommissioned';
import AlertBell from './components/AlertBell';
import { theme } from './theme';

const NAV_ITEMS = [
  { to: '/',        label: 'Dashboard' },
  { to: '/fleet',   label: 'Fleet' },
  { to: '/printers', label: 'Printers', end: true },
  { to: '/projects', label: 'Projects' },
  { to: '/jobs',    label: 'Jobs' },
  { to: '/settings', label: 'Settings' },
];

const navLinkStyle = ({ isActive }) => ({
  display: 'block',
  padding: '9px 14px',
  borderRadius: 10,
  color: isActive ? '#fff' : theme.textMuted,
  background: isActive ? theme.accentDeep : 'transparent',
  textDecoration: 'none',
  fontWeight: isActive ? 700 : 500,
  fontSize: 14,
  transition: 'background 0.15s',
  whiteSpace: 'nowrap',
});

export default function App() {
  const [farmName, setFarmName] = useState('CoMa');
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => { if (data.farm_name) setFarmName(data.farm_name); })
      .catch(() => {});

    const onFarmNameChanged = (e) => setFarmName(e.detail);
    window.addEventListener('farmNameChanged', onFarmNameChanged);
    return () => window.removeEventListener('farmNameChanged', onFarmNameChanged);
  }, []);

  return (
    <BrowserRouter>
      <style>{`
        #layout { display: flex; min-height: 100vh; background: ${theme.page}; }
        #sidebar { width: 220px; flex-shrink: 0; background: ${theme.sidebar}; border-right: 1px solid ${theme.border}; display: flex; flex-direction: column; padding: 18px 12px; gap: 4px; position: sticky; top: 0; height: 100vh; box-sizing: border-box; }
        #topbar { display: none; background: ${theme.sidebar}; border-bottom: 1px solid ${theme.border}; padding: 8px 12px; align-items: center; gap: 8px; flex-wrap: wrap; }
        #main { flex: 1; padding: 24px 28px; overflow-y: auto; min-width: 0; background: ${theme.page}; }
        @media (max-width: 600px) {
          #layout { flex-direction: column; }
          #sidebar { display: none; }
          #topbar { display: flex; }
          #main { padding: 16px 14px; }
        }
      `}</style>

      <div id="layout">
        <nav id="sidebar">
          <div style={{ padding: '4px 8px 16px', borderBottom: `1px solid ${theme.border}`, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10,
                background: theme.accentDeep,
                color: '#fff', fontWeight: 800, fontSize: 11,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                letterSpacing: '-0.04em',
              }}>
                CoMa
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: theme.text, lineHeight: 1.2 }}>{farmName}</div>
                <div style={{ fontWeight: 500, fontSize: 11, color: theme.textFaint }}>CoreManufacturing</div>
              </div>
            </div>
          </div>
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/' || !!item.end} style={navLinkStyle}>
              {item.label}
            </NavLink>
          ))}
          <div style={{ marginTop: 'auto', padding: '12px 4px 0', display: 'flex', justifyContent: 'flex-end' }}>
            <AlertBell dropUp />
          </div>
        </nav>

        <nav id="topbar">
          <span style={{ fontWeight: 800, fontSize: 14, color: theme.text, marginRight: 4 }}>{farmName}</span>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/' || !!item.end}
              style={({ isActive }) => ({
                padding: '5px 10px',
                borderRadius: 8,
                color: isActive ? '#fff' : theme.textMuted,
                background: isActive ? theme.accentDeep : theme.cardAlt,
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: isActive ? 700 : 400,
              })}
            >
              {item.label}
            </NavLink>
          ))}
          <div style={{ marginLeft: 'auto' }}>
            <AlertBell />
          </div>
        </nav>

        <main id="main">
          <Routes>
            <Route path="/"                element={<Dashboard />} />
            <Route path="/fleet"           element={<Fleet />} />
            <Route path="/printers"        element={<Printers />} />
            <Route path="/printers/:id"    element={<PrinterDetail />} />
            <Route path="/projects"        element={<Projects />} />
            <Route path="/jobs"            element={<Jobs />} />
            <Route path="/decommissioned"  element={<Decommissioned />} />
            <Route path="/settings"        element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
