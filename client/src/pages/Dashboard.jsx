import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import PollTimer from '../components/PollTimer';
import KpiCard from '../components/KpiCard';
import DonutChart from '../components/DonutChart';
import BarChart from '../components/BarChart';
import Card from '../components/Card';
import { theme } from '../theme';

const POLL_INTERVAL_MS = 15000;

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
  { key: 'printing',    label: 'Printing',    color: '#3b82f6', help: null },
  { key: 'idle',        label: 'Idle',        color: '#6b7280', help: null },
  { key: 'awaiting',    label: 'Awaiting Sign-off', color: '#22c55e', help: 'Finished prints waiting for an operator to confirm good/bad before the next job dispatches' },
  { key: 'parts_today', label: 'Parts Today', color: '#a78bfa', help: null },
];

const LEGEND_ITEMS = [
  { label: 'Printing', color: '#3b82f6' },
  { label: 'Awaiting Sign-off', color: '#22c55e' },
  { label: 'Idle',     color: '#4b5563' },
  { label: 'Stopped',  color: '#fb923c' },
  { label: 'Error',    color: '#ef4444' },
  { label: 'Offline',  color: '#374151' },
];

const ATTENTION_ORDER = { AWAITING: 0, ERROR: 1, STOPPED: 2, PAUSED: 3, OFFLINE: 4 };

function cellColors(printer) {
  // Held printer (awaiting operator sign-off) renders as green regardless of status.
  // Keep this condition identical to Fleet.jsx and Printers.jsx (see CLAUDE.md sync pairs).
  if (printer.is_held === 1 && (printer.status === 'FINISHED' || printer.status === 'IDLE' || printer.status === 'STOPPED')) {
    return CELL_COLORS.FINISHED;
  }
  return CELL_COLORS[printer.status] || CELL_COLORS.IDLE;
}

function isAwaiting(p) {
  return p.is_held === 1 && (p.status === 'FINISHED' || p.status === 'IDLE' || p.status === 'STOPPED');
}

function attentionReason(p) {
  if (isAwaiting(p)) return 'AWAITING';
  if (p.status === 'ERROR') return 'ERROR';
  if (p.status === 'STOPPED') return 'STOPPED';
  if (p.status === 'PAUSED') return 'PAUSED';
  if (p.status === 'OFFLINE') return 'OFFLINE';
  return null;
}

