import { theme } from '../theme';

// Handmade SVG vertical bars with pill ends. Fills its parent when height is "100%".
// Bars are spaced evenly across the full viewBox width so sparse data still uses the card.
export default function BarChart({ items, height = 160, barColor }) {
  const max = Math.max(1, ...items.map(i => i.value || 0));
  const n = items.length || 1;
  const padX = 4;
  const padBottom = 18;
  const padTop = 4;
  const vbW = 1000;
  const vbH = typeof height === 'number' ? height : 160;
  const slot = (vbW - padX * 2) / n;
  const barW = Math.max(6, Math.min(slot * 0.62, 28));
  const fillParent = height === '100%' || height === '100';
  const plotH = vbH - padBottom - padTop;

  function colorFor(i, idx) {
    if (i.color) return i.color;
    if (barColor) return barColor;
    const t = n <= 1 ? 0.35 : idx / (n - 1);
    if (t < 0.33) return theme.violetSoft;
    if (t < 0.66) return theme.violet;
    return theme.violetDeep;
  }

  return (
    <svg
      width="100%"
      height={fillParent ? '100%' : height}
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="none"
      style={{ display: 'block', flex: fillParent ? 1 : undefined, minHeight: fillParent ? 0 : undefined, width: '100%' }}
    >
      {items.map((item, idx) => {
        const h = item.value > 0
          ? Math.max(10, (item.value / max) * plotH)
          : Math.max(4, plotH * 0.06);
        const x = padX + idx * slot + (slot - barW) / 2;
        const y = padTop + plotH - h;
        return (
          <g key={item.label + idx}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx={Math.min(barW / 2, 8)}
              fill={colorFor(item, idx)}
              opacity={item.value > 0 ? 1 : 0.22}
            >
              <title>{`${item.label}: ${item.value}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
