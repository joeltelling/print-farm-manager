import { CARD_STYLE, theme } from '../theme';

export default function KpiCard({ label, value, color = theme.accent, help }) {
  return (
    <div title={help} style={{
      ...CARD_STYLE,
      padding: '18px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      minHeight: 92,
    }}>
      <div style={{
        width: 4,
        alignSelf: 'stretch',
        background: color,
        borderRadius: 4,
        flexShrink: 0,
      }} />
      <div>
        <div style={{
          fontSize: 36,
          fontWeight: 800,
          color,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {value}
        </div>
        <div style={{
          fontSize: 11,
          color: theme.textFaint,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontWeight: 700,
          marginTop: 8,
        }}>
          {label}
        </div>
      </div>
    </div>
  );
}
