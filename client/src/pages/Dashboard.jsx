import { useState, useEffect, useCallback, useRef } from 'react';

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_ORDER  = ['mk4', 'mk4s', 'c1', 'c1l', 'xl'];
const MODEL_LABELS = { mk4: 'MK4', mk4s: 'MK4S', c1: 'Core One', c1l: 'Core 1L', xl: 'XL', other: 'Other' };

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

const STAT_CARDS = [
  { key: 'printing',    label: 'Printing',    color: '#3b82f6', accent: '#1e40af' },
  { key: 'idle',        label: 'Idle',        color: '#6b7280', accent: '#374151' },
  { key: 'awaiting',    label: 'Awaiting',    color: '#22c55e', accent: '#15803d' },
  { key: 'parts_today', label: 'Parts Today', color: '#a78bfa', accent: '#7c3aed' },
];

const LEGEND_ITEMS = [
  { label: 'Printing', color: '#3b82f6' },
  { label: 'Awaiting', color: '#22c55e' },
  { label: 'Idle',     color: '#4b5563' },
  { label: 'Stopped',  color: '#fb923c' },
  { label: 'Error',    color: '#ef4444' },
  { label: 'Offline',  color: '#374151' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function cellColors(printer) {
  // Held printer (awaiting operator sign-off) renders as green regardless of status
  if (printer.is_held === 1 && (printer.status === 'FINISHED' || printer.status === 'IDLE')) {
    return CELL_COLORS.FINISHED;
  }
  return CELL_COLORS[printer.status] || CELL_COLORS.IDLE;
}

function formatTime(d) {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(ts) {
  if (!ts) return '—';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
}

// ── Row-level status summary badges for the fleet grid ───────────────────────

const ROW_STATUSES = ['PRINTING', 'FINISHED', 'IDLE', 'ERROR', 'STOPPED', 'OFFLINE'];

function RowSummary({ group }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
      {ROW_STATUSES.map(s => {
        const count = group.filter(p => {
          const isAwaiting = p.is_held === 1 && (p.status === 'FINISHED' || p.status === 'IDLE');
          if (s === 'FINISHED') return isAwaiting;
          return p.status === s && !isAwaiting;
        }).length;
        if (count === 0) return null;
        const c = CELL_COLORS[s] || CELL_COLORS.IDLE;
        const label = s === 'FINISHED' ? 'AWAIT' : s.slice(0, 4);
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

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [data,  setData]  = useState(null);
  const [clock, setClock] = useState(new Date());
  const dashRef = useRef(null);

  // 1-second clock
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Data fetch — 15s poll, matches Fleet page
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard');
      if (res.ok) setData(await res.json());
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 15000);
    return () => clearInterval(id);
  }, [fetchData]);

  function enterTV() {
    dashRef.current?.requestFullscreen?.();
  }

  if (!data) {
    return (
      <div style={{
        background: '#0a0f1a', height: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#475569', fontSize: 18,
      }}>
        Loading…
      </div>
    );
  }

  const { stats, printers, active_projects, recent_activity } = data;

  // Group printers by model for the fleet grid
  const grouped = MODEL_ORDER.reduce((acc, m) => {
    const g = printers.filter(p => p.model === m);
    if (g.length) acc[m] = g;
    return acc;
  }, {});
  const others = printers.filter(p => !MODEL_ORDER.includes(p.model));
  if (others.length) grouped['other'] = others;

  const utilPct = printers.length > 0
    ? Math.round((stats.printing / printers.length) * 100)
    : 0;

  return (
    <div
      ref={dashRef}
      style={{
        background: '#0a0f1a',
        minHeight: '100vh',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#e2e8f0',
        userSelect: 'none',
      }}
    >

      {/* ── HEADER ────────────────────────────────────────────────────────── */}
      <div style={{
        background: '#0d1117', borderBottom: '1px solid #1e2433',
        padding: '0 28px', height: 64,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>

        {/* Left: branding */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 4, height: 36, background: '#1d4ed8', borderRadius: 2, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: '0.05em', color: '#f1f5f9' }}>
              PRINT FARM
            </div>
            <div style={{ fontSize: 11, color: '#475569', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 1 }}>
              Command Center
            </div>
          </div>
        </div>

        {/* Center: utilization */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Fleet Utilization
          </span>
          <span style={{ fontSize: 32, fontWeight: 800, color: '#3b82f6', fontVariantNumeric: 'tabular-nums' }}>
            {utilPct}%
          </span>
          <span style={{ fontSize: 13, color: '#374151' }}>
            ({stats.printing} / {printers.length})
          </span>
        </div>

        {/* Right: clock + TV mode button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, color: '#60a5fa', lineHeight: 1 }}>
              {formatTime(clock)}
            </div>
            <div style={{ fontSize: 12, color: '#475569', marginTop: 3 }}>
              {formatDate(clock)}
            </div>
          </div>
          <button
            onClick={enterTV}
            title="Enter fullscreen TV mode"
            style={{
              background: '#1e2433', color: '#64748b',
              border: '1px solid #2d3748', borderRadius: 6,
              padding: '6px 12px', fontSize: 12, cursor: 'pointer',
            }}
          >
            ⛶ TV Mode
          </button>
        </div>
      </div>

      <div style={{ padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── STAT CARDS ──────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {STAT_CARDS.map(({ key, label, color, accent }) => (
            <div key={key} style={{
              background: '#1e2433', borderRadius: 8,
              padding: '16px 20px',
              display: 'flex', alignItems: 'center', gap: 18,
              borderLeft: `4px solid ${accent}`,
            }}>
              <div style={{
                fontSize: 52, fontWeight: 800, color, lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {(stats[key] ?? 0).toLocaleString()}
              </div>
              <div style={{
                fontSize: 11, color: '#475569',
                textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700,
              }}>
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* ── FLEET GRID ──────────────────────────────────────────────────── */}
        <div style={{ background: '#111827', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{
            fontSize: 11, color: '#374151',
            textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700,
            marginBottom: 14,
          }}>
            Fleet Status
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.entries(grouped).map(([model, group]) => (
              <div key={model} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>

                {/* Model label */}
                <div style={{ width: 76, flexShrink: 0, textAlign: 'right' }}>
                  <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>
                    {MODEL_LABELS[model] || model}
                  </div>
                  <div style={{ fontSize: 11, color: '#374151' }}>×{group.length}</div>
                </div>

                {/* Printer cells */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
                  {group.map(printer => {
                    const c = cellColors(printer);
                    return (
                      <div
                        key={printer.id}
                        title={`${printer.name} — ${printer.status}`}
                        style={{
                          width: 54, height: 44, borderRadius: 6,
                          background: c.bg, border: `1px solid ${c.border}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
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

                {/* Per-row status summary */}
                <RowSummary group={group} />
              </div>
            ))}
          </div>

          {/* Color legend */}
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
        </div>

        {/* ── BOTTOM ROW ──────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* Active Projects */}
          <div style={{ background: '#111827', borderRadius: 10, padding: '16px 20px' }}>
            <div style={{
              fontSize: 11, color: '#374151',
              textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700,
              marginBottom: 14,
            }}>
              Active Projects
            </div>

            {active_projects.length === 0 ? (
              <p style={{ color: '#374151', fontSize: 13, margin: 0 }}>No active projects.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {active_projects.map(proj => (
                  <div key={proj.id} style={{
                    background: '#1e2433', borderRadius: 8, padding: '12px 14px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{proj.name}</span>
                      <span style={{
                        background: '#166534', color: '#4ade80',
                        borderRadius: 3, padding: '1px 7px',
                        fontSize: 10, fontWeight: 700,
                      }}>
                        ACTIVE
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {proj.parts.map(part => {
                        const pct = part.target_qty > 0
                          ? Math.min(100, Math.round((part.completed_qty / part.target_qty) * 100))
                          : 0;
                        const barColor = part.status === 'closed' || pct >= 75 ? '#22c55e' : '#3b82f6';
                        return (
                          <div key={part.id}>
                            <div style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              marginBottom: 4,
                            }}>
                              <span style={{ fontSize: 12, color: '#94a3b8' }}>{part.name}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 11, color: '#475569', fontVariantNumeric: 'tabular-nums' }}>
                                  {part.completed_qty.toLocaleString()} / {part.target_qty.toLocaleString()}
                                </span>
                                <span style={{ fontSize: 11, fontWeight: 700, color: barColor, minWidth: 30, textAlign: 'right' }}>
                                  {pct}%
                                </span>
                                {part.status === 'closed' && (
                                  <span style={{
                                    background: '#14532d', color: '#22c55e',
                                    borderRadius: 3, padding: '1px 5px',
                                    fontSize: 9, fontWeight: 700,
                                  }}>
                                    DONE
                                  </span>
                                )}
                              </div>
                            </div>
                            <div style={{ background: '#0f172a', borderRadius: 3, height: 5, overflow: 'hidden' }}>
                              <div style={{
                                width: `${pct}%`, height: '100%',
                                background: barColor, borderRadius: 3,
                                transition: 'width 0.5s',
                              }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Activity */}
          <div style={{ background: '#111827', borderRadius: 10, padding: '16px 20px' }}>
            <div style={{
              fontSize: 11, color: '#374151',
              textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700,
              marginBottom: 14,
            }}>
              Recent Activity
            </div>

            {recent_activity.length === 0 ? (
              <p style={{ color: '#374151', fontSize: 13, margin: 0 }}>No recent jobs.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {recent_activity.map((job, i) => {
                  const ok = job.status === 'finished';
                  return (
                    <div
                      key={job.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 10px', borderRadius: 6,
                        background: i % 2 === 0 ? '#1e2433' : '#151d2b',
                      }}
                    >
                      <span style={{ fontSize: 15, flexShrink: 0, lineHeight: 1, color: ok ? '#22c55e' : '#ef4444' }}>
                        {ok ? '✓' : '✗'}
                      </span>
                      <span style={{
                        flex: 1, fontSize: 13,
                        color: ok ? '#e2e8f0' : '#f87171',
                        fontWeight: ok ? 400 : 600,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {ok ? `${job.parts_per_plate}×` : 'FAILED —'} {job.part_name}
                      </span>
                      <span style={{ fontSize: 11, color: '#3b82f6', fontFamily: 'monospace', flexShrink: 0 }}>
                        {job.printer_name}
                      </span>
                      <span style={{ fontSize: 11, color: '#374151', flexShrink: 0, minWidth: 58, textAlign: 'right' }}>
                        {timeAgo(job.finished_at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