function formatTime(d) {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(secs) {
  if (!secs) return null;
  const MINUTE = 60, HOUR = 3600, DAY = 86400, WEEK = 604800;
  if (secs >= WEEK) {
    const w = Math.floor(secs / WEEK);
    const d = Math.floor((secs % WEEK) / DAY);
    return d > 0 ? `${w}wk ${d}d` : `${w}wk`;
  }
  if (secs >= DAY) {
    const d = Math.floor(secs / DAY);
    const h = Math.floor((secs % DAY) / HOUR);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  const h = Math.floor(secs / HOUR);
  const m = Math.floor((secs % HOUR) / MINUTE);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatMaterial(grams) {
  if (grams == null) return null;
  if (grams < 1000) return `${Math.round(grams)}g`;
  const kg = (grams / 1000).toFixed(2).replace(/\.?0+$/, '');
  return `${kg}kg`;
}

function formatWait(ms, now) {
  if (!ms) return 'waiting';
  return formatDuration(Math.max(0, Math.round((now - ms) / 1000))) || '< 1m';
}

const ROW_STATUSES = ['PRINTING', 'FINISHED', 'IDLE', 'ERROR', 'STOPPED', 'OFFLINE'];

function RowSummary({ group }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
      {ROW_STATUSES.map(s => {
        const count = group.filter(p => {
          if (s === 'FINISHED') return isAwaiting(p);
          return p.status === s && !isAwaiting(p);
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

export default function Dashboard() {
  const [data,  setData]  = useState(null);
  const [clock, setClock] = useState(new Date());
  const [allModels, setAllModels] = useState([]);
  const [lastPolled, setLastPolled] = useState(null);
  const [farmName, setFarmName] = useState('CoMa');
  const dashRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setAllModels).catch(() => {});
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => { if (s.farm_name) setFarmName(s.farm_name); })
      .catch(() => {});
    const onName = (e) => setFarmName(e.detail);
    window.addEventListener('farmNameChanged', onName);
    return () => window.removeEventListener('farmNameChanged', onName);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard');
      if (res.ok) {
        setData(await res.json());
        setLastPolled(Date.now());
      }
    } catch (_) {}
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  function enterTV() {
    dashRef.current?.requestFullscreen?.();
  }

  if (!data) {
    return (
      <div style={{
        background: theme.page, height: '60vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: theme.textFaint, fontSize: 18,
      }}>
        Loading…
      </div>
    );
  }

  const { stats, printers, active_projects, parts_by_hour = [] } = data;

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

  const utilPct = printers.length > 0
    ? Math.round((stats.printing / printers.length) * 100)
    : 0;

  const errorCount = printers.filter(p => p.status === 'ERROR').length;
  const offlineCount = printers.filter(p => p.status === 'OFFLINE').length;
  const donutSegments = [
    { label: 'Printing', value: stats.printing || 0, color: '#3b82f6' },
    { label: 'Idle', value: stats.idle || 0, color: '#64748b' },
    { label: 'Awaiting', value: stats.awaiting || 0, color: '#22c55e' },
    { label: 'Error', value: errorCount, color: '#ef4444' },
    { label: 'Offline', value: offlineCount, color: '#374151' },
  ];

  const barItems = parts_by_hour.map(h => ({
    label: new Date(h.hour_start).toLocaleTimeString('en-US', { hour: 'numeric' }),
    value: h.parts || 0,
  }));

  const now = Date.now();
  const attention = printers
    .map(p => ({ printer: p, reason: attentionReason(p) }))
    .filter(x => x.reason)
    .sort((a, b) => {
      const po = ATTENTION_ORDER[a.reason] - ATTENTION_ORDER[b.reason];
      if (po !== 0) return po;
      return (a.printer.last_event_at || 0) - (b.printer.last_event_at || 0);
    });

  return (
    <div
      ref={dashRef}
      style={{
        background: theme.page,
        minHeight: '100%',
        color: theme.text,
        userSelect: 'none',
      }}
    >
      <style>{`
        .coma-kpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
        .coma-charts { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 12px; }
        @media (max-width: 1100px) {
          .coma-kpi { grid-template-columns: repeat(2, 1fr); }
          .coma-charts { grid-template-columns: 1fr; }
        }
        @media (max-width: 600px) {
          .coma-kpi { grid-template-columns: 1fr; }
        }
      `}</style>

      <div style={{
        background: theme.sidebar, border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        padding: '12px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap', marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 4, height: 36, background: theme.accent, borderRadius: 2, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 20, letterSpacing: '0.04em', color: '#f1f5f9' }}>
              {farmName}
            </div>
            <div style={{ fontSize: 11, color: theme.textFaint, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 1 }}>
              CoreManufacturing
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, color: theme.textFaint, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Utilization
          </span>
          <span style={{ fontSize: 32, fontWeight: 800, color: '#3b82f6', fontVariantNumeric: 'tabular-nums' }}>
            {utilPct}%
          </span>
          <span style={{ fontSize: 13, color: theme.textFaint }}>
            ({stats.printing} / {printers.length})
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, color: '#60a5fa', lineHeight: 1 }}>
              {formatTime(clock)}
            </div>
            <div style={{ fontSize: 12, color: theme.textFaint, marginTop: 3 }}>
              {formatDate(clock)}
            </div>
          </div>
          <PollTimer lastPolled={lastPolled} intervalMs={POLL_INTERVAL_MS} size={28} />
          <button
            onClick={enterTV}
            title="Enter fullscreen TV mode"
            style={{
              background: theme.cardAlt, color: theme.textDim,
              border: `1px solid ${theme.border}`, borderRadius: 8,
              padding: '6px 12px', fontSize: 12, cursor: 'pointer',
            }}
          >
            TV Mode
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="coma-kpi">
          {STAT_CARDS.map(({ key, label, color, help }) => (
            <KpiCard
              key={key}
              label={label}
              color={color}
              help={help}
              value={(stats[key] ?? 0).toLocaleString()}
            />
          ))}
        </div>

        <div className="coma-charts">
          <Card title="Parts last 24h">
            {barItems.every(i => i.value === 0) ? (
              <p style={{ color: theme.textDim, fontSize: 13, margin: 0 }}>No finished parts in the last 24 hours.</p>
            ) : (
              <BarChart items={barItems} height={150} />
            )}
          </Card>

          <Card title="Fleet mix">
            <DonutChart
              segments={donutSegments}
              size={150}
              thickness={18}
              centerValue={`${utilPct}%`}
              centerLabel="util"
            />
          </Card>

          <Card title="Needs attention">
            {attention.length === 0 ? (
              <div style={{
                background: '#14532d', color: '#86efac',
                borderRadius: 8, padding: '10px 12px', fontSize: 13, fontWeight: 700,
              }}>
                All clear
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                {attention.map(({ printer, reason }) => {
                  const c = CELL_COLORS[reason === 'AWAITING' ? 'FINISHED' : reason] || CELL_COLORS.IDLE;
                  return (
                    <button
                      key={printer.id}
                      onClick={() => navigate(`/printers/${printer.id}`)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        background: theme.cardAlt, border: `1px solid ${theme.border}`,
                        borderRadius: 8, padding: '7px 10px', cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      <span style={{
                        fontSize: 10, fontWeight: 800, color: c.text, background: c.bg,
                        borderRadius: 4, padding: '1px 6px',
                      }}>
                        {reason}
                      </span>
                      <span style={{ flex: 1, fontSize: 13, color: theme.text, fontWeight: 600 }}>
                        {printer.name}
                      </span>
                      <span style={{ fontSize: 11, color: theme.textDim }}>
                        {formatWait(printer.last_event_at, now)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <Card title="Fleet status">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.entries(grouped).map(([model, group]) => (
              <div key={model} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 76, flexShrink: 0, textAlign: 'right' }}>
                  <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 600 }}>
                    {MODEL_LABELS[model] || model}
                  </div>
                  <div style={{ fontSize: 11, color: theme.textFaint }}>x{group.length}</div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
                  {group.map(printer => {
                    const c = cellColors(printer);
                    return (
                      <button
                        key={printer.id}
                        title={`${printer.name}: ${printer.status}`}
                        onClick={() => navigate(`/printers/${printer.id}`)}
                        style={{
                          width: 54, height: 44, borderRadius: 8,
                          background: c.bg, border: `1px solid ${c.border}`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', padding: 0,
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
                      </button>
                    );
                  })}
                </div>
                <RowSummary group={group} />
              </div>
            ))}
          </div>
          <div style={{
            display: 'flex', gap: 18, marginTop: 14,
            paddingTop: 12, borderTop: `1px solid ${theme.border}`, flexWrap: 'wrap',
          }}>
            {LEGEND_ITEMS.map(({ label, color }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: theme.textFaint }}>{label}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Active projects">
          {active_projects.length === 0 ? (
            <p style={{ color: theme.textMuted, fontSize: 13, margin: 0 }}>
              No active projects. Create one on the Projects page and set it Active to track production here.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {active_projects.map(proj => {
                const hasStats = (proj.elapsed_secs > 0) || (proj.material_used_grams > 0);
                return (
                  <div key={proj.id} style={{
                    background: theme.cardAlt, borderRadius: 10, padding: '12px 14px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{proj.name}</span>
                      <span style={{
                        background: '#166534', color: '#4ade80',
                        borderRadius: 999, padding: '1px 8px',
                        fontSize: 10, fontWeight: 700,
                      }}>
                        ACTIVE
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {proj.parts.map(part => {
                        const activeQty    = part.active_qty || 0;
                        const scale        = Math.max(part.target_qty, part.completed_qty + activeQty);
                        const completedPct = scale > 0 ? (part.completed_qty / scale) * 100 : 0;
                        const activePct    = scale > 0 ? (activeQty / scale) * 100 : 0;
                        const isOver       = part.completed_qty + activeQty > part.target_qty;
                        const targetTickPct = isOver && scale > 0 ? (part.target_qty / scale) * 100 : null;
                        const pct = part.target_qty > 0
                          ? Math.round((part.completed_qty / part.target_qty) * 100)
                          : 0;
                        return (
                          <div key={part.id}>
                            <div style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              marginBottom: 4,
                            }}>
                              <span style={{ fontSize: 12, color: theme.text, fontWeight: 500 }}>{part.name}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                                  <span style={{ color: theme.text }}>{part.completed_qty.toLocaleString()}</span>
                                  {activeQty > 0 && (
                                    <span style={{ color: '#60a5fa' }}> +{activeQty.toLocaleString()}</span>
                                  )}
                                  <span style={{ color: theme.textFaint }}>{' / '}{part.target_qty.toLocaleString()}</span>
                                </span>
                                <span style={{ fontSize: 12, fontWeight: 700, color: part.status === 'closed' ? '#4ade80' : '#60a5fa', minWidth: 34, textAlign: 'right' }}>
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
                            <div style={{ position: 'relative', background: theme.page, borderRadius: 4, height: 9 }}>
                              <div style={{
                                position: 'absolute', left: 0, top: 0, height: '100%',
                                width: `${completedPct}%`,
                                background: '#22c55e',
                                borderRadius: activePct > 0 ? '4px 0 0 4px' : 4,
                                transition: 'width 0.5s',
                              }} />
                              {activePct > 0 && (
                                <div style={{
                                  position: 'absolute', left: `${completedPct}%`, top: 0, height: '100%',
                                  width: `${activePct}%`,
                                  background: '#3b82f6',
                                  borderRadius: '0 4px 4px 0',
                                  transition: 'width 0.5s',
                                }} />
                              )}
                              {targetTickPct !== null && (
                                <div style={{
                                  position: 'absolute', left: `${targetTickPct}%`, top: 0,
                                  width: 2, height: '100%',
                                  background: '#f59e0b',
                                  transform: 'translateX(-50%)',
                                }} />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {hasStats && (
                      <div style={{
                        borderTop: `1px solid ${theme.border}`, marginTop: 10, paddingTop: 8,
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, flexWrap: 'wrap',
                      }}>
                        <span style={{ fontWeight: 700, color: '#cbd5e1' }}>So far</span>
                        {proj.elapsed_secs > 0 && (
                          <span style={{ color: theme.textMuted }}>{formatDuration(proj.elapsed_secs)}</span>
                        )}
                        {proj.material_used_grams > 0 && (
                          <span style={{ color: '#a78bfa' }}>{formatMaterial(proj.material_used_grams)}</span>
                        )}
                        {proj.model_breakdown && proj.model_breakdown.length > 1 && (
                          <span style={{ color: theme.textDim }}>
                            {proj.model_breakdown.map(m => m.printer_model).join(', ')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
