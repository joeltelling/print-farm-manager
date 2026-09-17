import { theme } from '../theme';

export default function StatusPill({ label, bg, color, style }) {
  return (
    <span style={{
      background: bg,
      color,
      border: '1px solid transparent',
      borderRadius: 999,
      padding: '3px 10px',
      fontFamily: theme.mono,
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: '0.05em',
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {label}
    </span>
  );
}
