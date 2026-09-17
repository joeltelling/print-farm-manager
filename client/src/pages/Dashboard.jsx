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
  PRINTING:  { bg: '#2e1065', text: '#c4b5fd', border: '#6d28d9' },
  IDLE:      { bg: '#18181f', text: '#71717a', border: '#27272a' },
  FINISHED:  { bg: '#062b22', text: '#a3e635', border: '#3f6212' },
  STOPPED:   { bg: '#431407', text: '#f59e0b', border: '#7c2d12' },
  PAUSED:    { bg: '#422006', text: '#fbbf24', border: '#854d0e' },
  ATTENTION: { bg: '#422006', text: '#fbbf24', border: '#854d0e' },
  ERROR:     { bg: '#450a0a', text: '#f87171', border: '#7f1d1d' },
  OFFLINE:   { bg: '#09090b', text: '#3f3f46', border: '#18181b' },
};

const STAT_CARDS = [
  { key: 'printing',    label: 'Printing',    color: '#a78bfa', help: null },
  { key: 'idle',        label: 'Idle',        color: '#71717a', help: null },
  { key: 'awaiting',    label: 'Awaiting Sign-off', color: '#a3e635', help: 'Finished prints waiting for an operator to confirm good/bad before the next job dispatches' },
  { key: 'parts_today', label: 'Parts Today', color: '#2dd4bf', help: null },
];

