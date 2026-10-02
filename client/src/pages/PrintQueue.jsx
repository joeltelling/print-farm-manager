import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../useToast';
import EmptyState from '../components/EmptyState';
import { SCHEDULE_DIRTY_EVENT } from '../scheduleDirty';

// Every open part of every active project, in the order the scheduler considers them, with
// the printers that can run each one. A part with no matching printer says why, so an
// operator can fix the targeting or the loaded filament instead of wondering why it sits.
//
// Freshness follows Schedule.jsx rather than the 15 s poll used on Fleet: the queue is
// built from the same inputs as the forward schedule, so it shares the schedule's
// fingerprint. A cheap version poll (and the same-tab dirty event) flips the page into a
// visible recalculating state the moment the farm changes, instead of leaving an old
// list on screen looking current. The slow full refresh only catches display-name edits,
// which the fingerprint deliberately does not hash.

const VERSION_POLL_MS = 5000;  // cheap staleness check
const FALLBACK_MS     = 60000; // picks up renames, which do not move the fingerprint

// Printer match states from GET /api/parts/queue, same meaning as on the Projects page
// dispatch diagnostic. Fallback covers any state a newer server adds.
const MATCH_STATE = {
  ready:   { bg: '#14532d', border: '#166534', text: '#86efac', label: 'Ready' },
  busy:    { bg: '#1e3a5f', border: '#1e40af', text: '#93c5fd', label: 'Busy' },
  held:    { bg: '#78350f', border: '#92400e', text: '#fcd34d', label: 'Awaiting sign-off' },
  unknown: { bg: '#1f2937', border: '#2d3748', text: '#94a3b8', label: 'Unknown' },
};

function tagTitle(m) {
  const st = MATCH_STATE[m.state] || MATCH_STATE.unknown;
  const loaded = [m.loaded_material, m.loaded_color].filter(Boolean).join(' / ') || 'no filament set';
  const lines = [`${m.name} (${m.model})`, `${st.label}, printer reports ${m.status}`, `Loaded: ${loaded}`, `G-code: ${m.filename}`];
  if (m.group_name) lines.splice(1, 0, `Group: ${m.group_name}`);
  if (m.state === 'ready' && m.next_up) {
    lines.push(m.next_up.is_this_part
      ? 'Next up on this printer'
      : `Next up on this printer: ${m.next_up.part_name} (${m.next_up.project_name})`);
  }
  return lines.join('\n');
}

function PrinterTag({ match }) {
  const st = MATCH_STATE[match.state] || MATCH_STATE.unknown;
  const isNext = match.state === 'ready' && match.next_up?.is_this_part;
  return (
    <Link
      to={`/printers/${match.id}`}
      title={tagTitle(match)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: st.bg, border: `1px solid ${isNext ? st.text : st.border}`,
        color: st.text, borderRadius: 999, padding: '3px 10px',
        fontSize: 12, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.text, flexShrink: 0 }} />
      {match.name}
      {isNext && <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4 }}>NEXT</span>}
    </Link>
  );
}

