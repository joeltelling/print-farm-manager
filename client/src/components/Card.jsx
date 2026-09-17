import { CARD_STYLE, CAPTION_STYLE, theme } from '../theme';

/**
 * Standard content surface: flat card, hairline border, soft depth.
 * `title` renders the uppercase caption header with a divider; `dot` adds a
 * live indicator next to it and `badge` a chip on the right of the header.
 */
export default function Card({
  children, style, title, dot, badge, action, footer,
  padded = true, fill = false,
}) {
  const hasHeader = !!(title || badge || action);
  const pad = padded ? '16px 18px' : 0;

  return (
    <div style={{
      ...CARD_STYLE,
      padding: pad,
      display: fill ? 'flex' : undefined,
      flexDirection: fill ? 'column' : undefined,
      minHeight: fill ? 0 : undefined,
      height: fill ? '100%' : undefined,
      ...style,
    }}>
      {hasHeader && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingBottom: 12,
          marginBottom: 14,
          borderBottom: `1px solid ${theme.borderSoft}`,
          ...(padded ? null : { padding: '16px 18px 12px', marginBottom: 0 }),
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            {dot && (
              <span
                className="pulse-dot"
                style={{ width: 9, height: 9, borderRadius: 999, background: dot, flexShrink: 0 }}
              />
            )}
            {title && <span style={{ ...CAPTION_STYLE, fontSize: 11, color: theme.textStrong }}>{title}</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {badge}
            {action}
          </div>
        </div>
      )}

      {fill ? (
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      ) : children}

      {footer && (
        <div style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: `1px solid ${theme.borderSoft}`,
          fontSize: 11,
          color: theme.textDim,
          flexShrink: 0,
        }}>
          {footer}
        </div>
      )}
    </div>
  );
}
