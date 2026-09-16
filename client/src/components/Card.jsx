import { CARD_STYLE, theme } from '../theme';

export default function Card({ children, style, title, action, padded = true }) {
  return (
    <div style={{ ...CARD_STYLE, padding: padded ? '16px 20px' : 0, ...style }}>
      {(title || action) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: title ? 14 : 0,
          padding: padded ? 0 : '14px 20px 0',
        }}>
          {title && (
            <div style={{
              fontSize: 11,
              color: theme.textFaint,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              fontWeight: 700,
            }}>
              {title}
            </div>
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
