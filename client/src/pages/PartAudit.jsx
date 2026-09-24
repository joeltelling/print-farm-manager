import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';

// Part audit trail: how a part's completed count was built up, from GET
// /api/parts/:id/audit (see server/partLedger.js). Read-only; fetches on mount and on
// the Refresh button, no background polling.

function formatTimestamp(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// The server's notes on rebuilt and baseline rows explain the pre-tracking history
// in full; the banner above the chart already says that once, so the timeline keeps
// these short instead of repeating a paragraph on every rebuilt row.
function displayNote(source, note) {
  if (source === 'rebuilt_job') return null;
  if (source === 'baseline') return 'Changes before audit tracking that were never recorded';
  return note;
}

function formatSigned(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`; // minus sign, not a dash
  return '0';
}

// One entry per ledger source, plus the two uncredited-failure kinds. `kind` drives
// the event-type filter.
const EVENT_META = {
  print_finished:   { label: 'Print finished',        bg: '#14532d', color: '#86efac', kind: 'credit' },
  operator_confirm: { label: 'Operator confirmed',    bg: '#1e3a5f', color: '#93c5fd', kind: 'credit' },
  rebuilt_job:      { label: 'Finished (pre-tracking)', bg: '#1e2433', color: '#86efac', kind: 'credit' },
  operator_adjust:  { label: 'Count corrected',       bg: '#78350f', color: '#fcd34d', kind: 'deduction' },
  marked_failed:    { label: 'Marked failed',         bg: '#7f1d1d', color: '#fca5a5', kind: 'deduction' },
  manual_edit:      { label: 'Manual edit',           bg: '#1e2a3a', color: '#7dd3fc', kind: 'manual' },
  baseline:         { label: 'Pre-tracking balance',  bg: '#1e2433', color: '#94a3b8', kind: 'manual' },
  failed:           { label: 'Failed, not credited',  bg: '#1e2433', color: '#fca5a5', kind: 'failure' },
  cancelled:        { label: 'Stopped, not credited', bg: '#1e2433', color: '#94a3b8', kind: 'failure' },
};
const EVENT_FALLBACK = { label: 'Other', bg: '#1e2433', color: '#64748b', kind: 'manual' };

const KIND_OPTIONS = [
  { value: 'all',       label: 'All events' },
  { value: 'credit',    label: 'Credits' },
  { value: 'deduction', label: 'Deductions and corrections' },
  { value: 'failure',   label: 'Failures not credited' },
  { value: 'manual',    label: 'Manual edits and pre-tracking' },
];

const PART_STATUS = {
  open:   { text: '#22c55e', label: 'Open' },
  closed: { text: '#64748b', label: 'Closed' },
};

// Chart palette, copied from the Projects page progress bar so the two read as one.
const CHART = {
  line:      '#22c55e', // completed total (Projects progress bar green)
  target:    '#f59e0b', // target (Projects target tick amber)
  deduction: '#ef4444',
  failure:   '#94a3b8',
  grid:      '#1e2433',
  axisText:  '#64748b',
  surface:   '#131720', // card background; marker rings use it
  crosshair: '#475569',
};

const TIMELINE_PAGE = 100;

const cardStyle = {
  background: '#131720', border: '1px solid #1e2433',
  borderRadius: 8, padding: '16px 20px', marginBottom: 20,
};

const sectionTitleStyle = {
  fontSize: 13, fontWeight: 600, color: '#64748b', marginBottom: 10,
  textTransform: 'uppercase', letterSpacing: '0.06em',
};

const selectStyle = {
  background: '#1e2433', border: '1px solid #2d3748', borderRadius: 5,
  color: '#e2e8f0', fontSize: 13, padding: '5px 9px', outline: 'none',
  fontFamily: 'inherit', cursor: 'pointer',
};

function EventBadge({ type }) {
  const m = EVENT_META[type] || EVENT_FALLBACK;
  return (
    <span style={{
      background: m.bg, color: m.color, borderRadius: 4, padding: '2px 9px',
      fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

function PrinterRef({ id, name, exists }) {
  if (!name) return <span style={{ color: '#475569' }}>-</span>;
  if (!exists) {
    return <span style={{ color: '#94a3b8' }} title="This printer has since been deleted">{name} <span style={{ color: '#475569' }}>(deleted)</span></span>;
  }
  return <Link to={`/printers/${id}`} style={{ color: '#93c5fd', textDecoration: 'none' }}>{name}</Link>;
}

function ChangeValue({ delta, muted }) {
  const color = muted ? '#64748b' : delta > 0 ? '#86efac' : delta < 0 ? '#fca5a5' : '#64748b';
  return <span style={{ color, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatSigned(delta)}</span>;
}

// Clean tick step for a max value: 1, 2, 5 times a power of ten.
function niceStep(max, count = 4) {
  const raw = Math.max(1, max / count);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// Width of the chart's container, tracked so the SVG draws at 1:1 pixels (no
// stretched markers or text) at any viewport width.
function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Step chart of the running completed total over time, with the target line and
// markers for deductions (red) and failures that never credited (gray ring).
function RunningTotalChart({ entries, failures, target, eventLabel }) {
  const [wrapRef, width] = useElementWidth();
  const [hover, setHover] = useState(null);

  const H = 240;
  const pad = { l: 44, r: 16, t: 14, b: 28 };

  const model = useMemo(() => {
    if (entries.length === 0) return null;
    const start = entries[0].balance_after - entries[0].delta;
    const balanceAt = (t) => {
      let b = start;
      for (const e of entries) { if (e.created_at <= t) b = e.balance_after; else break; }
      return b;
    };
    const points = [
      ...entries.map(e => ({ t: e.created_at, y: e.balance_after, entry: e })),
      ...failures.map(f => ({ t: f.created_at, y: balanceAt(f.created_at), failure: f })),
    ].sort((a, b) => a.t - b.t);

    let t0 = entries[0].created_at;
    let t1 = Math.max(Date.now(), points[points.length - 1].t);
    if (failures.length > 0) t0 = Math.min(t0, failures[0].created_at);
    if (t1 - t0 < 3600_000) t0 = t1 - 3600_000; // at least an hour of range
    const maxY = Math.max(target, ...entries.map(e => e.balance_after), 1);
    const step = niceStep(maxY);
    const yMax = Math.ceil((maxY * 1.05) / step) * step;
    return { start, points, t0, t1, yMax, step };
  }, [entries, failures, target]);

  if (!model) return null;

  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;
  const x = t => pad.l + ((t - model.t0) / (model.t1 - model.t0)) * innerW;
  const y = v => pad.t + innerH - (v / model.yMax) * innerH;

  let d = `M ${x(model.t0)} ${y(model.start)}`;
  for (const e of entries) d += ` H ${x(e.created_at)} V ${y(e.balance_after)}`;
  d += ` H ${x(model.t1)}`;
  const area = `${d} V ${y(0)} H ${x(model.t0)} Z`;

  const yTicks = [];
  for (let v = 0; v <= model.yMax; v += model.step) yTicks.push(v);
  const spanDays = (model.t1 - model.t0) / 86_400_000;
  const xTickCount = width < 480 ? 3 : 5;
  const xTicks = Array.from({ length: xTickCount }, (_, i) => model.t0 + ((model.t1 - model.t0) * i) / (xTickCount - 1));
  const xLabel = t => new Date(t).toLocaleString(undefined, spanDays < 2
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric' });

  function onPointerMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = null;
    for (const p of model.points) {
      const dist = Math.abs(x(p.t) - px);
      if (!best || dist < best.dist) best = { ...p, dist };
    }
    setHover(best);
  }

  // Tooltip sits right of the crosshair, or left of it when it would overflow.
  const TIP_W = 220;
  const tooltipLeft = hover
    ? (x(hover.t) + 12 + TIP_W <= width ? x(hover.t) + 12 : Math.max(0, x(hover.t) - 12 - TIP_W))
    : 0;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      {width > 0 && (
        <svg
          width={width} height={H}
          role="img"
          aria-label={`Running completed total over time, currently ${entries[entries.length - 1].balance_after} of ${target}`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
          style={{ display: 'block', touchAction: 'pan-y' }}
        >
          {yTicks.map(v => (
            <g key={v}>
              <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke={CHART.grid} strokeWidth={1} />
              <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill={CHART.axisText}>
                {v.toLocaleString()}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={i} x={x(t)} y={H - 8} fontSize={11} fill={CHART.axisText}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            >
              {xLabel(t)}
            </text>
          ))}

          {/* Target */}
          <line x1={pad.l} x2={width - pad.r} y1={y(target)} y2={y(target)} stroke={CHART.target} strokeWidth={1.5} />
          <text x={width - pad.r} y={y(target) - 5} textAnchor="end" fontSize={11} fill="#94a3b8">
            Target {target.toLocaleString()}
          </text>

          {/* Running total */}
          <path d={area} fill={CHART.line} fillOpacity={0.1} stroke="none" />
          <path d={d} fill="none" stroke={CHART.line} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* Failures that never credited: hollow ring on the line */}
          {model.points.filter(p => p.failure).map(p => (
            <circle key={`f${p.failure.job_id}`} cx={x(p.t)} cy={y(p.y)} r={4}
              fill={CHART.surface} stroke={CHART.failure} strokeWidth={2} />
          ))}
          {/* Deductions: filled red dot with a surface ring */}
          {model.points.filter(p => p.entry && p.entry.delta < 0).map(p => (
            <circle key={`d${p.entry.id}`} cx={x(p.t)} cy={y(p.y)} r={5}
              fill={CHART.deduction} stroke={CHART.surface} strokeWidth={2} />
          ))}

          {/* Current value at the right end */}
          <circle cx={x(model.t1)} cy={y(entries[entries.length - 1].balance_after)} r={4}
            fill={CHART.line} stroke={CHART.surface} strokeWidth={2} />

          {hover && (
            <g pointerEvents="none">
              <line x1={x(hover.t)} x2={x(hover.t)} y1={pad.t} y2={pad.t + innerH} stroke={CHART.crosshair} strokeWidth={1} />
              <circle cx={x(hover.t)} cy={y(hover.y)} r={5}
                fill={hover.failure ? CHART.surface : hover.entry.delta < 0 ? CHART.deduction : CHART.line}
                stroke={hover.failure ? CHART.failure : CHART.surface} strokeWidth={2} />
            </g>
          )}
        </svg>
      )}

      {hover && (
        <div style={{
          position: 'absolute', top: 8,
          left: tooltipLeft, width: TIP_W, pointerEvents: 'none',
          background: '#0a0f1a', border: '1px solid #2d3748', borderRadius: 6,
          padding: '8px 10px', fontSize: 12, color: '#cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          <div style={{ color: '#64748b', marginBottom: 4 }}>{formatTimestamp(hover.t)}</div>
          <div style={{ marginBottom: 4 }}>
            <EventBadge type={hover.failure ? hover.failure.status : hover.entry.source} />
          </div>
          {(hover.failure?.printer_name || hover.entry?.printer_name) && (
            <div>{hover.failure?.printer_name || hover.entry.printer_name}
              {(hover.failure?.job_id || hover.entry?.job_id) ? ` · job #${hover.failure?.job_id || hover.entry.job_id}` : ''}</div>
          )}
          <div style={{ marginTop: 4 }}>
            {hover.failure
              ? <span style={{ color: '#94a3b8' }}>No change (plate of {hover.failure.parts_per_plate})</span>
              : <><ChangeValue delta={hover.entry.delta} /> <span style={{ color: '#94a3b8' }}>to {hover.entry.balance_after.toLocaleString()} total</span></>}
          </div>
        </div>
      )}

      {/* Key: the line is named by the card title; only the markers need one. */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 12, color: '#94a3b8' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 16, height: 2, background: CHART.target }} /> Target
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: CHART.deduction }} /> {eventLabel.deduction}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', border: `2px solid ${CHART.failure}` }} /> {eventLabel.failure}
        </span>
      </div>
    </div>
  );
}

