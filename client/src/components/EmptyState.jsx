import { Link } from 'react-router-dom';
import { theme } from '../theme';

// Friendly empty-state card: explains what belongs here and points at the next action.
// Used on first run (empty DB) and for filtered-to-nothing views.
export default function EmptyState({ title, hint, actionLabel, actionTo, children }) {
  return (
    <div style={{
      background: theme.card,
      border: `1px dashed ${theme.borderStrong}`,
      borderRadius: theme.radius,
      padding: '34px 24px',
      textAlign: 'center',
      color: theme.textMuted,
    }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: theme.textStrong, marginBottom: 6 }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 480, margin: '0 auto' }}>{hint}</div>
      )}
      {children}
      {actionLabel && actionTo && (
        <Link
          to={actionTo}
          style={{
            display: 'inline-block',
            background: `linear-gradient(90deg, ${theme.accentDeep} 0%, #4f46e5 100%)`,
            color: '#fff',
            borderRadius: theme.radiusSm,
            padding: '9px 18px',
            fontSize: 13,
            fontWeight: 700,
            textDecoration: 'none',
            marginTop: 16,
            boxShadow: theme.glowViolet,
          }}
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
