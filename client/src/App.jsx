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
import Timelapses from './pages/Timelapses';
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
  AnalyticsPage as ErpAnalytics,
  SalesHubPage as ErpSales,
  SalesConfigPage as ErpSalesConfig,
  SalesPricingPage as ErpSalesPricing,
  SalesOrderPage as ErpSalesOrder,
  SalesReportsPage as ErpSalesReports,
  EbayPage as ErpEbay,
} from './pages/Erp';
import AlertBell from './components/AlertBell';
import BootSplash, { shouldShowBootSplash } from './components/BootSplash';
import { NavSections, navLinkStyle, navLinkClass } from './components/NavTree';
import { theme } from './theme';

const SETTINGS_ITEM = { to: '/settings', label: 'Settings' };

const compactLinkStyle = ({ isActive }) => ({
  padding: '5px 11px',
  borderRadius: 9,
  background: isActive ? theme.lime : theme.cardAlt,
  border: `1px solid ${isActive ? 'transparent' : theme.border}`,
  color: isActive ? '#0a0a0a' : theme.textMuted,
  textDecoration: 'none',
  fontSize: 12.5,
  fontWeight: isActive ? 700 : 500,
});

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
        #layout { display: flex; min-height: 100vh; height: 100vh; background: ${theme.shell}; overflow: hidden; }
        #sidebar { width: 256px; flex-shrink: 0; background: ${theme.sidebar}; border-right: 1px solid ${theme.borderSoft}; display: flex; flex-direction: column; height: 100%; box-sizing: border-box; user-select: none; }
        #sidebar-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 14px; }
        #topbar { display: none; background: ${theme.sidebar}; border-bottom: 1px solid ${theme.borderSoft}; padding: 8px 12px; align-items: center; gap: 8px; flex-wrap: wrap; }
        #main { flex: 1; overflow-y: auto; min-width: 0; min-height: 0; background: ${theme.page}; }
        #main-inner { padding: 26px 30px 36px; max-width: 1720px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; min-height: 100%; }
        @media (max-width: 1100px) {
          #main-inner { padding: 20px 20px 28px; }
        }
        @media (max-width: 600px) {
          #layout { flex-direction: column; height: auto; min-height: 100vh; overflow: auto; }
          #sidebar { display: none; }
          #topbar { display: flex; }
          #main-inner { padding: 14px 12px 24px; }
        }
      `}</style>

      <div id="layout">
        <nav id="sidebar">
          <div id="sidebar-scroll">
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '4px 6px 18px' }}>
              <div style={{
                width: 36, height: 36, borderRadius: 12, padding: 1,
                background: `linear-gradient(45deg, ${theme.lime} 0%, ${theme.emeraldDeep} 100%)`,
                flexShrink: 0,
                boxShadow: theme.glowLime,
              }}>
                <div style={{
                  width: '100%', height: '100%', borderRadius: 11,
                  background: '#11131a',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: theme.mono, fontWeight: 600, fontSize: 10.5,
                  color: theme.lime, letterSpacing: '-0.04em',
                }}>
                  CoMa
                </div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontWeight: 700, fontSize: 13.5, color: theme.textBright, lineHeight: 1.25,
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{farmName}</span>
                  <span className="pulse-dot" style={{
                    width: 6, height: 6, borderRadius: 999, background: theme.lime, flexShrink: 0,
                  }} />
                </div>
                <div style={{ fontWeight: 500, fontSize: 11, color: theme.textMuted }}>CoreManufacturing</div>
              </div>
            </div>

            <NavSections linkStyle={navLinkStyle} />

            <div style={{ marginTop: 2 }}>
              <NavLink to={SETTINGS_ITEM.to} className={navLinkClass} style={navLinkStyle}>
                {SETTINGS_ITEM.label}
              </NavLink>
            </div>
          </div>

          <div style={{
            padding: 10,
            borderTop: `1px solid ${theme.borderSoft}`,
            background: '#0c0d13',
            flexShrink: 0,
          }}>
            <AlertBell dropUp />
          </div>
        </nav>

        <nav id="topbar">
          <span style={{ fontWeight: 800, fontSize: 14, color: theme.textBright, marginRight: 4 }}>{farmName}</span>
          <NavSections compact linkStyle={compactLinkStyle} />
          <NavLink to={SETTINGS_ITEM.to} style={compactLinkStyle}>
            {SETTINGS_ITEM.label}
          </NavLink>
          <div style={{ marginLeft: 'auto' }}>
            <AlertBell />
          </div>
        </nav>

        <main id="main" className="grid-lines-bg">
          <div id="main-inner">
          <Routes>
            <Route path="/"                element={<Dashboard />} />
            <Route path="/erp"             element={<Erp />} />
            <Route path="/erp/postings"    element={<ErpPostings />} />
            <Route path="/erp/analytics"   element={<ErpAnalytics />} />
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
            <Route path="/erp/ebay"        element={<ErpEbay />} />
            <Route path="/fleet"           element={<Fleet />} />
            <Route path="/printers"        element={<Printers />} />
            <Route path="/printers/:id"    element={<PrinterDetail />} />
            <Route path="/projects"        element={<Projects />} />
            <Route path="/jobs"            element={<Jobs />} />
            <Route path="/timelapses"      element={<Timelapses />} />
            <Route path="/decommissioned"  element={<Decommissioned />} />
            <Route path="/settings"        element={<Settings />} />
          </Routes>
          </div>
        </main>
      </div>
    </BrowserRouter>
  );
}
