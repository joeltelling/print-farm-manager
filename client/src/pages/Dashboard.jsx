import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import PollTimer from '../components/PollTimer';

const POLL_INTERVAL_MS = 15000;

// ── Constants ────────────────────────────────────────────────────────────────

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

// Mirrors Fleet.jsx's STATUS_COLORS labelKey mapping: same canonical status codes,
// same common.status* keys, so row summaries/tooltips read the same as the Fleet page.
const STATUS_LABEL_KEYS = {
  PRINTING:   'common.statusPrinting',
  UPLOADING:  'common.statusUploading',
  IDLE:       'common.statusIdle',
  READY:      'common.statusReady',
  FINISHED:   'common.statusFinished',
  STOPPED:    'common.statusStopped',
  PAUSED:     'common.statusPaused',
  ATTENTION:  'common.statusAttention',
  ERROR:      'common.statusError',
  OFFLINE:    'common.statusOffline',
};

function statusLabel(t, status) {
  return t(STATUS_LABEL_KEYS[status] || 'common.statusUnknown');
}

const STAT_CARDS = [
  { key: 'printing',    labelKey: 'common.statusPrinting', color: '#3b82f6', accent: '#1e40af' },
  { key: 'idle',        labelKey: 'common.statusIdle',     color: '#6b7280', accent: '#374151' },
  { key: 'awaiting',    labelKey: 'dashboard.awaitingSignoff', color: '#22c55e', accent: '#15803d', helpKey: 'dashboard.awaitingSignoffHelp' },
  { key: 'parts_today', labelKey: 'dashboard.partsToday', color: '#a78bfa', accent: '#7c3aed' },
];

