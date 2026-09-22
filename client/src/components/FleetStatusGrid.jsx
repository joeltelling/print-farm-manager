import useCameraHover from '../useCameraHover';
import { webUiLink } from '../webUiLink';

// Extracted from Dashboard.jsx so the Webcams page can show the identical
// grouped-by-model printer grid, with the same hover-to-preview camera behavior,
// instead of drifting into a second copy of this layout over time.

const CELL_COLORS = {
  PRINTING:  { bg: '#1e3a5f', text: '#60a5fa', border: '#1e40af' },
  IDLE:      { bg: '#1a2030', text: '#374151', border: '#232b3a' },
  FINISHED:  { bg: '#14532d', text: '#22c55e', border: '#15803d' },
  STOPPED:   { bg: '#431407', text: '#fb923c', border: '#7c2d12' },
  PAUSED:    { bg: '#451a03', text: '#f59e0b', border: '#78350f' },
  ATTENTION: { bg: '#451a03', text: '#f59e0b', border: '#78350f' },
  ERROR:     { bg: '#450a0a', text: '#ef4444', border: '#7f1d1d' },
  OFFLINE:   { bg: '#0d1117', text: '#1f2937', border: '#161b22' },
};

const LEGEND_ITEMS = [
  { label: 'Printing', color: '#3b82f6' },
  { label: 'Awaiting Sign-off', color: '#22c55e' },
  { label: 'Idle',     color: '#4b5563' },
  { label: 'Stopped',  color: '#fb923c' },
  { label: 'Error',    color: '#ef4444' },
  { label: 'Offline',  color: '#374151' },
];

const ROW_STATUSES = ['PRINTING', 'FINISHED', 'IDLE', 'ERROR', 'STOPPED', 'OFFLINE'];

function cellColors(printer) {
  // Held printer (awaiting operator sign-off) renders as green regardless of status.
  // Keep this condition identical to Fleet.jsx and Printers.jsx (see CLAUDE.md sync pairs).
  if (printer.is_held === 1 && (printer.status === 'FINISHED' || printer.status === 'IDLE' || printer.status === 'STOPPED')) {
    return CELL_COLORS.FINISHED;
  }
  return CELL_COLORS[printer.status] || CELL_COLORS.IDLE;
}

function RowSummary({ group }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
      {ROW_STATUSES.map(s => {
        const count = group.filter(p => {
          const isAwaiting = p.is_held === 1 && (p.status === 'FINISHED' || p.status === 'IDLE' || p.status === 'STOPPED');
          if (s === 'FINISHED') return isAwaiting;
          return p.status === s && !isAwaiting;
        }).length;
        if (count === 0) return null;
        const c = CELL_COLORS[s] || CELL_COLORS.IDLE;
        const label = s === 'FINISHED' ? 'AWAITING' : s;
        return (
          <span key={s} style={{
            fontSize: 10, color: c.text, background: c.bg,
            border: `1px solid ${c.border}`, borderRadius: 3,
            padding: '1px 6px', fontWeight: 700,
          }}>
            {count} {label}
          </span>
        );
      })}
    </div>
  );
}

// `title` is the panel header text (Dashboard uses "Fleet Status"; Webcams
// overrides it). `showLegend` defaults on; Webcams also shows it for the same
// reason Dashboard does; every printer.status still needs a decoder.
export default function FleetStatusGrid({ printers, allModels, title = 'Fleet Status', showLegend = true }) {
  const { onEnter, onLeave, previewEl } = useCameraHover();

  const modelOrder = allModels.map(m => m.model_id);
  const MODEL_LABELS = Object.fromEntries(allModels.map(m => [m.model_id, m.label]));
  MODEL_LABELS.other = 'Other';
  const grouped = modelOrder.reduce((acc, m) => {
    const g = printers.filter(p => p.model === m);
    if (g.length) acc[m] = g;
    return acc;
  }, {});
  const others = printers.filter(p => !modelOrder.includes(p.model));
  if (others.length) grouped['other'] = others;

  return (
    <div style={{ background: '#111827', borderRadius: 10, padding: '16px 20px' }}>
      <div style={{
        fontSize: 11, color: '#374151',
        textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700,
        marginBottom: 14,
      }}>
        {title}
      </div>

      {/* Each model gets its own self-contained chip (label above its cells, not
          squeezed into a fixed-width side column) rather than one full-width row
          per model. Two problems this fixes together: a long model name no longer
          collides with the printer boxes next to it (it now wraps freely on its
          own line above them instead of fighting a narrow fixed column for space),
          and a fleet with many small model groups (e.g. one printer each) packs
          those chips several to a line via flexWrap instead of stacking one
          mostly-empty full-width row per model. A model with many printers still
          gets a wide chip whose own cell row wraps internally as before. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
        {Object.entries(grouped).map(([model, group]) => (
          <div key={model} style={{
            display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
            background: '#0d1117', border: '1px solid #1a2030', borderRadius: 8,
            padding: '8px 10px',
          }}>

            {/* Model label */}
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>
                {MODEL_LABELS[model] || model}
              </div>
              <div style={{ fontSize: 11, color: '#374151', flexShrink: 0 }}>×{group.length}</div>
            </div>

            {/* Printer cells */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {group.map(printer => {
                const c = cellColors(printer);
                const link = webUiLink(printer);
                return (
                  <div
                    key={printer.id}
                    title={link ? `${printer.name}: ${printer.status} (click to open ${link.label.replace(' ↗', '')})` : `${printer.name}: ${printer.status}`}
                    onMouseEnter={e => onEnter(printer, e)}
                    onMouseLeave={onLeave}
                    onClick={link ? () => window.open(link.url, '_blank') : undefined}
                    style={{
                      width: 54, height: 44, borderRadius: 6,
                      background: c.bg, border: `1px solid ${c.border}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: link ? 'pointer' : 'default',
                    }}
                  >
                    <span style={{
                      fontFamily: 'monospace', fontSize: 8, color: c.text,
                      textAlign: 'center', padding: '0 3px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      width: '100%',
                    }}>
                      {printer.name}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Per-model status summary */}
            <RowSummary group={group} />
          </div>
        ))}
      </div>

      {/* Color legend */}
      {showLegend && (
        <div style={{
          display: 'flex', gap: 18, marginTop: 14,
          paddingTop: 12, borderTop: '1px solid #1e2433',
        }}>
          {LEGEND_ITEMS.map(({ label, color }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: '#475569' }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      {previewEl}
    </div>
  );
}
