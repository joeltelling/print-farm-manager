import { theme } from '../theme';

// Handmade SVG vertical bars. items: [{ label, value, color? }]
export default function BarChart({ items, height = 160, barColor }) {
  const max = Math.max(1, ...items.map(i => i.value || 0));
  const n = items.length || 1;
  const gap = 4;
  const width = Math.max(280, n * 18);
  const barW = Math.max(6, (width - gap * (n + 1)) / n);

  function colorFor(i, idx) {
    if (i.color) return i.color;
    if (barColor) return barColor;
    const t = n <= 1 ? 0 : idx / (n - 1);
    return t < 0.7 ? theme.limeDeep : theme.orange;
  }

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {items.map((item, idx) => {
        const h = Math.max(item.value > 0 ? 4 : 0, (item.value / max) * (height - 22));
        const x = gap + idx * (barW + gap);
        const y = height - 18 - h;
        return (
          <g key={item.label + idx}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={3}
              fill={colorFor(item, idx)}
            >
              <title>{`${item.label}: ${item.value}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
