import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { theme } from '../theme';

const ACCORDION_KEY = 'coma.nav.accordion';

export const NAV_SECTIONS = [
  {
    id: 'erp',
    label: 'ERP',
    groups: [
      {
        id: 'erp-overview',
        label: 'Overview',
        items: [
          { to: '/erp', label: 'Dashboard', end: true },
          { to: '/erp/postings', label: 'Postings' },
          { to: '/erp/analytics', label: 'Analytics' },
        ],
      },
      {
        id: 'erp-inventory',
        label: 'Inventory',
        items: [
          { to: '/erp/inventory', label: 'Inventory' },
          { to: '/erp/items', label: 'Products' },
          { to: '/erp/locations', label: 'Locations' },
        ],
      },
      {
        id: 'erp-mfg',
        label: 'Manufacturing',
        items: [
          { to: '/erp/manufacturing', label: 'Manufacturing' },
          { to: '/erp/machines', label: 'Machines' },
          { to: '/erp/components', label: 'Components' },
          { to: '/erp/bom', label: 'BOM' },
          { to: '/erp/wo', label: 'Work Orders' },
        ],
      },
      {
        id: 'erp-sales',
        label: 'Sales',
        items: [
          { to: '/erp/sales', label: 'Sales', end: true },
          { to: '/erp/customers', label: 'Customers' },
          { to: '/erp/quotes', label: 'Quotes' },
          { to: '/erp/delivery-notes', label: 'Delivery notes' },
          { to: '/erp/invoices', label: 'Invoices' },
          { to: '/erp/sales/order', label: 'Sales Order' },
          { to: '/erp/sales/pricing', label: 'Pricing' },
          { to: '/erp/sales/config', label: 'Sales Config' },
          { to: '/erp/sales/reports', label: 'Sales Reports' },
          { to: '/erp/ebay', label: 'eBay' },
        ],
      },
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
      { to: '/calendar', label: 'Calendar' },
      { to: '/timelapses', label: 'Timelapses' },
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    items: [
      { to: '/workspace', label: 'Board', end: true },
      { to: '/workspace/bloc', label: 'Notebook' },
    ],
  },
];

function pathMatches(pathname, item) {
  if (item.to === '/') return pathname === '/';
  // Accordion ownership ignores `end`: /printers/5 belongs under Printers.
  // Longest-prefix selection still keeps /erp from stealing /erp/items.
  return pathname === item.to || pathname.startsWith(item.to + '/');
}

/** Longest matching prefix among all nav items; returns { module, group } or nulls. */
export function resolveNavForPath(pathname) {
  let best = null;
  let bestLen = -1;

  for (const section of NAV_SECTIONS) {
    if (section.groups) {
      for (const group of section.groups) {
        for (const item of group.items) {
          if (!pathMatches(pathname, item)) continue;
          const len = item.to.length;
          if (len > bestLen) {
            bestLen = len;
            best = { module: section.id, group: group.id };
          }
        }
      }
    } else if (section.items) {
      for (const item of section.items) {
        if (!pathMatches(pathname, item)) continue;
        const len = item.to.length;
        if (len > bestLen) {
          bestLen = len;
          best = { module: section.id, group: null };
        }
      }
    }
  }

  return best || { module: null, group: null };
}

function readAccordion() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCORDION_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return { module: raw.module ?? null, group: raw.group ?? null };
    }
  } catch { /* ignore */ }
  return { module: null, group: null };
}

function persistAccordion(next) {
  localStorage.setItem(ACCORDION_KEY, JSON.stringify(next));
}

// Hover states need real CSS, so links carry a class alongside their inline style.
export const NAV_STYLES = `
  .coma-navlink { transition: background 0.15s ease, color 0.15s ease; }
  .coma-navlink:not(.is-active):hover { background: rgba(255,255,255,0.05); color: ${theme.text}; }
  .coma-navtoggle { transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; }
  .coma-navtoggle:hover { color: ${theme.text}; }
`;

export const navLinkStyle = ({ isActive }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 12px',
  borderRadius: 10,
  color: isActive ? '#0a0a0a' : theme.textMuted,
  background: isActive ? theme.lime : 'transparent',
  textDecoration: 'none',
  fontWeight: isActive ? 700 : 500,
  fontSize: 12.5,
  lineHeight: 1.3,
  whiteSpace: 'nowrap',
  boxShadow: isActive ? theme.glowLime : 'none',
});

export const navLinkClass = ({ isActive }) => `coma-navlink${isActive ? ' is-active' : ''}`;

function Chevron({ open, size = 14, color = theme.textDim }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, transition: 'transform 0.18s ease' }}
    >
      <path d={open ? 'M19 9l-7 7-7-7' : 'M9 5l7 7-7 7'} />
    </svg>
  );
}

