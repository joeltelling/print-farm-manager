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
import Erp from './pages/Erp';
import AlertBell from './components/AlertBell';
import { theme } from './theme';

const NAV_SECTIONS = [
  {
    id: 'erp',
    label: 'ERP',
    items: [
      { to: '/erp', label: 'Overview' },
    ],
  },
  {
    id: 'shopfloor',
    label: 'Shopfloor',
    items: [
      { to: '/',         label: 'Dashboard' },
      { to: '/fleet',    label: 'Fleet' },
      { to: '/printers', label: 'Printers', end: true },
      { to: '/projects', label: 'Projects' },
      { to: '/jobs',     label: 'Jobs' },
    ],
  },
];

const SETTINGS_ITEM = { to: '/settings', label: 'Settings' };

const navLinkStyle = ({ isActive }) => ({
  display: 'block',
  padding: '9px 14px',
  borderRadius: 999,
  color: isActive ? '#0a0a0a' : theme.textMuted,
  background: isActive ? theme.lime : 'transparent',
  textDecoration: 'none',
  fontWeight: isActive ? 700 : 500,
  fontSize: 14,
  transition: 'background 0.15s, color 0.15s',
  whiteSpace: 'nowrap',
  boxShadow: isActive ? `0 0 20px ${theme.limeGlow}` : 'none',
});

const sectionLabelStyle = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: theme.textFaint,
  padding: '12px 14px 4px',
  userSelect: 'none',
};

function NavSections({ linkStyle, compact }) {
  return (
    <>
      {NAV_SECTIONS.map((section) => (
        <div key={section.id} style={{ display: 'flex', flexDirection: compact ? 'row' : 'column', flexWrap: compact ? 'wrap' : 'nowrap', alignItems: compact ? 'center' : 'stretch', gap: compact ? 8 : 0 }}>
          {!compact && <div style={sectionLabelStyle}>{section.label}</div>}
          {compact && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: theme.textFaint, marginLeft: 4,
            }}>
              {section.label}
            </span>
          )}
          {section.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/' || !!item.end}
              style={linkStyle}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ))}
    </>
  );
}

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
        #layout { display: flex; min-height: 100vh; height: 100vh; background: ${theme.page}; overflow: hidden; }
        #sidebar { width: 280px; flex-shrink: 0; background: ${theme.sidebar}; border-right: 1px solid ${theme.border}; display: flex; flex-direction: column; padding: 18px 14px; gap: 4px; height: 100%; box-sizing: border-box; }
        #topbar { display: none; background: ${theme.sidebar}; border-bottom: 1px solid ${theme.border}; padding: 8px 12px; align-items: center; gap: 8px; flex-wrap: wrap; }
        #main { flex: 1; padding: 16px 20px; overflow-y: auto; min-width: 0; min-height: 0; background: ${theme.page}; display: flex; flex-direction: column; }
        @media (max-width: 600px) {
          #layout { flex-direction: column; height: auto; min-height: 100vh; overflow: auto; }
          #sidebar { display: none; }
          #topbar { display: flex; }
          #main { padding: 12px; }
        }
      `}</style>

      <div id="layout">
        <nav id="sidebar">
          <div style={{ padding: '4px 8px 16px', borderBottom: `1px solid ${theme.border}`, marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 12,
                background: `linear-gradient(135deg, ${theme.lime} 0%, ${theme.violetDeep} 100%)`,
                color: '#0a0a0a', fontWeight: 800, fontSize: 11,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                letterSpacing: '-0.04em',
                boxShadow: `0 0 18px ${theme.limeGlow}`,
              }}>
                CoMa
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: theme.text, lineHeight: 1.2 }}>{farmName}</div>
                <div style={{ fontWeight: 500, fontSize: 11, color: theme.textFaint }}>CoreManufacturing</div>
              </div>
            </div>
          </div>

          <NavSections linkStyle={navLinkStyle} />

          <div style={{ marginTop: 8, borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>
            <NavLink to={SETTINGS_ITEM.to} style={navLinkStyle}>
              {SETTINGS_ITEM.label}
            </NavLink>
          </div>

          <div style={{ marginTop: 'auto', padding: '12px 0 0', width: '100%' }}>
            <AlertBell dropUp />
          </div>
        </nav>

        <nav id="topbar">
          <span style={{ fontWeight: 800, fontSize: 14, color: theme.text, marginRight: 4 }}>{farmName}</span>
          <NavSections
            compact
            linkStyle={({ isActive }) => ({
              padding: '5px 10px',
              borderRadius: 8,
              background: isActive ? theme.lime : theme.cardAlt,
              color: isActive ? '#0a0a0a' : theme.textMuted,
              textDecoration: 'none',
              fontSize: 13,
              fontWeight: isActive ? 700 : 400,
            })}
          />
          <NavLink
            to={SETTINGS_ITEM.to}
            style={({ isActive }) => ({
              padding: '5px 10px',
              borderRadius: 8,
              background: isActive ? theme.lime : theme.cardAlt,
              color: isActive ? '#0a0a0a' : theme.textMuted,
              textDecoration: 'none',
              fontSize: 13,
              fontWeight: isActive ? 700 : 400,
            })}
          >
            {SETTINGS_ITEM.label}
          </NavLink>
          <div style={{ marginLeft: 'auto' }}>
            <AlertBell />
          </div>
        </nav>

        <main id="main">
          <Routes>
            <Route path="/"                element={<Dashboard />} />
            <Route path="/erp"             element={<Erp />} />
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
