import { CARD_STYLE, theme } from '../theme';

// Tiny handmade sparkline for KPI cards (no chart library).
function Sparkline({ color = theme.lime }) {
  const points = [8, 14, 11, 18, 16, 22, 19, 28, 24, 32];
  const w = 88;
  const h = 36;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', flexShrink: 0 }}>
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={coords}
        style={{ filter: `drop-shadow(0 0 6px ${theme.limeGlow})` }}
      />
    </svg>
  );
}

export default function KpiCard({ label, value, color = theme.lime, help, spark = true }) {
  return (
    <div title={help} style={{
      ...CARD_STYLE,
      padding: '18px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 14,
      minHeight: 100,
      background: `linear-gradient(145deg, ${theme.card} 0%, ${theme.cardAlt} 100%)`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <div style={{
          width: 4,
          alignSelf: 'stretch',
          background: color,
          borderRadius: 999,
          flexShrink: 0,
          boxShadow: `0 0 12px ${color}`,
        }} />
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 34,
            fontWeight: 800,
            color: theme.text,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em',
          }}>
            {value}
          </div>
          <div style={{
            fontSize: 11,
            color: theme.textDim,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            fontWeight: 700,
            marginTop: 8,
          }}>
            {label}
          </div>
        </div>
      </div>
      {spark && <Sparkline color={color} />}
    </div>
  );
}