const LEGEND_ITEMS = [
  { label: 'Printing', color: '#8b5cf6' },
  { label: 'Awaiting Sign-off', color: '#a3e635' },
  { label: 'Idle',     color: '#52525b' },
  { label: 'Stopped',  color: '#f59e0b' },
  { label: 'Error',    color: '#f87171' },
  { label: 'Offline',  color: '#3f3f46' },
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

export default function Dashboard() {
  const [data,  setData]  = useState(null);
  const [clock, setClock] = useState(new Date());
  const [allModels, setAllModels] = useState([]);
  const [lastPolled, setLastPolled] = useState(null);
  const [closureBlock, setClosureBlock] = useState(null);
  const dashRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setAllModels).catch(() => {});
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
    try {
      const bl = await fetch('/api/calendar/dispatch-block');
      if (bl.ok) {
        const body = await bl.json();
        setClosureBlock(body.active ? body.block : null);
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
    { label: 'Printing', value: stats.printing || 0, color: theme.violetDeep },
    { label: 'Idle', value: stats.idle || 0, color: '#3f3f46' },
    { label: 'Awaiting', value: stats.awaiting || 0, color: theme.limeDeep },
    { label: 'Error', value: errorCount, color: theme.red },
    { label: 'Offline', value: offlineCount, color: '#27272a' },
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
      className="coma-dash"
      style={{
        background: theme.page,
        color: theme.text,
        userSelect: 'none',
      }}
    >
      <style>{`
        .coma-dash {
          display: grid;
          grid-template-rows: auto auto minmax(0, 1fr) minmax(0, 1.55fr);
          gap: 12px;
          flex: 1;
          min-height: 0;
          height: 100%;
          box-sizing: border-box;
        }
        .coma-dash:fullscreen,
        .coma-dash:-webkit-full-screen {
          height: 100vh;
          width: 100vw;
          padding: 16px 20px;
          background: ${theme.page};
        }
        .coma-kpi {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
          min-width: 0;
        }
        .coma-charts {
          display: grid;
          grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
          gap: 12px;
          min-height: 0;
          min-width: 0;
        }
        .coma-charts > * { min-height: 0; min-width: 0; height: 100%; }
        .coma-bottom {
          display: grid;
          grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr);
          gap: 12px;
          min-height: 0;
          min-width: 0;
        }
        .coma-bottom > * { min-height: 0; min-width: 0; height: 100%; }
        .coma-fleet-body {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-rows: minmax(0, 1fr) auto;
          gap: 10px;
        }
        .coma-fleet-cells {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          grid-auto-rows: minmax(0, 1fr);
          gap: 8px;
          min-height: 0;
          height: 100%;
          align-content: stretch;
        }
        .coma-fleet-cell {
          min-height: 0;
          border-radius: 12px;
          display: flex;
          flex-direction: column;
          align-items: stretch;
          justify-content: center;
          gap: 4px;
          cursor: pointer;
          padding: 10px 12px;
          text-align: left;
          overflow: hidden;
        }
        .coma-projects-body {
          flex: 1;
          min-height: 0;
          overflow: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        @media (max-width: 1200px) {
          .coma-charts { grid-template-columns: 1fr 1fr; }
          .coma-charts > :first-child { grid-column: 1 / -1; }
        }
        @media (max-width: 1100px) {
          .coma-dash {
            height: auto;
            flex: none;
            min-height: 0;
            grid-template-rows: auto;
          }
          .coma-kpi { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .coma-charts { grid-template-columns: 1fr; }
          .coma-charts > :first-child { grid-column: auto; }
          .coma-bottom { grid-template-columns: 1fr; }
          .coma-fleet-cells {
            height: auto;
            grid-auto-rows: minmax(88px, auto);
          }
        }
        @media (max-width: 600px) {
          .coma-kpi { grid-template-columns: 1fr; }
          .coma-fleet-cells { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
        }
      `}</style>

      {/* Slim top bar: util + clock only. Site name lives in the sidebar. */}
      <div style={{
        background: theme.sidebar, border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        padding: '10px 18px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 12, color: theme.textFaint, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 700 }}>
            Utilization
          </span>
          <span style={{ fontSize: 36, fontWeight: 800, color: theme.lime, fontVariantNumeric: 'tabular-nums', lineHeight: 1, textShadow: `0 0 24px ${theme.limeGlow}` }}>
            {utilPct}%
          </span>
          <span style={{ fontSize: 13, color: theme.textMuted }}>
            {stats.printing} of {printers.length} printing
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, color: theme.violetSoft, lineHeight: 1 }}>
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

      {closureBlock && (
        <div
          onClick={() => navigate('/calendar')}
          style={{
            padding: '10px 14px',
            borderRadius: 10,
            border: `1px solid ${theme.redDeep}`,
            background: 'rgba(248, 113, 113, 0.08)',
            color: theme.red,
            fontSize: 13,
            cursor: 'pointer',
          }}
          title="Open Calendar"
        >
          Production closure active: <strong style={{ color: theme.text }}>{closureBlock.title}</strong>
          {closureBlock.end_at
            ? ` - no new jobs until ${new Date(closureBlock.end_at).toLocaleString()}`
            : ' - no new jobs until further notice'}
          . Click to open Calendar.
        </div>
      )}

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
        <Card title="Parts last 24h" fill>
          {barItems.every(i => i.value === 0) ? (
            <p style={{ color: theme.textDim, fontSize: 13, margin: 'auto 0' }}>No finished parts in the last 24 hours.</p>
          ) : (
            <BarChart items={barItems} height="100%" />
          )}
        </Card>

        <Card title="Fleet mix" fill>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <DonutChart
              segments={donutSegments}
              size={150}
              thickness={18}
              centerValue={printers.length}
              centerLabel="printers"
            />
          </div>
        </Card>

        <Card title="Needs attention" fill>
          {attention.length === 0 ? (
            <div style={{
              background: '#062b22', color: '#6ee7b7',
              borderRadius: 8, padding: '10px 12px', fontSize: 13, fontWeight: 700,
              margin: 'auto 0',
            }}>
              All clear
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {attention.map(({ printer, reason }) => {
                const c = CELL_COLORS[reason === 'AWAITING' ? 'FINISHED' : reason] || CELL_COLORS.IDLE;
                return (
                  <button
                    key={printer.id}
                    onClick={() => navigate(`/printers/${printer.id}`)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: theme.cardAlt, border: `1px solid ${theme.border}`,
                      borderRadius: 8, padding: '8px 10px', cursor: 'pointer', textAlign: 'left',
                      flexShrink: 0,
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

      <div className="coma-bottom">
        <Card title="Fleet status" fill>
          <div className="coma-fleet-body">
            <div className="coma-fleet-cells">
              {Object.entries(grouped).flatMap(([model, group]) =>
                group.map(printer => {
                  const c = cellColors(printer);
                  const awaiting = isAwaiting(printer);
                  const statusLabel = awaiting ? 'Awaiting' : (printer.status || 'Unknown');
                  const modelLabel = MODEL_LABELS[model] || model;
                  return (
                    <button
                      key={printer.id}
                      type="button"
                      title={`${printer.name}: ${statusLabel}`}
                      onClick={() => navigate(`/printers/${printer.id}`)}
                      className="coma-fleet-cell"
                      style={{
                        background: c.bg,
                        border: `1px solid ${c.border}`,
                        color: c.text,
                      }}
                    >
                      <span style={{
                        fontSize: 11, fontWeight: 600, color: theme.textFaint,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {modelLabel}
                      </span>
                      <span style={{
                        fontSize: 15, fontWeight: 700, color: theme.text,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {printer.name}
                      </span>
                      <span style={{
                        fontSize: 12, fontWeight: 700, color: c.text,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>
                        {statusLabel}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <div style={{
              display: 'flex', gap: 16, paddingTop: 8,
              borderTop: `1px solid ${theme.border}`, flexWrap: 'wrap', flexShrink: 0,
            }}>
              {LEGEND_ITEMS.map(({ label, color }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: theme.textFaint }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Active projects" fill>
          {active_projects.length === 0 ? (
            <p style={{ color: theme.textMuted, fontSize: 13, margin: 'auto 0' }}>
              No active projects. Create one on the Projects page and set it Active to track production here.
            </p>
          ) : (
            <div className="coma-projects-body">
              {active_projects.map(proj => {
                const hasStats = (proj.elapsed_secs > 0) || (proj.material_used_grams > 0);
                return (
                  <div key={proj.id} style={{
                    background: theme.cardAlt, borderRadius: 10, padding: '12px 14px', flexShrink: 0,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{proj.name}</span>
                      <span style={{
                        background: '#065f46', color: '#34d399',
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
                                    <span style={{ color: theme.violetSoft }}> +{activeQty.toLocaleString()}</span>
                                  )}
                                  <span style={{ color: theme.textFaint }}>{' / '}{part.target_qty.toLocaleString()}</span>
                                </span>
                                <span style={{ fontSize: 12, fontWeight: 700, color: part.status === 'closed' ? theme.lime : theme.violetSoft, minWidth: 34, textAlign: 'right' }}>
                                  {pct}%
                                </span>
                                {part.status === 'closed' && (
                                  <span style={{
                                    background: '#062b22', color: '#10b981',
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
                                background: theme.limeDeep,
                                borderRadius: activePct > 0 ? '4px 0 0 4px' : 4,
                                transition: 'width 0.5s',
                              }} />
                              {activePct > 0 && (
                                <div style={{
                                  position: 'absolute', left: `${completedPct}%`, top: 0, height: '100%',
                                  width: `${activePct}%`,
                                  background: theme.violetDeep,
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
                        <span style={{ fontWeight: 700, color: '#d4d4d8' }}>So far</span>
                        {proj.elapsed_secs > 0 && (
                          <span style={{ color: theme.textMuted }}>{formatDuration(proj.elapsed_secs)}</span>
                        )}
                        {proj.material_used_grams > 0 && (
                          <span style={{ color: theme.violet }}>{formatMaterial(proj.material_used_grams)}</span>
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
