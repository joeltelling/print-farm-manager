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
        label: 'Resumen',
        items: [
          { to: '/erp', label: 'Dashboard', end: true },
          { to: '/erp/postings', label: 'Postings' },
          { to: '/erp/analytics', label: 'Analytics' },
        ],
      },
      {
        id: 'erp-inventory',
        label: 'Inventario',
        items: [
          { to: '/erp/inventory', label: 'Inventory' },
          { to: '/erp/items', label: 'Products' },
          { to: '/erp/locations', label: 'Locations' },
        ],
      },
      {
        id: 'erp-mfg',
        label: 'Fabricacion',
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
        label: 'Ventas',
        items: [
          { to: '/erp/sales', label: 'Sales', end: true },
          { to: '/erp/sales/order', label: 'Sales Order' },
          { to: '/erp/sales/pricing', label: 'Pricing' },
          { to: '/erp/sales/config', label: 'Sales Config' },
          { to: '/erp/sales/reports', label: 'Sales Reports' },
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
      { to: '/timelapses', label: 'Timelapses' },
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

export const navLinkStyle = ({ isActive }) => ({
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  borderRadius: theme.radiusSm,
  color: isActive ? '#0a0a0a' : theme.text,
  background: isActive ? theme.lime : 'transparent',
  textDecoration: 'none',
  fontWeight: isActive ? 700 : 500,
  fontSize: 14,
  lineHeight: 1.3,
  transition: 'background 0.15s, color 0.15s',
  whiteSpace: 'nowrap',
  boxShadow: isActive ? `0 0 18px ${theme.limeGlow}` : 'none',
});

function Chevron({ open, size = 12 }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        borderRadius: 6,
        background: theme.cardAlt,
        border: `1px solid ${theme.border}`,
        fontSize: size,
        lineHeight: 1,
        flexShrink: 0,
        color: theme.textMuted,
      }}
    >
      {open ? '▾' : '▸'}
    </span>
  );
}

function ScreenLink({ item, nested }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/' || !!item.end}
      style={(args) => ({
        ...navLinkStyle(args),
        ...(nested ? { paddingLeft: 14, fontSize: 13.5 } : null),
      })}
    >
      {item.label}
    </NavLink>
  );
}

function ModuleCard({ open, label, onToggle, children }) {
  return (
    <div style={{
      background: open ? theme.card : theme.cardAlt,
      border: `1px solid ${open ? theme.borderStrong : theme.border}`,
      borderRadius: theme.radius,
      overflow: 'hidden',
      marginBottom: 10,
    }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          margin: 0,
          padding: '14px 14px',
          border: 'none',
          borderBottom: open ? `1px solid ${theme.border}` : 'none',
          background: open ? theme.card : 'transparent',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          color: theme.text,
        }}
      >
        <Chevron open={open} size={13} />
        <span style={{
          flex: 1,
          fontSize: 15,
          fontWeight: 800,
          letterSpacing: '0.02em',
          lineHeight: 1.2,
        }}>
          {label}
        </span>
      </button>
      {open && (
        <div style={{ padding: '8px 8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function GroupCard({ open, label, onToggle, children }) {
  return (
    <div style={{
      background: theme.page,
      border: `1px solid ${open ? theme.borderStrong : theme.border}`,
      borderRadius: theme.radiusSm,
      overflow: 'hidden',
    }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          margin: 0,
          padding: '11px 12px',
          border: 'none',
          borderBottom: open ? `1px solid ${theme.border}` : 'none',
          background: open ? theme.cardAlt : 'transparent',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          color: open ? theme.text : theme.textMuted,
        }}
      >
        <Chevron open={open} size={11} />
        <span style={{
          flex: 1,
          fontSize: 13.5,
          fontWeight: 700,
          lineHeight: 1.2,
        }}>
          {label}
        </span>
      </button>
      {open && (
        <div style={{
          padding: '6px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          background: theme.page,
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
      {NAV_SECTIONS.map((section) => {
        const moduleOpen = open.module === section.id;
        return (
          <ModuleCard
            key={section.id}
            open={moduleOpen}
            label={section.label}
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
                background: theme.page,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusSm,
                padding: 6,
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
