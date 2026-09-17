import { Link } from 'react-router-dom';
import { CARD_STYLE, CAPTION_STYLE, theme, hexAlpha } from '../theme';

// Tiny handmade sparkline for KPI cards (no chart library).
function Sparkline({ color }) {
  const points = [8, 14, 11, 18, 16, 22, 19, 28, 24, 32];
  const w = 72;
  const h = 26;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', flexShrink: 0, opacity: 0.75 }}>
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={coords}
        style={{ filter: `drop-shadow(0 0 5px ${hexAlpha(color, 0.45)})` }}
      />
    </svg>
  );
}

/**
 * Compact metric tile: uppercase caption, accent-coloured value, mono subtitle.
 * `to` turns the whole tile into a router link, `accent` tints the frame for
 * tiles that need the operator's eye (pending postings, alerts).
 */
export default function KpiCard({
  label, value, sub, color = theme.lime, help, to, accent = false, spark = false,
}) {
  const body = (
    <>
      <span style={CAPTION_STYLE}>{label}</span>
      <div style={{
        marginTop: 8,
        fontSize: 26,
        fontWeight: 800,
        color,
        lineHeight: 1.05,
        letterSpacing: '-0.02em',
        fontVariantNumeric: 'tabular-nums',
        wordBreak: 'break-word',
      }}>
        {value}
      </div>
      <div style={{
        marginTop: 6,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 8,
      }}>
        {sub != null && (
          <span
            title={typeof sub === 'string' ? sub : undefined}
            style={{
              fontFamily: theme.mono,
              fontSize: 11,
              color: accent ? hexAlpha(color, 0.85) : theme.textMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sub}
          </span>
        )}
        {spark && <Sparkline color={color} />}
      </div>
    </>
  );

  const style = {
    ...CARD_STYLE,
    border: `1px solid ${accent ? hexAlpha(color, 0.28) : theme.border}`,
    padding: '14px 15px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    position: 'relative',
    overflow: 'hidden',
    minWidth: 0,
    textDecoration: 'none',
    color: 'inherit',
  };

  const corner = accent && (
    <span style={{
      position: 'absolute',
      top: 0,
      right: 0,
      width: 34,
      height: 34,
      background: hexAlpha(color, 0.1),
      borderBottomLeftRadius: theme.radius,
      pointerEvents: 'none',
    }} />
  );

  if (to) {
    return (
      <Link to={to} title={help} style={style}>
        {corner}
        {body}
      </Link>
    );
  }

  return (
    <div title={help} style={style}>
      {corner}
      {body}
    </div>
  );
}