function QueueRow({ part }) {
  const hasMatches = part.matches.length > 0;
  return (
    <div className="pq-row" style={{
      background: '#131720',
      border: `1px solid ${hasMatches ? '#1e2433' : '#7f1d1d'}`,
      borderRadius: 8,
      padding: '12px 14px',
    }}>
      {/* Part */}
      <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
        <div style={{
          color: '#64748b', fontSize: 13, fontWeight: 700, minWidth: 28,
          textAlign: 'right', fontVariantNumeric: 'tabular-nums', paddingTop: 1,
        }}>{part.position}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 14, overflowWrap: 'anywhere' }}>{part.part_name}</div>
          <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>{part.project_name}</div>
          <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>
            {part.completed_qty} / {part.target_qty} done
            {part.active_qty > 0 && <span style={{ color: '#60a5fa' }}>, {part.active_qty} printing</span>}
          </div>
          {part.blockers.map((b) => (
            <div key={b} style={{ color: '#fbbf24', fontSize: 12, marginTop: 4 }}>{b}</div>
          ))}
        </div>
      </div>

      {/* Matching printers, or why there are none */}
      <div style={{ minWidth: 0 }}>
        {hasMatches ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {part.matches.map((m) => <PrinterTag key={`${m.gcode_id}-${m.id}`} match={m} />)}
          </div>
        ) : (
          <div>
            <div style={{ color: '#f87171', fontSize: 12, fontWeight: 700, marginBottom: 4 }}>No matching printer</div>
            <ul style={{ margin: 0, paddingLeft: 18, color: '#fca5a5', fontSize: 12.5, lineHeight: 1.6 }}>
              {part.no_match_reasons.map((r) => <li key={r} style={{ overflowWrap: 'anywhere' }}>{r}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PrintQueue() {
  const [showToast, toastEl] = useToast();

  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [dirty, setDirty]         = useState(false);
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);

  // Read inside the polling callbacks so they keep a stable identity across payloads.
  const versionRef = useRef(null);
  const hasDataRef = useRef(false);

  const fetchQueue = useCallback(async ({ surfaceErrors = false } = {}) => {
    try {
      const res = await fetch('/api/parts/queue');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const payload = await res.json();
      versionRef.current = payload.version;
      hasDataRef.current = true;
      setData(payload);
      setDirty(false);
      setLoadError(null);
    } catch (err) {
      // Background refreshes keep the last good list on screen; only the Retry button,
      // which the operator pressed, reports through the toast channel.
      if (surfaceErrors) showToast('Could not load print queue: ' + err.message, 'error');
      if (!hasDataRef.current) setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(() => fetchQueue(), FALLBACK_MS);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  // Staleness check against the shared schedule fingerprint.
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/schedule/version');
        if (!res.ok) return;
        const { version } = await res.json();
        if (versionRef.current && version !== versionRef.current) {
          setDirty(true);
          fetchQueue();
        }
      } catch (_) {
        // Not worth reporting: the next check or the fallback refresh covers it.
      }
    };
    const interval = setInterval(check, VERSION_POLL_MS);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  // Same-tab signal from the Projects page that queue inputs just changed.
  useEffect(() => {
    const onDirty = () => { setDirty(true); fetchQueue(); };
    window.addEventListener(SCHEDULE_DIRTY_EVENT, onDirty);
    return () => window.removeEventListener(SCHEDULE_DIRTY_EVENT, onDirty);
  }, [fetchQueue]);

  const heading = <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Print Queue</h1>;

  if (loading) {
    return <div>{heading}<p style={{ color: '#64748b', marginTop: 16 }}>Loading…</p></div>;
  }

  if (!data && loadError) {
    return (
      <div>
        {toastEl}
        {heading}
        <div style={{
          background: '#1a1f2e', border: '1px solid #7f1d1d', borderRadius: 8, marginTop: 16,
          padding: '12px 16px', color: '#f87171', fontSize: 13,
        }}>
          Could not load the print queue: {loadError}
          <button
            onClick={() => fetchQueue({ surfaceErrors: true })}
            style={{
              marginLeft: 12, background: '#1d4ed8', color: '#fff', border: 'none',
              borderRadius: 4, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >Retry</button>
        </div>
      </div>
    );
  }

  const parts = data.parts;
  const unmatchedCount = parts.filter(p => p.matches.length === 0).length;
  const shown = onlyUnmatched ? parts.filter(p => p.matches.length === 0) : parts;

  return (
    <div>
      {toastEl}

      <style>{`
        .pq-row { display: grid; grid-template-columns: minmax(220px, 2fr) 3fr; gap: 14px; align-items: start; }
        @media (max-width: 600px) {
          .pq-row { grid-template-columns: 1fr; gap: 10px; }
        }
        @keyframes pqPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        {heading}
        {dirty && (
          <span
            title="The farm changed, so this queue is being recalculated"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: '#3b2c69', color: '#a78bfa', border: '1px solid #4c1d95',
              borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: '50%', background: '#a78bfa',
              animation: 'pqPulse 1s ease-in-out infinite',
            }} />
            Recalculating queue…
          </span>
        )}
      </div>

      <p style={{ color: '#64748b', fontSize: 12.5, margin: '0 0 14px', maxWidth: 760, lineHeight: 1.6 }}>
        Open parts from active projects, in the order the scheduler considers them: project
        priority, then part order. Tags are the printers whose model, group, and loaded
        filament match the part, whether or not they are free right now. NEXT marks a free
        printer that would print this part on its next dispatch.
      </p>

      {parts.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
          <span style={{ color: '#94a3b8' }}>
            {parts.length} part{parts.length === 1 ? '' : 's'} queued
            {unmatchedCount > 0 && <span style={{ color: '#f87171' }}>, {unmatchedCount} with no matching printer</span>}
          </span>
          {unmatchedCount > 0 && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#94a3b8', cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyUnmatched} onChange={(e) => setOnlyUnmatched(e.target.checked)} />
              Only show parts with no match
            </label>
          )}
          <span style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap', marginLeft: 'auto' }}>
            {['ready', 'busy', 'held'].map((k) => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#64748b', fontSize: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: MATCH_STATE[k].text }} />
                {MATCH_STATE[k].label}
              </span>
            ))}
          </span>
        </div>
      )}

      {parts.length === 0 ? (
        <EmptyState
          title="Nothing queued"
          hint="Parts show up here once their project is Active and they still need printing."
          actionLabel="Go to Projects"
          actionTo="/projects"
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((p) => <QueueRow key={p.part_id} part={p} />)}
        </div>
      )}
    </div>
  );
}