function ScreenLink({ item, nested }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/' || !!item.end}
      className={navLinkClass}
      style={(args) => ({
        ...navLinkStyle(args),
        ...(nested ? { fontSize: 12 } : null),
      })}
    >
      {({ isActive }) => (
        <>
          <span>{item.label}</span>
          {isActive && (
            <span style={{
              width: 7, height: 7, borderRadius: 999,
              background: 'rgba(0,0,0,0.8)', flexShrink: 0,
            }} />
          )}
        </>
      )}
    </NavLink>
  );
}

function ModuleCard({ open, label, indicator, onToggle, children }) {
  return (
    <div style={{
      background: open ? 'rgba(19, 20, 31, 0.7)' : 'transparent',
      border: `1px solid ${open ? 'rgba(35, 38, 56, 0.6)' : 'transparent'}`,
      borderRadius: theme.radius,
      padding: open ? 6 : 0,
      marginBottom: 6,
    }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="coma-navtoggle"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          width: '100%',
          margin: 0,
          padding: '9px 10px',
          border: 'none',
          borderRadius: 10,
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          color: open ? theme.textStrong : theme.textMuted,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <Chevron open={open} size={14} color={open ? theme.lime : theme.textDim} />
          <span style={{
            fontSize: 11.5,
            fontWeight: 700,
            letterSpacing: '0.09em',
            textTransform: 'uppercase',
            lineHeight: 1.2,
          }}>
            {label}
          </span>
        </span>
        {indicator}
      </button>
      {open && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 4 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function GroupCard({ open, label, onToggle, children }) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="coma-navtoggle"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          margin: 0,
          padding: '6px 10px',
          border: 'none',
          borderRadius: 8,
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          color: open ? theme.textStrong : theme.textMuted,
        }}
      >
        <Chevron open={open} size={12} color={theme.textDim} />
        <span style={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.2 }}>
          {label}
        </span>
      </button>
      {open && (
        <div style={{
          padding: '2px 0 4px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible module / group / screen nav.
 * Desktop: accordion cards (one module open; one ERP subgroup open), persisted.
 * Mobile compact: flat links with module/group labels, no folding.
 */
export function NavSections({ compact = false, linkStyle }) {
  const location = useLocation();
  const [open, setOpen] = useState(readAccordion);

  useEffect(() => {
    const match = resolveNavForPath(location.pathname);
    if (!match.module) return;
    setOpen((prev) => {
      const next = { module: match.module, group: match.group };
      if (prev.module === next.module && prev.group === next.group) return prev;
      persistAccordion(next);
      return next;
    });
  }, [location.pathname]);

  function toggleModule(id) {
    setOpen((prev) => {
      const next = prev.module === id
        ? { module: null, group: null }
        : { module: id, group: null };
      persistAccordion(next);
      return next;
    });
  }

  function toggleGroup(id) {
    setOpen((prev) => {
      const next = {
        module: prev.module,
        group: prev.group === id ? null : id,
      };
      persistAccordion(next);
      return next;
    });
  }

  if (compact) {
    return (
      <>
        {NAV_SECTIONS.map((section) => (
          <div
            key={section.id}
            style={{
              display: 'flex',
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{
              fontSize: 11, fontWeight: 800, letterSpacing: '0.04em',
              textTransform: 'uppercase', color: theme.textMuted, marginLeft: 4,
            }}>
              {section.label}
            </span>
            {section.groups
              ? section.groups.map((group) => (
                  <span key={group.id} style={{ display: 'contents' }}>
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: theme.textFaint,
                    }}>
                      {group.label}
                    </span>
                    {group.items.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.to === '/' || !!item.end}
                        style={linkStyle}
                      >
                        {item.label}
                      </NavLink>
                    ))}
                  </span>
                ))
              : section.items.map((item) => (
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <style>{NAV_STYLES}</style>
      {NAV_SECTIONS.map((section) => {
        const moduleOpen = open.module === section.id;
        return (
          <ModuleCard
            key={section.id}
            open={moduleOpen}
            label={section.label}
            indicator={section.id === 'shopfloor' ? (
              <span
                className="pulse-dot"
                title="Shopfloor polling is live"
                style={{ width: 8, height: 8, borderRadius: 999, background: theme.emeraldDeep, flexShrink: 0 }}
              />
            ) : null}
            onToggle={() => toggleModule(section.id)}
          >
            {section.groups && section.groups.map((group) => {
              const groupOpen = open.group === group.id;
              return (
                <GroupCard
                  key={group.id}
                  open={groupOpen}
                  label={group.label}
                  onToggle={() => toggleGroup(group.id)}
                >
                  {group.items.map((item) => (
                    <ScreenLink key={item.to} item={item} nested />
                  ))}
                </GroupCard>
              );
            })}

            {section.items && (
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                paddingLeft: 4,
              }}>
                {section.items.map((item) => (
                  <ScreenLink key={item.to} item={item} />
                ))}
              </div>
            )}
          </ModuleCard>
        );
      })}
    </div>
  );
}
