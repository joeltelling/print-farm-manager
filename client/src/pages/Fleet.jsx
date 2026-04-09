import { useState, useEffect, useCallback } from 'react';

const STATUS_COLORS = {
  PRINTING:   { bg: '#1e3a5f', text: '#60a5fa', label: 'Printing' },
  IDLE:       { bg: '#1f2937', text: '#6b7280', label: 'Idle' },
  READY:      { bg: '#1f2937', text: '#94a3b8', label: 'Prepared' },
  FINISHED:   { bg: '#14532d', text: '#86efac', label: 'Finished' },
  STOPPED:    { bg: '#431407', text: '#fb923c', label: 'Stopped' },
  PAUSED:     { bg: '#78350f', text: '#fbbf24', label: 'Paused' },
  ATTENTION:  { bg: '#78350f', text: '#fbbf24', label: 'Attention' },
  ERROR:      { bg: '#7f1d1d', text: '#f87171', label: 'Error' },
  OFFLINE:    { bg: '#1f2937', text: '#6b7280', label: 'Offline' },
  UNKNOWN:    { bg: '#1f2937', text: '#9ca3af', label: 'Unknown' },
};

const KNOWN_STATUSES = new Set(Object.keys(STATUS_COLORS));

function statusStyle(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.UNKNOWN;
}

async function inspectPrinter(printer) {
  console.group(`[inspect] ${printer.name} (${printer.ip})`);
  try {
    const res  = await fetch(`/api/printers/${printer.id}/raw-status`);
    const data = await res.json();
    if (data.error) {
      console.warn('PrusaLink error:', data.error);
    } else {
      console.log('Full raw response:', data.raw);
      console.log('printer.state:', data.raw?.printer?.state);
      console.log('printer.flags:', data.raw?.printer?.flags);
      console.log('job:', data.raw?.job);
    }
  } catch (err) {
    console.error('Fetch failed:', err);
  }
  console.groupEnd();
}

const POLL_INTERVAL_MS = 15000;

