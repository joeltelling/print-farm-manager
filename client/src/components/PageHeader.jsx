import { theme, tintStyle } from '../theme';

/**
 * Page title block. `badge` is a short status word rendered as a tinted pill
 * next to the title (for example LIVE PRODUCTION on the ERP dashboard).
 */
export default function PageHeader({ title, subtitle, badge, badgeColor = theme.emerald, actions }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      marginBottom: 22,
      flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          fontSize: 26,
          fontWeight: 800,
          margin: 0,
          color: theme.textBright,
          letterSpacing: '-0.025em',
          lineHeight: 1.15,
        }}>
          {title}
          {badge && (
            <span style={{
              ...tintStyle(badgeColor),
              fontFamily: theme.mono,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '0.07em',
              padding: '3px 9px',
              borderRadius: 999,
              whiteSpace: 'nowrap',
            }}>
              {badge}
            </span>
          )}
        </h1>
        {subtitle && (
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6, fontWeight: 500 }}>{subtitle}</div>
        )}
      </div>
      {actions && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {actions}
        </div>
      )}
    </div>
  );
}
