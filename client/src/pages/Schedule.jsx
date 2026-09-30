import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useToast } from '../useToast';
import EmptyState from '../components/EmptyState';
import { SCHEDULE_DIRTY_EVENT } from '../scheduleDirty';

// Forward-looking companion to the Jobs page: Jobs is what already happened, this is what
// the farm is expected to do next. One column per printer, an Outlook-style time axis down
// the left, and a job drawn as a block whose height is the anticipated print time.
//
// Freshness model (deliberately not the 15 s-poll-and-hope pattern used elsewhere):
// the server fingerprints the schedule's inputs, so this page can tell the difference
// between "my copy is current" and "my copy is stale". A cheap version poll, plus a
// same-tab dirty event fired when an estimate is edited on the Projects page, flips the
// page into an explicit recalculating state instead of leaving old blocks on screen looking
// authoritative. The full schedule is also refetched on the usual cadence, because live
// printer time-remaining moves the leading edge of an in-progress block without changing
// the fingerprint.

const SCHEDULE_POLL_MS = 15000; // full projection, matches the rest of the app
const VERSION_POLL_MS  = 5000;  // cheap staleness check
const CLOCK_TICK_MS    = 10000; // moves the "now" line between refreshes

const ZOOM_OPTIONS = [
  { label: 'Compact',  pxPerHour: 36 },
  { label: 'Normal',   pxPerHour: 64 },
  { label: 'Detailed', pxPerHour: 120 },
];

const HORIZON_OPTIONS = [6, 12, 24, 48, 72];

// Per-project block colors. Copied from the palette already used across the app (action
// blue #2563eb first, so the highest-priority project reads as the primary one) and
// extended with hues that stay legible on the #0a0f1a page background.
const PROJECT_COLORS = [
  '#2563eb', '#7c3aed', '#0891b2', '#059669',
  '#d97706', '#db2777', '#4f46e5', '#65a30d',
];
const FALLBACK_COLOR = '#475569';

const GUTTER_PX = 62;
const MIN_LANE_PX = 132;
const HOUR_MS = 3600 * 1000;

const selectSx = {
  background: '#1e2433',
  border: '1px solid #2d3748',
  borderRadius: 4,
  padding: '5px 10px',
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
};