function PollTimer({ lastPolled }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (lastPolled === null) return;
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - lastPolled), 100);
    return () => clearInterval(id);
  }, [lastPolled]);

  const size = 20;
  const strokeWidth = 2.5;
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = Math.min(elapsed / POLL_INTERVAL_MS, 1);
  const offset = circumference * (1 - progress);

  return (
    <svg
      width={size}
      height={size}
      style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}
      title={`Last polled ${Math.round(elapsed / 1000)}s ago`}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#2d3748" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatTimeRemaining(secs) {
  if (secs == null || secs < 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m left`;
  return '< 1m left';
}

function PrinterCard({ printer, selected, onToggleSelect, onSetReady, onBadPrint, onDecommission }) {
  const style = statusStyle(printer.status);

  // Confirmed-qty input — pre-filled from the last finished job's parts_per_plate.
  // Only shown when is_held and we know how many parts were on the plate.
  const [confirmedQty, setConfirmedQty] = useState(
    printer.last_parts_per_plate != null ? String(printer.last_parts_per_plate) : ''
  );
  useEffect(() => {
    if (printer.last_parts_per_plate != null) {
      setConfirmedQty(String(printer.last_parts_per_plate));
    }
  }, [printer.last_parts_per_plate]);

  // Partial failure — operator has reduced the good-qty below the full plate count.
  // Batch set-ready credits full parts_per_plate, so this printer must be confirmed
  // individually. Auto-remove from the batch selection if it was already checked.
  const isPartial = printer.last_parts_per_plate != null
    && !isNaN(parseInt(confirmedQty, 10))
    && parseInt(confirmedQty, 10) < printer.last_parts_per_plate;
  useEffect(() => {
    if (isPartial && selected) onToggleSelect(printer.id);
  }, [isPartial]); // eslint-disable-line react-hooks/exhaustive-deps
  // Show confirmation buttons only when there's something to inspect.
  // A printer that is actively printing is held-in-advance — it will need sign-off
  // when it finishes, but there is nothing to confirm right now.
  const needsConfirmation = printer.is_held === 1 && (printer.status === 'FINISHED' || printer.status === 'IDLE');
  const isPrinting = printer.status === 'PRINTING';
  const pct = isPrinting && printer.job_progress != null ? Math.round(printer.job_progress) : null;
  const timeLeft = isPrinting ? formatTimeRemaining(printer.job_time_remaining) : null;

  return (
    <div
      onClick={() => inspectPrinter(printer)}
      title="Click to inspect raw PrusaLink status in console"
      style={{
        background: needsConfirmation ? '#1c2a1c' : '#1e2433',
        border: `1px solid ${needsConfirmation ? '#15803d' : style.bg}`,
        borderRadius: 8,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
        cursor: 'pointer',
      }}
    >
      {/* Name + status badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {printer.name}
        </span>
        <span style={{ background: style.bg, color: style.text, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
          {style.label}
        </span>
      </div>

      {/* Model + group */}
      <div style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ background: '#0f172a', borderRadius: 3, padding: '1px 6px', fontFamily: 'monospace', color: '#64748b' }}>
          {printer.model}
        </span>
        {printer.group_name && <span style={{ color: '#475569' }}>{printer.group_name}</span>}
      </div>

      {/* Print job info — only when printing */}
      {isPrinting && (
        <div style={{ marginTop: 2 }}>
          {printer.job_name && (
            <div style={{
              fontSize: 11, color: '#94a3b8', fontFamily: 'monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              marginBottom: 5,
            }}>
              {printer.job_name}
            </div>
          )}
          <div style={{ background: '#0f172a', borderRadius: 3, height: 6, overflow: 'hidden', marginBottom: 4 }}>
            <div style={{
              background: '#3b82f6',
              height: '100%',
              width: `${pct ?? 0}%`,
              borderRadius: 3,
              transition: 'width 0.5s',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#475569' }}>
            <span>{pct != null ? `${pct}%` : '—'}</span>
            {timeLeft && <span>{timeLeft}</span>}
          </div>
        </div>
      )}

      {printer.status === 'STOPPED' && (
        <div style={{ fontSize: 11, color: '#fb923c', marginTop: 4 }}>
          Clear on printer screen to continue
        </div>
      )}

      {needsConfirmation && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
          {!isPartial && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', color: '#94a3b8', fontSize: 12 }}>
              <input type="checkbox" checked={selected} onChange={() => onToggleSelect(printer.id)} style={{ cursor: 'pointer', accentColor: '#22c55e' }} />
              Include
            </label>
          )}
          {printer.last_parts_per_plate != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>Good:</span>
              <input
                type="number"
                min={0}
                max={printer.last_parts_per_plate}
                value={confirmedQty}
                onChange={e => setConfirmedQty(e.target.value)}
                style={{
                  width: 46, background: '#0f172a', border: '1px solid #2d3748',
                  borderRadius: 3, padding: '2px 5px', color: '#e2e8f0', fontSize: 12,
                  textAlign: 'center',
                }}
              />
              <span style={{ fontSize: 11, color: '#475569' }}>/ {printer.last_parts_per_plate}</span>
            </div>
          )}
          <button
            onClick={() => onSetReady(printer.id, printer.last_parts_per_plate != null ? parseInt(confirmedQty, 10) : null)}
            style={{ background: '#166534', color: '#4ade80', border: 'none', borderRadius: 4, padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            ✓ Set Ready
          </button>
          <button onClick={() => onBadPrint(printer.id)} style={{ background: '#7f1d1d', color: '#f87171', border: 'none', borderRadius: 4, padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            ✗ Bad Print
          </button>
        </div>
      )}

      <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 2 }}>
        <button onClick={() => onDecommission(printer.id)} style={{ background: 'none', color: '#475569', border: '1px solid #2d3748', borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
          Decommission
        </button>
      </div>
    </div>
  );
}

const MODEL_ORDER = ['mk4', 'mk4s', 'c1', 'c1l', 'xl', 'centauri-carbon'];

export default function Fleet() {
  const [printers, setPrinters]               = useState([]);
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState(null);
  const [filter, setFilter]                   = useState('ALL');
  const [search, setSearch]                   = useState('');
  const [selectedForReady, setSelectedForReady] = useState(new Set());
  const [lastPolled, setLastPolled]           = useState(null);

  const fetchPrinters = useCallback(async () => {
    try {
      const res = await fetch('/api/printers');
      if (!res.ok) throw new Error('Failed to fetch printers');
      const data = await res.json();
      setPrinters(data);
      setLastPolled(Date.now());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrinters();
    const interval = setInterval(fetchPrinters, 15000);
    return () => clearInterval(interval);
  }, [fetchPrinters]);

  // Printers awaiting operator confirmation — excludes those currently printing (hold is pre-set for when they finish)
  const awaitingConfirmation = printers.filter(p => p.is_held === 1 && (p.status === 'FINISHED' || p.status === 'IDLE'));

  function toggleSelect(printerId) {
    setSelectedForReady(prev => {
      const next = new Set(prev);
      next.has(printerId) ? next.delete(printerId) : next.add(printerId);
      return next;
    });
  }

  function selectAll() {
    setSelectedForReady(new Set(awaitingConfirmation.map(p => p.id)));
  }

  function deselectAll() {
    setSelectedForReady(new Set());
  }

  async function setReady(printerId, confirmedQty) {
    await fetch(`/api/printers/${printerId}/set-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmedQty != null ? { confirmed_qty: confirmedQty } : {}),
    });
    setSelectedForReady(prev => { const next = new Set(prev); next.delete(printerId); return next; });
    fetchPrinters();
  }

  async function setReadyForSelected() {
    await fetch('/api/printers/set-ready-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedForReady] }),
    });
    setSelectedForReady(new Set());
    fetchPrinters();
  }

  async function decommission(printerId) {
    const printer = printers.find(p => p.id === printerId);

    // Step 1 — if not mid-print, ask about the last print's outcome before anything else.
    // This catches the case where a print physically failed but the system recorded it as finished.
    if (printer?.status !== 'PRINTING') {
      const printFailed = window.confirm(
        `Before decommissioning ${printer?.name} — did the last print FAIL?\n\n` +
        `OK     → Yes, it failed — undo the count and decommission\n` +
        `Cancel → No / not applicable — proceed to decommission only`
      );

      if (printFailed) {
        const res = await fetch(`/api/printers/${printerId}/mark-job-failure`, { method: 'POST' });
        if (res.ok) {
          // mark-job-failure already decommissions — nothing more to do.
          fetchPrinters();
          return;
        }
        // No finished job found (e.g. pure hardware failure with no completed print).
        // Fall through to the plain decommission confirm below.
      }
    }

    // Step 2 — confirm the decommission itself.
    if (!window.confirm(
      `Decommission ${printer?.name}?\n\n` +
      `This machine will be removed from the active fleet, will no longer receive jobs, ` +
      `and will require a manual recommission before it can run again.`
    )) return;

    await fetch(`/api/printers/${printerId}/decommission`, { method: 'POST' });
    fetchPrinters();
  }

  async function badPrint(printerId) {
    const printer = printers.find(p => p.id === printerId);
    if (!window.confirm(`Mark the last finished job on ${printer?.name} as a failure?\n\nThis will undo the completed quantity, reopen the part if it was closed, and DECOMMISSION the printer pending investigation.\n\nRecommission the printer manually once you have confirmed it is safe to run.`)) return;
    await fetch(`/api/printers/${printerId}/mark-job-failure`, { method: 'POST' });
    setSelectedForReady(prev => { const next = new Set(prev); next.delete(printerId); return next; });
    fetchPrinters();
  }

  const counts = printers.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});

  const hasUnknown = printers.some(p => !KNOWN_STATUSES.has(p.status));

  const filtered = printers.filter((p) => {
    if (filter === 'UNKNOWN') return !KNOWN_STATUSES.has(p.status);
    if (filter !== 'ALL' && p.status !== filter) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) &&
        !p.ip.includes(search) && !(p.group_name || '').toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    return true;
  });

  // Group by model
  const grouped = MODEL_ORDER.reduce((acc, model) => {
    const group = filtered.filter((p) => p.model === model);
    if (group.length > 0) acc[model] = group;
    return acc;
  }, {});
  const otherModels = filtered.filter((p) => !MODEL_ORDER.includes(p.model));
  if (otherModels.length > 0) grouped['other'] = otherModels;

  const MODEL_LABELS = { mk4: 'MK4', mk4s: 'MK4S', c1: 'Core One', c1l: 'Core 1L', xl: 'XL', 'centauri-carbon': 'Centauri Carbon', other: 'Other' };

  async function sweep() {
    await fetch('/api/scheduler/dispatch', { method: 'POST' });
    fetchPrinters();
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Fleet</h1>
          <PollTimer lastPolled={lastPolled} />
        </div>
        <button
          onClick={sweep}
          title="Tell the scheduler to find and dispatch jobs to all idle ready machines"
          style={{ background: '#1e2433', color: '#94a3b8', border: '1px solid #2d3748', borderRadius: 6, padding: '5px 14px', fontSize: 13, cursor: 'pointer' }}
        >
          Sweep for Jobs
        </button>
      </div>

      {/* Confirmation banner */}
      {awaitingConfirmation.length > 0 && (
        <div style={{
          background: '#14532d',
          border: '1px solid #15803d',
          borderRadius: 8,
          padding: '10px 16px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <span style={{ color: '#86efac', fontWeight: 600, fontSize: 14 }}>
            {awaitingConfirmation.length} printer{awaitingConfirmation.length !== 1 ? 's' : ''} awaiting confirmation
          </span>
          <button
            onClick={selectAll}
            style={{ background: '#166534', color: '#4ade80', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            Select All
          </button>
          {selectedForReady.size > 0 && (
            <>
              <button
                onClick={deselectAll}
                style={{ background: '#1f2937', color: '#9ca3af', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}
              >
                Deselect All
              </button>
              <button
                onClick={setReadyForSelected}
                style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >
                ✓ Set Ready ({selectedForReady.size})
              </button>
            </>
          )}
        </div>
      )}

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {[
          { key: 'ALL',      label: `All (${printers.length})`,               color: '#64748b' },
          { key: 'PRINTING', label: `Printing (${counts.PRINTING || 0})`,   color: STATUS_COLORS.PRINTING.text },
          { key: 'IDLE',     label: `Idle (${counts.IDLE || 0})`,           color: STATUS_COLORS.IDLE.text },
          { key: 'FINISHED', label: `Finished (${counts.FINISHED || 0})`,   color: STATUS_COLORS.FINISHED.text },
          { key: 'STOPPED',  label: `Stopped (${counts.STOPPED || 0})`,     color: STATUS_COLORS.STOPPED.text },
          { key: 'ERROR',    label: `Error (${counts.ERROR || 0})`,         color: STATUS_COLORS.ERROR.text },
          { key: 'ATTENTION',label: `Attention (${counts.ATTENTION || 0})`, color: STATUS_COLORS.ATTENTION.text },
          { key: 'OFFLINE',  label: `Offline (${counts.OFFLINE || 0})`,     color: STATUS_COLORS.OFFLINE.text },
          ...(hasUnknown ? [{ key: 'UNKNOWN', label: `Unknown (${printers.filter(p => !KNOWN_STATUSES.has(p.status)).length})`, color: STATUS_COLORS.UNKNOWN.text }] : []),
        ].map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              background: filter === key ? '#1e40af' : '#1e2433',
              color: filter === key ? '#fff' : color,
              border: `1px solid ${filter === key ? '#3b82f6' : '#2d3748'}`,
              borderRadius: 20,
              padding: '4px 12px',
              fontSize: 13,
              cursor: 'pointer',
              fontWeight: filter === key ? 700 : 400,
            }}
          >
            {label}
          </button>
        ))}
        <input
          type="text"
          placeholder="Search name / IP / group…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: '#1e2433',
            border: '1px solid #2d3748',
            borderRadius: 20,
            padding: '4px 14px',
            color: '#e2e8f0',
            fontSize: 13,
            outline: 'none',
            flex: '1 1 180px',
            maxWidth: 280,
          }}
        />
      </div>

      {loading && <p style={{ color: '#64748b' }}>Loading printers…</p>}
      {error && <p style={{ color: '#f87171' }}>Error: {error}</p>}
      {!loading && printers.length === 0 && (
        <p style={{ color: '#64748b' }}>
          No printers registered. Import a CSV on the Settings page.
        </p>
      )}

      {Object.entries(grouped).map(([model, group]) => (
        <div key={model} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            {MODEL_LABELS[model] || model} <span style={{ fontWeight: 400, color: '#475569' }}>({group.length})</span>
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}>
            {group.map((printer) => (
              <PrinterCard
                key={printer.id}
                printer={printer}
                selected={selectedForReady.has(printer.id)}
                onToggleSelect={toggleSelect}
                onSetReady={setReady}
                onBadPrint={badPrint}
                onDecommission={decommission}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
