export default function StatusPill({ label, bg, color, style }) {
  return (
    <span style={{
      background: bg,
      color,
      borderRadius: 999,
      padding: '2px 10px',
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.04em',
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {label}
    </span>
  );
}
