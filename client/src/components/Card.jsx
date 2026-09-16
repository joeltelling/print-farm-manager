import { CARD_STYLE, theme } from '../theme';

export default function Card({ children, style, title, action, padded = true, fill = false }) {
  return (
    <div style={{
      ...CARD_STYLE,
      padding: padded ? '14px 16px' : 0,
      background: `linear-gradient(160deg, ${theme.card} 0%, ${theme.cardAlt} 100%)`,
      display: fill ? 'flex' : undefined,
      flexDirection: fill ? 'column' : undefined,
      minHeight: fill ? 0 : undefined,
      height: fill ? '100%' : undefined,
      ...style,
    }}>
      {(title || action) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: title ? 12 : 0,
          padding: padded ? 0 : '14px 16px 0',
          flexShrink: 0,
        }}>
          {title && (
            <div style={{
              fontSize: 11,
              color: theme.textDim,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              fontWeight: 700,
            }}>
              {title}
            </div>
          )}
          {action}
        </div>
      )}
      {fill ? (
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      ) : children}
    </div>
  );
}
