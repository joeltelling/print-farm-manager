import { theme } from '../theme';

// Handmade SVG donut. segments: [{ value, color, label }]
export default function DonutChart({ segments, size = 180, thickness = 22, centerLabel, centerValue }) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const arcs = total > 0
    ? segments.filter(s => s.value > 0).map((seg) => {
        const len = (seg.value / total) * circumference;
        const arc = {
          ...seg,
          dash: `${len} ${circumference - len}`,
          offset: -offset,
        };
        offset += len;
        return arc;
      })
    : [];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          <circle
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={theme.cardAlt}
            strokeWidth={thickness}
          />
          {arcs.map((arc) => (
            <circle
              key={arc.label}
              cx={cx} cy={cy} r={r}
              fill="none"
              stroke={arc.color}
              strokeWidth={thickness}
              strokeDasharray={arc.dash}
              strokeDashoffset={arc.offset}
              strokeLinecap="butt"
            />
          ))}
        </svg>
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          {centerValue != null && (
            <div style={{ fontSize: 28, fontWeight: 800, color: theme.text, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
              {centerValue}
            </div>
          )}
          {centerLabel && (
            <div style={{ fontSize: 11, fontWeight: 600, color: theme.textDim, marginTop: 4 }}>
              {centerLabel}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {segments.map((seg) => (
          <div key={seg.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: seg.color, flexShrink: 0 }} />
            <span style={{ color: theme.textMuted }}>{seg.label}</span>
            <span style={{ color: theme.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {seg.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