function startOfHour(ms) {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatHourLabel(ms) {
  const d = new Date(ms);
  // Only mark the date when a day boundary is crossed, so a 3-day horizon stays readable.
  if (d.getHours() === 0) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleTimeString([], { hour: 'numeric' });
}

function formatDuration(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// Contiguous stretches of the view when nobody is on site to swap a plate. Drawn as shaded
// bands so the overnight gaps in the schedule explain themselves.
function closedBands(viewStart, viewEnd, startHour, endHour) {
  const bands = [];
  let cursor = startOfHour(viewStart);
  let open = null;
  while (cursor < viewEnd) {
    const hour = new Date(cursor).getHours();
    const isClosed = hour < startHour || hour >= endHour;
    if (isClosed && open === null) open = cursor;
    if (!isClosed && open !== null) { bands.push([open, cursor]); open = null; }
    cursor += HOUR_MS;
  }
  if (open !== null) bands.push([open, viewEnd]);
  return bands.map(([from, to]) => [Math.max(from, viewStart), Math.min(to, viewEnd)]);
}

export default function Schedule() {
  const [showToast, toastEl] = useToast();

  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [dirty, setDirty]         = useState(false);
  const [fetching, setFetching]   = useState(false);

  const [horizonHours, setHorizonHours] = useState(24);
  const [pxPerHour, setPxPerHour]       = useState(64);

  // The server's clock, not the browser's: block times come from the server, so the "now"
  // line has to be measured against the same clock or it drifts against the blocks.
  const [clockOffset, setClockOffset] = useState(0);
  const [, setTick] = useState(0);

  // Read in callbacks that must not change identity when a payload arrives, so the polling
  // effects below are not torn down and rebuilt on every refresh.
  const versionRef = useRef(null);
  const hasDataRef = useRef(false);

  const fetchSchedule = useCallback(async ({ surfaceErrors = false } = {}) => {
    setFetching(true);
    try {
      const res = await fetch(`/api/schedule?horizon_hours=${horizonHours}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const payload = await res.json();
      versionRef.current = payload.version;
      hasDataRef.current = true;
      setData(payload);
      setClockOffset(payload.now - Date.now());
      setDirty(false);
      setLoadError(null);
    } catch (err) {
      // Background refreshes keep the last good schedule on screen rather than blanking
      // it; only an action the operator took reports through the toast channel.
      if (surfaceErrors) showToast('Could not load schedule: ' + err.message, 'error');
      if (!hasDataRef.current) setLoadError(err.message);
    } finally {
      setFetching(false);
      setLoading(false);
    }
  }, [horizonHours, showToast]);

  // Full refresh: on mount, whenever the horizon changes, and on the normal cadence. The
  // timer matters even with the version check below, because live printer time-remaining
  // moves the leading edge of an in-progress block without changing the fingerprint.
  useEffect(() => {
    fetchSchedule();
    const interval = setInterval(() => fetchSchedule(), SCHEDULE_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchSchedule]);

  // Staleness check. Cheap enough to run often, and it is what turns an edit made
  // elsewhere into a visible recalculating state here.
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/schedule/version');
        if (!res.ok) return;
        const { version } = await res.json();
        if (versionRef.current && version !== versionRef.current) {
          setDirty(true);
          fetchSchedule();
        }
      } catch (_) {
        // A failed staleness check is not worth reporting: the next full refresh covers it.
      }
    };
    const interval = setInterval(check, VERSION_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchSchedule]);

  // Same-tab signal from the Projects page: an estimate was just edited, so this schedule
  // is known-stale right now without waiting for the version poll to notice.
  useEffect(() => {
    const onDirty = () => { setDirty(true); fetchSchedule(); };
    window.addEventListener(SCHEDULE_DIRTY_EVENT, onDirty);
    return () => window.removeEventListener(SCHEDULE_DIRTY_EVENT, onDirty);
  }, [fetchSchedule]);

  // Keeps the "now" line moving between data refreshes.
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), CLOCK_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const colorForProject = useMemo(() => {
    const map = new Map();
    for (const p of data?.projects || []) {
      map.set(p.id, PROJECT_COLORS[p.color_index % PROJECT_COLORS.length]);
    }
    return (projectId) => map.get(projectId) || FALLBACK_COLOR;
  }, [data]);

  const view = useMemo(() => {
    if (!data) return null;
    // Start at the top of the current hour so the now line is not pinned to the very edge.
    const viewStart = startOfHour(data.now);
    const viewEnd   = data.horizon_end;
    const hours = [];
    for (let t = viewStart; t <= viewEnd; t += HOUR_MS) hours.push(t);
    return {
      viewStart,
      viewEnd,
      hours,
      bands: closedBands(viewStart, viewEnd,
        data.assumptions.staffed_start_hour, data.assumptions.staffed_end_hour),
      blocksByPrinter: (data.blocks || []).reduce((acc, b) => {
        (acc[b.printer_id] = acc[b.printer_id] || []).push(b);
        return acc;
      }, {}),
    };
  }, [data]);

  if (loading) {
    return <div><h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Schedule</h1>
      <p style={{ color: '#64748b' }}>Loading…</p></div>;
  }

  if (!data && loadError) {
    return (
      <div>
        {toastEl}
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Schedule</h1>
        <div style={{
          background: '#1a1f2e', border: '1px solid #7f1d1d', borderRadius: 8,
          padding: '12px 16px', color: '#f87171', fontSize: 13,
        }}>
          Could not load the schedule: {loadError}
          <button
            onClick={() => fetchSchedule({ surfaceErrors: true })}
            style={{
              marginLeft: 12, background: '#1d4ed8', color: '#fff', border: 'none',
              borderRadius: 4, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >Retry</button>
        </div>
      </div>
    );
  }

  const pxPerMs  = pxPerHour / HOUR_MS;
  const yFor     = (ms) => (ms - view.viewStart) * pxPerMs;
  const bodyPx   = Math.max(120, (view.viewEnd - view.viewStart) * pxPerMs);
  const nowMs    = Date.now() + clockOffset;
  const nowY     = yFor(nowMs);
  const laneWidth = `minmax(${MIN_LANE_PX}px, 1fr)`;

  const { assumptions, printers, unscheduled, truncated } = data;
  const projectedCount = data.blocks.filter(b => b.kind === 'projected').length;

  return (
    <div>
      {toastEl}

      <style>{`
        .sched-scroll { overflow: auto; border: 1px solid #1e2433; border-radius: 8px; max-height: calc(100vh - 260px); background: #0a0f1a; }
        .sched-grid { display: grid; }
        .sched-head-cell { position: sticky; top: 0; z-index: 3; background: #131720; border-bottom: 1px solid #2d3748; border-left: 1px solid #1e2433; padding: 6px 8px; }
        /* Declared after .sched-head-cell so the corner's higher z-index wins: both are
           sticky, and the corner has to stay above the printer headings when the grid is
           scrolled sideways. */
        .sched-corner { position: sticky; left: 0; top: 0; z-index: 4; background: #131720; border-bottom: 1px solid #2d3748; border-left: none; }
        .sched-gutter { position: sticky; left: 0; z-index: 2; background: #0a0f1a; border-right: 1px solid #2d3748; }
        .sched-lane { position: relative; border-left: 1px solid #1e2433; }
        .sched-block { position: absolute; left: 3px; right: 3px; border-radius: 4px; overflow: hidden; padding: 2px 5px; cursor: default; }
        @media (max-width: 600px) {
          .sched-scroll { max-height: calc(100vh - 300px); }
          .sched-legend { font-size: 10.5px; }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Schedule</h1>
        {(dirty || fetching) && (
          <span
            title={dirty
              ? 'The farm changed, so this schedule is being recalculated'
              : 'Refreshing the schedule'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: dirty ? '#3b2c69' : '#1e2433',
              color: dirty ? '#a78bfa' : '#64748b',
              border: `1px solid ${dirty ? '#4c1d95' : '#2d3748'}`,
              borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: dirty ? '#a78bfa' : '#475569',
              animation: 'schedPulse 1s ease-in-out infinite',
            }} />
            {dirty ? 'Recalculating schedule…' : 'Refreshing…'}
          </span>
        )}
        <style>{`@keyframes schedPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }`}</style>
      </div>

      <p style={{ color: '#64748b', fontSize: 12.5, margin: '0 0 14px', maxWidth: 760, lineHeight: 1.6 }}>
        A projection, not a commitment: it replays the scheduler's own priority rules forward
        from what each printer is doing now. It assumes a {formatDuration(assumptions.changeover_secs)} changeover
        to swap the plate and sign off, and that a print finishing outside staffed hours
        ({assumptions.staffed_start_hour}:00 to {assumptions.staffed_end_hour}:00) waits until the next morning.
      </p>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <select
          value={horizonHours}
          onChange={(e) => setHorizonHours(Number(e.target.value))}
          title="How far ahead to project"
          style={selectSx}
        >
          {HORIZON_OPTIONS.map(h => (
            <option key={h} value={h}>{h < 48 ? `Next ${h} hours` : `Next ${h / 24} days`}</option>
          ))}
        </select>

        <select
          value={pxPerHour}
          onChange={(e) => setPxPerHour(Number(e.target.value))}
          title="Row height per hour"
          style={selectSx}
        >
          {ZOOM_OPTIONS.map(z => <option key={z.pxPerHour} value={z.pxPerHour}>{z.label}</option>)}
        </select>

        <span style={{ color: '#475569', fontSize: 13 }}>
          {printers.length} printer{printers.length !== 1 ? 's' : ''} · {projectedCount} projected plate{projectedCount !== 1 ? 's' : ''}
        </span>

        {/* Legend */}
        <div className="sched-legend" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginLeft: 'auto', fontSize: 11.5, color: '#64748b' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: '#2563eb', border: '1px solid #60a5fa' }} />
            In progress
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: 'rgba(37,99,235,0.22)', border: '1px dashed #2563eb' }} />
            Projected
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: '#1f2937', border: '1px solid #2d3748' }} />
            Off hours
          </span>
          <span title="No print time is known for this plate, so it is drawn at the two-hour default">
            <span style={{ color: '#fbbf24', fontWeight: 700 }}>?</span> time unknown
          </span>
        </div>
      </div>

      {printers.length === 0 ? (
        <EmptyState
          title="No active printers"
          hint="The schedule projects work onto active printers. Add a printer, or recommission one, and its column will appear here."
          actionLabel="Go to Printers"
          actionTo="/printers"
        />
      ) : (
        <div className="sched-scroll">
          <div
            className="sched-grid"
            style={{ gridTemplateColumns: `${GUTTER_PX}px repeat(${printers.length}, ${laneWidth})` }}
          >
            {/* Header row */}
            <div className="sched-corner sched-head-cell" style={{ padding: '6px 6px' }}>
              <div style={{ fontSize: 10, color: '#475569', fontWeight: 700, letterSpacing: 0.5 }}>TIME</div>
            </div>
            {printers.map(p => {
              const awaiting = p.blocked_reason === 'Awaiting operator sign-off';
              return (
                <div key={p.id} className="sched-head-cell">
                  <div style={{
                    fontSize: 12.5, fontWeight: 700, color: '#e2e8f0',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }} title={p.name}>
                    {p.name}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                    <span style={{
                      fontFamily: 'monospace', fontSize: 10, color: '#64748b',
                      background: '#0f172a', border: '1px solid #2d3748', borderRadius: 3, padding: '0 4px',
                    }}>{p.model}</span>
                    {p.blocked_reason && (
                      <span
                        title={p.blocked_reason}
                        style={{
                          fontSize: 10, fontWeight: 700, borderRadius: 3, padding: '0 4px',
                          background: awaiting ? '#14532d' : '#7f1d1d',
                          color: awaiting ? '#4ade80' : '#f87171',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90,
                        }}
                      >
                        {awaiting ? 'sign-off' : p.status.toLowerCase()}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Time gutter */}
            <div className="sched-gutter" style={{ height: bodyPx, position: 'relative' }}>
              {view.hours.map(t => (
                <div
                  key={t}
                  style={{
                    position: 'absolute', top: yFor(t), left: 0, right: 4,
                    transform: 'translateY(-1px)',
                    textAlign: 'right', fontSize: 10.5,
                    color: new Date(t).getHours() === 0 ? '#94a3b8' : '#475569',
                    fontWeight: new Date(t).getHours() === 0 ? 700 : 400,
                    lineHeight: 1,
                  }}
                >
                  {formatHourLabel(t)}
                </div>
              ))}
            </div>

            {/* Printer lanes */}
            {printers.map(p => {
              const blocks = view.blocksByPrinter[p.id] || [];
              return (
                <div
                  key={p.id}
                  className="sched-lane"
                  style={{
                    height: bodyPx,
                    backgroundImage: `repeating-linear-gradient(to bottom, #1e2433 0px, #1e2433 1px, transparent 1px, transparent ${pxPerHour}px)`,
                  }}
                >
                  {/* Off-hours shading, drawn per lane so it sits under that lane's blocks */}
                  {view.bands.map(([from, to]) => (
                    <div
                      key={from}
                      style={{
                        position: 'absolute', left: 0, right: 0,
                        top: yFor(from), height: Math.max(0, yFor(to) - yFor(from)),
                        background: 'rgba(15,23,42,0.72)', pointerEvents: 'none',
                      }}
                    />
                  ))}

                  {/* Unavailable printers get an explicit hatch rather than an empty column,
                      so "nothing scheduled" is never confused with "nothing known". */}
                  {p.available_at === null && (
                    <div
                      title={p.blocked_reason || 'Not available for dispatch'}
                      style={{
                        position: 'absolute', inset: 0,
                        background: 'repeating-linear-gradient(45deg, rgba(127,29,29,0.16) 0px, rgba(127,29,29,0.16) 6px, transparent 6px, transparent 12px)',
                      }}
                    />
                  )}

                  {blocks.map(b => {
                    const color   = colorForProject(b.project_id);
                    const active  = b.kind === 'active';
                    // An in-progress print usually started before the top of the current
                    // hour, so clip the block to the visible window instead of letting it
                    // run up behind the sticky header.
                    const clipped = yFor(b.start) < 0;
                    const top     = Math.max(0, yFor(b.start));
                    const height  = Math.max(16, yFor(b.end) - top);
                    const roomy   = height >= 34;
                    const tooltip = [
                      `${b.part_name} (${b.project_name})`,
                      `${formatClock(b.start)} to ${formatClock(b.end)} (${formatDuration(b.est_secs)})`,
                      `${b.parts_per_plate} part${b.parts_per_plate !== 1 ? 's' : ''} per plate`,
                      active ? `In progress (job #${b.job_id}, ${b.job_status})` : 'Projected',
                      b.time_unknown
                        ? 'Print time unknown: drawn at the 2 h default. Add an estimate on the part, or upload a sliced file.'
                        : `Print time from ${b.time_source === 'gcode' ? 'the sliced G-code' : 'the part estimate'}`,
                    ].join('\n');

                    return (
                      <div
                        key={b.id}
                        className="sched-block"
                        title={tooltip}
                        style={{
                          top,
                          height,
                          background: active ? color : `${color}38`,
                          border: active ? `1px solid ${color}` : `1px dashed ${color}`,
                          borderLeft: `3px solid ${color}`,
                          // A clipped block has no real top edge: squaring the corners says
                          // "this started earlier" rather than implying it began here.
                          borderTop: clipped ? 'none' : undefined,
                          borderTopLeftRadius: clipped ? 0 : undefined,
                          borderTopRightRadius: clipped ? 0 : undefined,
                          color: active ? '#fff' : '#cbd5e1',
                        }}
                      >
                        <div style={{
                          fontSize: 11, fontWeight: 700, lineHeight: 1.25,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {b.time_unknown && <span style={{ color: '#fbbf24' }}>? </span>}
                          {clipped && <span style={{ opacity: 0.7 }}>↑ </span>}
                          {b.part_name}
                        </div>
                        {roomy && (
                          <div style={{
                            fontSize: 10, opacity: 0.85, lineHeight: 1.3,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>
                            {formatDuration(b.est_secs)} · {b.parts_per_plate}x
                            {active ? ' · printing' : ''}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {/* "Now" line, spanning the lanes. Rendered last so it draws over the blocks. */}
            {nowY >= 0 && nowY <= bodyPx && (
              <div style={{
                gridColumn: `2 / span ${printers.length}`,
                gridRow: 2, height: 0, position: 'relative', zIndex: 2, pointerEvents: 'none',
              }}>
                <div style={{ position: 'absolute', top: nowY, left: 0, right: 0, height: 2, background: '#ef4444' }} />
                <div style={{
                  position: 'absolute', top: nowY - 7, left: 0,
                  background: '#ef4444', color: '#fff', fontSize: 9.5, fontWeight: 700,
                  borderRadius: 2, padding: '1px 4px', lineHeight: 1.3,
                }}>
                  {formatClock(nowMs)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Demand the projection could not place */}
      {unscheduled.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h2 style={{
            fontSize: 13, fontWeight: 700, color: '#94a3b8',
            textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8,
          }}>
            Not scheduled {truncated ? 'within this horizon' : ''}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {unscheduled.map(u => (
              <div
                key={u.part_id}
                style={{
                  background: '#131720', border: '1px solid #1e2433', borderRadius: 6,
                  padding: '8px 12px', fontSize: 12.5, color: '#cbd5e1',
                  display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
                }}
              >
                <span style={{ fontWeight: 600 }}>{u.part_name}</span>
                <span style={{ color: '#64748b' }}>{u.project_name}</span>
                <span style={{
                  background: '#1e3a5f', color: '#60a5fa', borderRadius: 3,
                  padding: '1px 6px', fontSize: 11, fontWeight: 700,
                }}>
                  {u.remaining_qty} remaining
                </span>
                <span style={{ color: '#64748b', fontSize: 11.5 }}>
                  {u.reason === 'beyond_horizon'
                    ? 'queued beyond this horizon: extend the range to see it'
                    : 'no eligible printer right now: open the part in Projects and use "Why isn’t this printing?"'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
