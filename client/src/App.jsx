import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Fleet from './pages/Fleet';
import Printers from './pages/Printers';
import PrinterDetail from './pages/PrinterDetail';
import Projects from './pages/Projects';
import Jobs from './pages/Jobs';
import Settings from './pages/Settings';
import Decommissioned from './pages/Decommissioned';
import Erp, {
  ItemsPage as ErpItems,
  LocationsPage as ErpLocations,
  MachinesPage as ErpMachines,
  InventoryPage as ErpInventory,
  ComponentsPage as ErpComponents,
  BomPage as ErpBom,
  WoPage as ErpWo,
  QrCompletePage as ErpQr,
  ManufacturingDashboard as ErpMfgDash,
  PostingsPage as ErpPostings,
  SalesHubPage as ErpSales,
  SalesConfigPage as ErpSalesConfig,
  SalesPricingPage as ErpSalesPricing,
  SalesOrderPage as ErpSalesOrder,
  SalesReportsPage as ErpSalesReports,
} from './pages/Erp';
import AlertBell from './components/AlertBell';
import BootSplash, { shouldShowBootSplash } from './components/BootSplash';
import { NavSections, navLinkStyle } from './components/NavTree';
import { theme } from './theme';

const SETTINGS_ITEM = { to: '/settings', label: 'Settings' };

export default function App() {
  const [farmName, setFarmName] = useState('CoMa');
  const [showBoot, setShowBoot] = useState(shouldShowBootSplash);
  const dismissBoot = useCallback(() => setShowBoot(false), []);

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
      {showBoot && <BootSplash siteName={farmName} onDone={dismissBoot} />}
      <style>{`
        #layout { display: flex; min-height: 100vh; height: 100vh; background: ${theme.page}; overflow: hidden; }
        #sidebar { width: 280px; flex-shrink: 0; background: ${theme.sidebar}; border-right: 1px solid ${theme.border}; display: flex; flex-direction: column; padding: 18px 14px; gap: 4px; height: 100%; box-sizing: border-box; overflow-y: auto; }
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

          <div style={{
            marginTop: 4,
            marginBottom: 4,
            background: theme.cardAlt,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radius,
            padding: 6,
          }}>
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
            <Route path="/erp/postings"    element={<ErpPostings />} />
            <Route path="/erp/items"       element={<ErpItems />} />
            <Route path="/erp/locations"   element={<ErpLocations />} />
            <Route path="/erp/machines"    element={<ErpMachines />} />
            <Route path="/erp/inventory"   element={<ErpInventory />} />
            <Route path="/erp/manufacturing" element={<ErpMfgDash />} />
            <Route path="/erp/components"  element={<ErpComponents />} />
            <Route path="/erp/bom"         element={<ErpBom />} />
            <Route path="/erp/wo"          element={<ErpWo />} />
            <Route path="/erp/qr"          element={<ErpQr />} />
            <Route path="/erp/sales"       element={<ErpSales />} />
            <Route path="/erp/sales/config"   element={<ErpSalesConfig />} />
            <Route path="/erp/sales/pricing"  element={<ErpSalesPricing />} />
            <Route path="/erp/sales/order"    element={<ErpSalesOrder />} />
            <Route path="/erp/sales/reports"  element={<ErpSalesReports />} />
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
