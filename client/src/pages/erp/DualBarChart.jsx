import { theme } from '../../theme';

/**
 * Dual-series vertical bars (qty + value) for inventory warehouse cards.
 * items: [{ label, qty, value }]
 */
export default function DualBarChart({ items, height = 140 }) {
  const maxQty = Math.max(1, ...items.map(i => Number(i.qty) || 0));
  const maxVal = Math.max(1, ...items.map(i => Number(i.value) || 0));
  const n = items.length || 1;
  const padX = 8;
  const padBottom = 20;
  const padTop = 8;
  const vbW = 1000;
  const vbH = height;
  const slot = (vbW - padX * 2) / n;
  const barW = Math.max(4, Math.min(slot * 0.32, 18));
  const plotH = vbH - padBottom - padTop;

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 11, color: theme.textDim }}>
        <span><span style={{ color: theme.lime }}>■</span> Qty</span>
        <span><span style={{ color: theme.violetSoft }}>■</span> Value</span>
      </div>
      <svg width="100%" height={height} viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="none" style={{ display: 'block' }}>
        {items.map((item, idx) => {
          const qty = Number(item.qty) || 0;
          const val = Number(item.value) || 0;
          const hQty = qty > 0 ? Math.max(6, (qty / maxQty) * plotH) : 3;
          const hVal = val > 0 ? Math.max(6, (val / maxVal) * plotH) : 3;
          const x0 = padX + idx * slot + (slot - barW * 2 - 4) / 2;
          return (
            <g key={`${item.label}-${idx}`}>
              <rect
                x={x0}
                y={padTop + plotH - hQty}
                width={barW}
                height={hQty}
                rx={Math.min(barW / 2, 6)}
                fill={theme.lime}
                opacity={qty > 0 ? 0.9 : 0.25}
              >
                <title>{`${item.label} qty: ${qty}`}</title>
              </rect>
              <rect
                x={x0 + barW + 4}
                y={padTop + plotH - hVal}
                width={barW}
                height={hVal}
                rx={Math.min(barW / 2, 6)}
                fill={theme.violetSoft}
                opacity={val > 0 ? 0.9 : 0.25}
              >
                <title>{`${item.label} value: ${val}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