export default function PartAudit() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [audit, setAudit]         = useState(null);
  const [loading, setLoading]     = useState(true);
  const [notFound, setNotFound]   = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [printerFilter, setPrinterFilter] = useState('all');
  const [kindFilter, setKindFilter]       = useState('all');
  const [newestFirst, setNewestFirst]     = useState(true);
  const [shown, setShown]                 = useState(TIMELINE_PAGE);

  const fetchAudit = useCallback(async () => {
    try {
      const res = await fetch(`/api/parts/${id}/audit`);
      if (res.status === 404) { setNotFound(true); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLoadError(body.error || `Request failed (${res.status})`);
        return;
      }
      setAudit(await res.json());
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchAudit(); }, [fetchAudit]);

  async function refresh() {
    setRefreshing(true);
    await fetchAudit();
    setRefreshing(false);
  }

  // Ledger entries and uncredited failures merged into one list for the timeline.
  const rows = useMemo(() => {
    if (!audit) return [];
    const start = audit.entries.length ? audit.entries[0].balance_after - audit.entries[0].delta : 0;
    const balanceAt = (t) => {
      let b = start;
      for (const e of audit.entries) { if (e.created_at <= t) b = e.balance_after; else break; }
      return b;
    };
    const merged = [
      ...audit.entries.map(e => ({
        key: `e${e.id}`, type: e.source, t: e.created_at, delta: e.delta, total: e.balance_after,
        printer_id: e.printer_id, printer_name: e.printer_current_name ?? e.printer_name, printer_exists: e.printer_exists,
        job_id: e.job_id, gcode: e.gcode_filename, parts_per_plate: e.parts_per_plate,
        note: displayNote(e.source, e.note), failure: false,
      })),
      ...audit.uncredited_failures.map(f => ({
        key: `f${f.job_id}`, type: f.status, t: f.created_at, delta: 0, total: balanceAt(f.created_at),
        printer_id: f.printer_id, printer_name: f.printer_name, printer_exists: f.printer_exists,
        job_id: f.job_id, gcode: f.gcode_filename, parts_per_plate: f.parts_per_plate,
        note: `Plate of ${f.parts_per_plate} ${f.status === 'cancelled' ? 'stopped' : 'failed'} before it was credited`,
        failure: true,
      })),
    ];
    merged.sort((a, b) => a.t - b.t || a.key.localeCompare(b.key));
    return merged;
  }, [audit]);

  const filteredRows = useMemo(() => {
    const out = rows.filter(r => {
      if (printerFilter !== 'all') {
        if (printerFilter === 'none' ? r.printer_id != null : String(r.printer_id) !== printerFilter) return false;
      }
      if (kindFilter !== 'all' && (EVENT_META[r.type] || EVENT_FALLBACK).kind !== kindFilter) return false;
      return true;
    });
    return newestFirst ? out.reverse() : out;
  }, [rows, printerFilter, kindFilter, newestFirst]);

  useEffect(() => { setShown(TIMELINE_PAGE); }, [printerFilter, kindFilter, newestFirst]);

  if (loading) return <p style={{ color: '#64748b' }}>Loading…</p>;
  if (notFound) {
    return (
      <div>
        <button onClick={() => navigate('/projects')} style={backButtonStyle}>← Projects</button>
        <p style={{ color: '#fca5a5' }}>Part not found. It may have been deleted.</p>
      </div>
    );
  }
  if (!audit) {
    return (
      <div>
        <button onClick={() => navigate('/projects')} style={backButtonStyle}>← Projects</button>
        <p style={{ color: '#fca5a5' }}>Could not load the audit trail: {loadError}</p>
        <button onClick={refresh} style={secondaryButtonStyle}>Try again</button>
      </div>
    );
  }

  const { part, project, printers, reconciliation } = audit;
  const partSt = PART_STATUS[part.status] || PART_STATUS.open;
  const pct = part.target_qty > 0 ? Math.round((part.completed_qty / part.target_qty) * 100) : 0;
  const barPct = Math.min(100, pct);
  const totals = printers.reduce((acc, p) => ({
    plates: acc.plates + p.plates,
    added: acc.added + p.added,
    removed: acc.removed + p.removed,
    failed: acc.failed + p.failed_plates,
  }), { plates: 0, added: 0, removed: 0, failed: 0 });
  const printerCount = printers.filter(p => p.printer_id != null).length;
  const hasPreTracking = audit.entries.some(e => e.source === 'baseline' || e.source === 'rebuilt_job');
  const maxNet = Math.max(1, ...printers.map(p => Math.abs(p.net)));
  const visibleRows = filteredRows.slice(0, shown);

  return (
    <div style={{ maxWidth: 1200 }}>
      <style>{`
        .audit-cards { display: none; }
        @media (max-width: 600px) {
          .audit-table-wrap { display: none; }
          .audit-cards { display: flex; flex-direction: column; gap: 8px; }
          .audit-filters > * { flex: 1 1 100%; }
          .audit-hide-sm { display: none; }
        }
      `}</style>

      <button
        onClick={() => navigate('/projects', { state: { openProjectId: part.project_id } })}
        style={backButtonStyle}
      >
        ← {project ? project.name : 'Projects'}
      </button>

      {/* Header */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
          <span style={{ fontWeight: 800, fontSize: 20, color: '#e2e8f0' }}>{part.name}</span>
          <span style={{ color: partSt.text, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: partSt.text }} />
            {partSt.label}
          </span>
          <button onClick={refresh} disabled={refreshing} style={{ ...secondaryButtonStyle, marginLeft: 'auto' }}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div style={{ fontSize: 13, color: '#64748b', marginBottom: 14 }}>
          Audit trail{project ? ` · ${project.name}` : ''}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 32, fontWeight: 800, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
            {part.completed_qty.toLocaleString()}
          </span>
          <span style={{ fontSize: 16, color: '#64748b' }}>of {part.target_qty.toLocaleString()} printed</span>
          <span style={{ fontSize: 13, color: '#94a3b8', marginLeft: 'auto' }}>{pct}%</span>
        </div>
        <div style={{ background: '#0f172a', borderRadius: 4, height: 8, marginBottom: 16 }}>
          <div style={{ width: `${barPct}%`, height: '100%', background: '#22c55e', borderRadius: 3 }} />
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {[
            { label: 'Plates credited', value: totals.plates },
            { label: 'Parts added',     value: totals.added },
            { label: 'Parts removed',   value: totals.removed },
            { label: 'Failed plates',   value: totals.failed },
            { label: 'Printers',        value: printerCount },
          ].map(({ label, value }) => (
            <div key={label} style={{ flex: '1 1 110px', padding: '4px 16px 4px 0', minWidth: 100 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#e2e8f0', lineHeight: 1.2 }}>{value.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: '#475569', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {!reconciliation.matches && (
        <div style={{
          background: '#78350f', border: '1px solid #92400e', color: '#fcd34d',
          borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 13,
        }}>
          The audit trail adds up to {reconciliation.ledger_sum.toLocaleString()}, but the part's completed count is {reconciliation.completed_qty.toLocaleString()}.
          Something changed the count without recording it. Please report this; the count itself has not been changed.
        </div>
      )}

      {hasPreTracking && (
        <div style={{
          background: '#131720', border: '1px solid #1e2433', color: '#94a3b8',
          borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 13,
        }}>
          History from before audit tracking was rebuilt from job records. Operator count corrections and manual edits from that period were never recorded, so any difference is shown as one pre-tracking balance entry.
        </div>
      )}

      {audit.entries.length === 0 && audit.uncredited_failures.length === 0 ? (
        <div style={cardStyle}>
          <p style={{ color: '#475569', fontSize: 14, margin: 0 }}>
            Nothing printed yet. Entries appear here as prints finish, operators confirm or correct counts, or failures are recorded.
          </p>
        </div>
      ) : (
        <>
          {/* Chart */}
          {audit.entries.length > 0 && (
            <div style={cardStyle}>
              <div style={sectionTitleStyle}>Completed total over time</div>
              <RunningTotalChart
                entries={audit.entries}
                failures={audit.uncredited_failures}
                target={part.target_qty}
                eventLabel={{ deduction: 'Deduction or correction', failure: 'Failed, not credited' }}
              />
            </div>
          )}

          {/* By printer */}
          <div style={cardStyle}>
            <div style={sectionTitleStyle}>By printer</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: '#475569', textAlign: 'left', borderBottom: '1px solid #1e2433' }}>
                    {['Printer', 'Plates', 'Added', 'Removed', 'Failed plates', 'Net'].map(h => (
                      <th
                        key={h}
                        className={h === 'Added' || h === 'Removed' ? 'audit-hide-sm' : undefined}
                        style={{ padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap', textAlign: h === 'Printer' || h === 'Net' ? 'left' : 'right' }}
                      >
                        {h === 'Failed plates' ? 'Failed' : h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {printers.map(p => (
                    <tr key={p.printer_id ?? 'none'} style={{ borderBottom: '1px solid #1a1f2e' }}>
                      <td style={{ padding: '7px 10px' }}>
                        {p.printer_id == null
                          ? <span style={{ color: '#94a3b8' }}>No printer <span style={{ color: '#475569' }}>(manual edits, pre-tracking)</span></span>
                          : <PrinterRef id={p.printer_id} name={p.printer_name} exists={p.printer_exists} />}
                      </td>
                      <td style={numCell}>{p.plates}</td>
                      <td className="audit-hide-sm" style={{ ...numCell, color: p.added ? '#86efac' : '#475569' }}>{p.added ? `+${p.added}` : '0'}</td>
                      <td className="audit-hide-sm" style={{ ...numCell, color: p.removed ? '#fca5a5' : '#475569' }}>{p.removed ? `−${p.removed}` : '0'}</td>
                      <td style={{ ...numCell, color: p.failed_plates ? '#fca5a5' : '#475569' }}>{p.failed_plates}</td>
                      <td style={{ padding: '7px 10px', minWidth: 110 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 36, textAlign: 'right', fontWeight: 700, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>{p.net}</span>
                          <div style={{ flex: 1, background: '#0f172a', borderRadius: 3, height: 6, minWidth: 40 }}>
                            <div style={{
                              width: `${(Math.max(0, p.net) / maxNet) * 100}%`, height: '100%',
                              background: p.printer_id == null ? '#475569' : '#22c55e', borderRadius: 3,
                            }} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Timeline */}
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ ...sectionTitleStyle, marginBottom: 0 }}>Timeline ({filteredRows.length.toLocaleString()})</div>
              <div className="audit-filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
                <select value={printerFilter} onChange={e => setPrinterFilter(e.target.value)} style={selectStyle} aria-label="Filter by printer">
                  <option value="all">All printers</option>
                  {printers.map(p => p.printer_id == null
                    ? <option key="none" value="none">No printer</option>
                    : <option key={p.printer_id} value={String(p.printer_id)}>{p.printer_name}</option>)}
                </select>
                <select value={kindFilter} onChange={e => setKindFilter(e.target.value)} style={selectStyle} aria-label="Filter by event type">
                  {KIND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button onClick={() => setNewestFirst(v => !v)} style={secondaryButtonStyle}>
                  {newestFirst ? 'Newest first' : 'Oldest first'}
                </button>
              </div>
            </div>

            {filteredRows.length === 0 && (
              <p style={{ color: '#475569', fontSize: 14, margin: 0 }}>No events match these filters.</p>
            )}

            {filteredRows.length > 0 && (
              <div className="audit-table-wrap" style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ color: '#475569', textAlign: 'left', borderBottom: '1px solid #1e2433' }}>
                      {['Time', 'Event', 'Printer', 'Job', 'G-code', 'Change', 'Total', 'Note'].map(h => (
                        <th key={h} style={{ padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap', textAlign: h === 'Change' || h === 'Total' ? 'right' : 'left' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(r => (
                      <tr key={r.key} style={{ borderBottom: '1px solid #1a1f2e', opacity: r.failure ? 0.8 : 1 }}>
                        <td style={{ padding: '7px 10px', color: '#64748b', whiteSpace: 'nowrap' }}>{formatTimestamp(r.t)}</td>
                        <td style={{ padding: '7px 10px' }}><EventBadge type={r.type} /></td>
                        <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                          <PrinterRef id={r.printer_id} name={r.printer_name} exists={r.printer_exists} />
                        </td>
                        <td style={{ padding: '7px 10px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{r.job_id ? `#${r.job_id}` : '-'}</td>
                        <td style={{ padding: '7px 10px', color: '#64748b', fontFamily: 'monospace', fontSize: 11, maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.gcode || ''}>
                          {r.gcode ?? '-'}
                        </td>
                        <td style={{ ...numCell }}><ChangeValue delta={r.delta} muted={r.failure} /></td>
                        <td style={{ ...numCell, color: r.failure ? '#475569' : '#e2e8f0', fontWeight: 600 }}>{r.total.toLocaleString()}</td>
                        <td style={{ padding: '7px 10px', color: '#94a3b8', fontSize: 12, minWidth: 200 }}>{r.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {filteredRows.length > 0 && (
              <div className="audit-cards">
                {visibleRows.map(r => (
                  <div key={r.key} style={{
                    background: '#0f1420', border: '1px solid #1e2433', borderRadius: 7,
                    padding: '10px 12px', opacity: r.failure ? 0.8 : 1,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <EventBadge type={r.type} />
                      <span style={{ marginLeft: 'auto', fontSize: 14 }}><ChangeValue delta={r.delta} muted={r.failure} /></span>
                      <span style={{ color: '#64748b', fontSize: 12 }}>→ {r.total.toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {r.printer_name && <PrinterRef id={r.printer_id} name={r.printer_name} exists={r.printer_exists} />}
                      {r.job_id && <span>job #{r.job_id}</span>}
                      {r.gcode && <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b', wordBreak: 'break-all' }}>{r.gcode}</span>}
                    </div>
                    {r.note && <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>{r.note}</div>}
                    <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>{formatTimestamp(r.t)}</div>
                  </div>
                ))}
              </div>
            )}

            {filteredRows.length > shown && (
              <div style={{ textAlign: 'center', marginTop: 12 }}>
                <button onClick={() => setShown(s => s + TIMELINE_PAGE)} style={secondaryButtonStyle}>
                  Show {Math.min(TIMELINE_PAGE, filteredRows.length - shown)} more of {(filteredRows.length - shown).toLocaleString()}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const backButtonStyle = {
  background: 'none', border: 'none', color: '#3b82f6',
  fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 18,
};

const secondaryButtonStyle = {
  background: '#1e2433', color: '#94a3b8', border: '1px solid #2d3748',
  borderRadius: 5, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

const numCell = {
  padding: '7px 10px', textAlign: 'right', color: '#94a3b8',
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
};