const LEGEND_ITEMS = [
  { labelKey: 'common.statusPrinting',   color: '#3b82f6' },
  { labelKey: 'dashboard.awaitingSignoff', color: '#22c55e' },
  { labelKey: 'common.statusIdle',       color: '#4b5563' },
  { labelKey: 'common.statusStopped',    color: '#fb923c' },
  { labelKey: 'common.statusError',      color: '#ef4444' },
  { labelKey: 'common.statusOffline',    color: '#374151' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function cellColors(printer) {
  // Held printer (awaiting operator sign-off) renders as green regardless of status.
  // Keep this condition identical to Fleet.jsx and Printers.jsx (see CLAUDE.md sync pairs).
  if (printer.is_held === 1 && (printer.status === 'FINISHED' || printer.status === 'IDLE' || printer.status === 'STOPPED')) {
    return CELL_COLORS.FINISHED;
  }
  return CELL_COLORS[printer.status] || CELL_COLORS.IDLE;
}

function formatTime(d, language) {
  return d.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatDate(d, language) {
  return d.toLocaleDateString(language, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(secs, t) {
  if (!secs) return null;
  const MINUTE = 60, HOUR = 3600, DAY = 86400, WEEK = 604800;
  if (secs >= WEEK) {
    const w = Math.floor(secs / WEEK);
    const d = Math.floor((secs % WEEK) / DAY);
    return d > 0 ? t('common.durationWeeksDays', { w, d }) : t('common.durationWeeks', { w });
  }
  if (secs >= DAY) {
    const d = Math.floor(secs / DAY);
    const h = Math.floor((secs % DAY) / HOUR);
    return h > 0 ? t('common.durationDaysHours', { d, h }) : t('common.durationDays', { d });
  }
  const h = Math.floor(secs / HOUR);
  const m = Math.floor((secs % HOUR) / MINUTE);
  if (h > 0) return m > 0 ? t('common.durationHoursMinutes', { h, m }) : t('common.durationHours', { h });
  return t('common.durationMinutes', { m });
}

function formatMaterial(grams, t) {
  if (grams == null) return null;
  if (grams < 1000) return t('common.massGrams', { g: Math.round(grams) });
  const kg = (grams / 1000).toFixed(2).replace(/\.?0+$/, '');
  return t('common.massKilograms', { kg });
}

// ── Row-level status summary badges for the fleet grid ───────────────────────

const ROW_STATUSES = ['PRINTING', 'FINISHED', 'IDLE', 'ERROR', 'STOPPED', 'OFFLINE'];

function RowSummary({ group }) {
  const { t } = useTranslation();
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
        const label = s === 'FINISHED' ? t('common.statusAwaitingShort') : statusLabel(t, s);
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
  const { t, i18n } = useTranslation();
  // resolvedLanguage (not language) so date/number formatting matches whatever language
  // is actually rendered, not a detected-but-unregistered browser locale (see i18n.js).
  const language = i18n.resolvedLanguage || i18n.language || 'en';
  const [data,  setData]  = useState(null);
  const [clock, setClock] = useState(new Date());
  const [allModels, setAllModels] = useState([]);
  const [lastPolled, setLastPolled] = useState(null);
  const dashRef = useRef(null);

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setAllModels).catch(() => {});
  }, []);

  // 1-second clock
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Data fetch — 15s poll, matches Fleet page
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
        background: '#0a0f1a', height: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#475569', fontSize: 18,
      }}>
        {t('common.loading')}
      </div>
    );
  }

  const { stats, printers, active_projects, recent_activity } = data;

  // Group printers by model for the fleet grid
  const modelOrder = allModels.map(m => m.model_id);
  const MODEL_LABELS = Object.fromEntries(allModels.map(m => [m.model_id, m.label]));
  MODEL_LABELS.other = t('common.other');
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
              {t('dashboard.brandTitle')}
            </div>
            <div style={{ fontSize: 11, color: '#475569', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 1 }}>
              {t('dashboard.commandCenter')}
            </div>
          </div>
        </div>

        {/* Center: utilization */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {t('dashboard.fleetUtilization')}
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
              {formatTime(clock, language)}
            </div>
            <div style={{ fontSize: 12, color: '#475569', marginTop: 3 }}>
              {formatDate(clock, language)}
            </div>
          </div>
          <PollTimer lastPolled={lastPolled} intervalMs={POLL_INTERVAL_MS} size={28} />
          <button
            onClick={enterTV}
            title={t('dashboard.enterTvMode')}
            style={{
              background: '#1e2433', color: '#64748b',
              border: '1px solid #2d3748', borderRadius: 6,
              padding: '6px 12px', fontSize: 12, cursor: 'pointer',
            }}
          >
            ⛶ {t('dashboard.tvMode')}
          </button>
        </div>
      </div>

      <div style={{ padding: '20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── STAT CARDS ──────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {STAT_CARDS.map(({ key, labelKey, color, accent, helpKey }) => (
            <div key={key} title={helpKey ? t(helpKey) : undefined} style={{
              background: '#1e2433', borderRadius: 8,
              padding: '16px 20px',
              display: 'flex', alignItems: 'center', gap: 18,
              borderLeft: `4px solid ${accent}`,
            }}>
              <div style={{
                fontSize: 52, fontWeight: 800, color, lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {(stats[key] ?? 0).toLocaleString(language)}
              </div>
              <div style={{
                fontSize: 11, color: '#475569',
                textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 700,
              }}>
                {t(labelKey)}
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
            {t('dashboard.fleetStatus')}
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
                    // Keep this condition identical to Fleet.jsx and Printers.jsx (see CLAUDE.md sync pairs).
                    const isAwaiting = printer.is_held === 1 && (printer.status === 'FINISHED' || printer.status === 'IDLE' || printer.status === 'STOPPED');
                    const cellStatusLabel = isAwaiting ? t('common.statusAwaitingShort') : statusLabel(t, printer.status);
                    return (
                      <div
                        key={printer.id}
                        title={`${printer.name}: ${cellStatusLabel}`}
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
            {LEGEND_ITEMS.map(({ labelKey, color }) => (
              <div key={labelKey} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: '#475569' }}>{t(labelKey)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── ACTIVE PROJECTS ─────────────────────────────────────────────── */}
        <div style={{ background: '#111827', borderRadius: 10, padding: '16px 20px' }}>
          <div style={{
            fontSize: 11, color: '#374151',
            textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700,
            marginBottom: 14,
          }}>
            {t('dashboard.activeProjects')}
          </div>

          {active_projects.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>
              {t('dashboard.noActiveProjects')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {active_projects.map(proj => {
                const hasStats = (proj.elapsed_secs > 0) || (proj.material_used_grams > 0);

                return (
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
                        {t('dashboard.activeBadge')}
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
                              <span style={{ fontSize: 12, color: '#e2e8f0', fontWeight: 500 }}>{part.name}</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                                  <span style={{ color: '#e2e8f0' }}>{part.completed_qty.toLocaleString(language)}</span>
                                  {activeQty > 0 && (
                                    <span style={{ color: '#60a5fa' }}> +{activeQty.toLocaleString(language)}</span>
                                  )}
                                  <span style={{ color: '#475569' }}>{' / '}{part.target_qty.toLocaleString(language)}</span>
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
                                    {t('dashboard.partDoneBadge')}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div style={{ position: 'relative', background: '#0f172a', borderRadius: 4, height: 9 }}>
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
                        borderTop: '1px solid #1a2030', marginTop: 10, paddingTop: 8,
                        display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, flexWrap: 'wrap',
                      }}>
                        <span style={{ fontWeight: 700, color: '#cbd5e1' }}>{t('dashboard.soFar')}</span>
                        <span style={{ color: '#374151' }}>·</span>
                        {proj.elapsed_secs > 0 && (
                          <span style={{ color: '#94a3b8' }}>{formatDuration(proj.elapsed_secs, t)}</span>
                        )}
                        {proj.elapsed_secs > 0 && proj.material_used_grams > 0 && (
                          <span style={{ color: '#374151' }}>·</span>
                        )}
                        {proj.material_used_grams > 0 && (
                          <span style={{ color: '#a78bfa' }}>{formatMaterial(proj.material_used_grams, t)}</span>
                        )}
                        {proj.model_breakdown && proj.model_breakdown.length > 1 && (
                          <>
                            <span style={{ color: '#374151' }}>·</span>
                            <span style={{ color: '#64748b' }}>
                              {proj.model_breakdown.map(m => m.printer_model).join(', ')}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


