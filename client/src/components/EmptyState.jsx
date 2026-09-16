import { Link } from 'react-router-dom';

// Friendly empty-state card: explains what belongs here and points at the next action.
// Used on first run (empty DB) and for filtered-to-nothing views.
export default function EmptyState({ title, hint, actionLabel, actionTo, children }) {
  return (
    <div style={{
      background: '#151c2c',
      border: '1px dashed #243044',
      borderRadius: 14,
      padding: '32px 24px',
      textAlign: 'center',
      color: '#94a3b8',
    }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#cbd5e1', marginBottom: 6 }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 13, lineHeight: 1.6, maxWidth: 480, margin: '0 auto' }}>{hint}</div>
      )}
      {children}
      {actionLabel && actionTo && (
        <Link
          to={actionTo}
          style={{
            display: 'inline-block',
            background: '#2563eb',
            color: '#fff',
            borderRadius: 6,
            padding: '7px 16px',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            marginTop: 14,
          }}
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
