import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

const STATUS_COLORS = {
  IDLE:     { bg: '#1e3a5f', text: '#93c5fd' },
  PRINTING: { bg: '#1e3a5f', text: '#60a5fa' },
  FINISHED: { bg: '#14532d', text: '#86efac' },
  PAUSED:   { bg: '#78350f', text: '#fcd34d' },
  ERROR:    { bg: '#7f1d1d', text: '#fca5a5' },
  OFFLINE:  { bg: '#1e2433', text: '#475569' },
  UNKNOWN:  { bg: '#1e2433', text: '#475569' },
};

const SUMMARY_PILLS = [
  { key: 'PRINTING', label: 'printing', bg: '#1e3a5f', text: '#60a5fa' },
  { key: 'IDLE',     label: 'idle',     bg: '#1a2030', text: '#94a3b8' },
  { key: 'AWAITING', label: 'awaiting', bg: '#14532d', text: '#4ade80' },
  { key: 'ERROR',    label: 'error',    bg: '#450a0a', text: '#ef4444' },
  { key: 'PAUSED',   label: 'paused',   bg: '#451a03', text: '#f59e0b' },
  { key: 'OFFLINE',  label: 'offline',  bg: '#0d1117', text: '#475569' },
];

const COLLAPSED_KEY = 'printers.collapsedGroups';
const SHOW_DECOM_KEY = 'printers.showDecommissioned';

function statusBadge(status) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.UNKNOWN;
  return (
    <span style={{
      background: c.bg, color: c.text,
      borderRadius: 4, padding: '1px 8px',
      fontSize: 11, fontWeight: 700,
      letterSpacing: '0.03em',
    }}>
      {status}
    </span>
  );
}

function summarize(group) {
  const counts = { PRINTING: 0, IDLE: 0, AWAITING: 0, ERROR: 0, PAUSED: 0, OFFLINE: 0 };
  for (const p of group) {
    // Keep this condition identical to Fleet.jsx and Dashboard.jsx (see CLAUDE.md sync pairs).
    const awaiting = p.is_held === 1 && (p.status === 'FINISHED' || p.status === 'IDLE' || p.status === 'STOPPED');
    if (awaiting) { counts.AWAITING++; continue; }
    if (counts[p.status] !== undefined) counts[p.status]++;
  }
  return counts;
}

export default function Printers() {
  const [printers, setPrinters]     = useState([]);
  const [models, setModels]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [search, setSearch]         = useState('');
  const [collapsed, setCollapsed]   = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); }
    catch { return new Set(); }
  });
  const [showDecom, setShowDecom] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SHOW_DECOM_KEY) || 'false'); }
    catch { return false; }
  });

  // Bulk-selection state
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [filamentTypes, setFilamentTypes]   = useState([]);
  const [filamentColors, setFilamentColors] = useState([]);
  const [bulkMaterial, setBulkMaterial] = useState('');
  const [bulkColor, setBulkColor]       = useState('');
  const [bulkGroup, setBulkGroup]       = useState('');
  const [applying, setApplying]         = useState(false);

  const navigate = useNavigate();

  const fetchPrinters = useCallback(() => {
    return Promise.all([
      fetch('/api/printers').then(r => r.json()),
      fetch('/api/printers/decommissioned').then(r => r.json()),
      fetch('/api/models').then(r => r.json()),
    ]).then(([active, decommissioned, modelList]) => {
      setPrinters([...active, ...decommissioned]);
      setModels(modelList);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchPrinters();
    fetch('/api/filaments/types').then(r => r.json()).then(setFilamentTypes).catch(() => {});
    fetch('/api/filaments/colors').then(r => r.json()).then(setFilamentColors).catch(() => {});
  }, [fetchPrinters]);

  function persistCollapsed(next) {
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  }

  function toggleGroupCollapse(key) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key); else next.add(key);
    persistCollapsed(next);
  }

  function toggleShowDecom(v) {
    setShowDecom(v);
    localStorage.setItem(SHOW_DECOM_KEY, JSON.stringify(v));
  }

  // ── Selection helpers ───────────────────────────────────────────────────────

  function togglePrinter(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectGroup(groupPrinters) {
    const allSelected = groupPrinters.every(p => selectedIds.has(p.id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) {
        groupPrinters.forEach(p => next.delete(p.id));
      } else {
        groupPrinters.forEach(p => next.add(p.id));
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setBulkMaterial('');
    setBulkColor('');
    setBulkGroup('');
  }

  // Distinct existing group names across all loaded printers — powers the bulk-group autocomplete
  const existingGroups = useMemo(
    () => [...new Set(printers.map(p => p.group_name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [printers]
  );

  async function applyBulk() {
    const mat = bulkMaterial.trim();
    const col = bulkColor.trim();
    const grp = bulkGroup.trim();
    if (!mat && !col && !grp) return;
    setApplying(true);
    const body = {};
    if (mat) body.loaded_material = mat;
    if (col) body.loaded_color = col;
    if (grp) body.group_name = grp;
    await Promise.all([...selectedIds].map(id =>
      fetch(`/api/printers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ));
    await fetchPrinters();
    setApplying(false);
    clearSelection();
  }

  // ── Filter + group ──────────────────────────────────────────────────────────
  const { groups, totalShown, totalMatched, decomGroup } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (p) => {
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.model || '').toLowerCase().includes(q) ||
        (p.group_name || '').toLowerCase().includes(q) ||
        (p.ip || '').includes(q)
      );
    };

    const activePrinters = printers.filter(p => p.is_active);
    const decomPrinters  = printers.filter(p => !p.is_active);

    const orderedModelIds = models.map(m => m.model_id);
    const labels = Object.fromEntries(models.map(m => [m.model_id, m.label]));

    const buckets = new Map();
    for (const id of orderedModelIds) buckets.set(id, []);
    for (const p of activePrinters) {
      const id = orderedModelIds.includes(p.model) ? p.model : 'other';
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(p);
    }

    const groups = [];
    let totalShown = 0;
    let totalMatched = 0;
    for (const [id, all] of buckets) {
      if (all.length === 0) continue;
      const matched = all.filter(matches);
      totalShown += all.length;
      totalMatched += matched.length;
      groups.push({
        key: id,
        label: id === 'other' ? 'Other' : (labels[id] || id),
        all,
        matched: matched.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    const decomMatched = decomPrinters.filter(matches)
      .sort((a, b) => a.name.localeCompare(b.name));
    const decomGroup = {
      key: '__decommissioned__',
      label: 'Decommissioned',
      all: decomPrinters,
      matched: decomMatched,
    };

    return { groups, totalShown, totalMatched, decomGroup };
  }, [printers, models, search]);

  const isSearching = search.trim().length > 0;
  const isOpen = (g) => isSearching ? g.matched.length > 0 : !collapsed.has(g.key);

  function expandAll() { persistCollapsed(new Set()); }
  function collapseAll() {
    const all = new Set(groups.map(g => g.key));
    if (showDecom && decomGroup.all.length > 0) all.add(decomGroup.key);
    persistCollapsed(all);
  }

  const canApply = (bulkMaterial.trim() || bulkColor.trim() || bulkGroup.trim()) && selectedIds.size > 0;

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Printers</h1>
      <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>
        All printers — grouped by model. Click any row to view history and add notes.
      </p>

      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        marginBottom: selectedIds.size > 0 ? 8 : 16,
      }}>
        <input
          type="text"
          placeholder="Search by name, model, group, or IP…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: '1 1 300px', maxWidth: 380,
            background: '#1e2433', border: '1px solid #2d3748',
            borderRadius: 6, color: '#e2e8f0', fontSize: 13,
            padding: '7px 12px', outline: 'none', boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={expandAll} style={toolbarBtn}>Expand all</button>
          <button onClick={collapseAll} style={toolbarBtn}>Collapse all</button>
        </div>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 12, color: '#94a3b8', cursor: 'pointer',
          marginLeft: 'auto',
        }}>
          <input
            type="checkbox"
            checked={showDecom}
            onChange={e => toggleShowDecom(e.target.checked)}
            style={{ accentColor: '#3b82f6' }}
          />
          Show decommissioned ({decomGroup.all.length})
        </label>
      </div>

      {/* Bulk-edit bar */}
      {selectedIds.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          background: '#131c2e', border: '1px solid #1e3a5f',
          borderRadius: 7, padding: '8px 14px', marginBottom: 12,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#93c5fd', flexShrink: 0 }}>
            {selectedIds.size} selected
          </span>
          <button onClick={clearSelection} style={{ ...toolbarBtn, fontSize: 11, padding: '4px 8px' }}>
            Clear
          </button>
          <span style={{ fontSize: 11, color: '#475569', flexShrink: 0 }}>Set:</span>
          <select
            value={bulkMaterial}
            onChange={e => { setBulkMaterial(e.target.value); setBulkColor(''); }}
            style={bulkInputSx}
          >
            <option value="">Material…</option>
            {filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
          <select
            value={bulkColor}
            onChange={e => setBulkColor(e.target.value)}
            disabled={!bulkMaterial}
            style={bulkInputSx}
          >
            <option value="">Color…</option>
            {filamentColors
              .filter(c => c.type_name === bulkMaterial)
              .map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <input
            type="text"
            list="bulk-group-options"
            value={bulkGroup}
            onChange={e => setBulkGroup(e.target.value)}
            placeholder="Group…"
            style={{ ...bulkInputSx, width: 130 }}
          />
          <datalist id="bulk-group-options">
            {existingGroups.map(g => <option key={g} value={g} />)}
          </datalist>
          <button
            onClick={applyBulk}
            disabled={!canApply || applying}
            style={{
              background: canApply && !applying ? '#1d4ed8' : '#1e2433',
              color: canApply && !applying ? '#fff' : '#475569',
              border: 'none', borderRadius: 5,
              padding: '6px 14px', fontSize: 12, fontWeight: 600,
              cursor: canApply && !applying ? 'pointer' : 'not-allowed',
              flexShrink: 0,
            }}
          >
            {applying ? 'Applying…' : 'Apply to selected'}
          </button>
          <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>
            Empty fields are left unchanged
          </span>
        </div>
      )}

      {isSearching && (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
          {totalMatched} of {totalShown} match "{search}"
        </div>
      )}

      {loading && <p style={{ color: '#64748b' }}>Loading…</p>}

      {!loading && groups.length === 0 && !showDecom && (
        <p style={{ color: '#475569', fontSize: 14 }}>No printers found.</p>
      )}

      {!loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {groups.map(g => (
            <GroupSection
              key={g.key}
              group={g}
              open={isOpen(g)}
              onToggle={() => toggleGroupCollapse(g.key)}
              onClickPrinter={(p) => navigate(`/printers/${p.id}`)}
              dimmed={false}
              hideEmpty={isSearching}
              selectedIds={selectedIds}
              onTogglePrinter={togglePrinter}
              onSelectGroup={selectGroup}
            />
          ))}

          {showDecom && decomGroup.all.length > 0 && (
            <GroupSection
              group={decomGroup}
              open={isOpen(decomGroup)}
              onToggle={() => toggleGroupCollapse(decomGroup.key)}
              onClickPrinter={(p) => navigate(`/printers/${p.id}`)}
              dimmed
              hideEmpty={isSearching}
              selectedIds={selectedIds}
              onTogglePrinter={togglePrinter}
              onSelectGroup={selectGroup}
            />
          )}
        </div>
      )}
    </div>
  );
}

const toolbarBtn = {
  background: '#1e2433', color: '#94a3b8',
  border: '1px solid #2d3748', borderRadius: 5,
  padding: '6px 10px', fontSize: 12, fontWeight: 500,
  cursor: 'pointer',
};

const bulkInputSx = {
  background: '#1e2433', border: '1px solid #2d3748',
  borderRadius: 5, color: '#e2e8f0', fontSize: 12,
  padding: '5px 10px', outline: 'none', width: 160,
};

function GroupSection({ group, open, onToggle, onClickPrinter, dimmed, hideEmpty,
                        selectedIds, onTogglePrinter, onSelectGroup }) {
  if (hideEmpty && group.matched.length === 0) return null;

  const summary = summarize(group.all);
  const total   = group.all.length;
  const visible = group.matched.length;
  const isFiltered = visible !== total;

  const visiblePrinters = group.matched;
  const allVisibleSelected = visiblePrinters.length > 0 && visiblePrinters.every(p => selectedIds.has(p.id));
  const someVisibleSelected = visiblePrinters.some(p => selectedIds.has(p.id));

  return (
    <div style={{
      background: '#0f1218',
      border: '1px solid #1e2433',
      borderRadius: 9,
      overflow: 'hidden',
      opacity: dimmed && !open ? 0.7 : 1,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center',
        background: open ? '#151c28' : '#131720',
        borderBottom: open ? '1px solid #1e2433' : 'none',
      }}>
        {/* Group-level select-all checkbox */}
        {!dimmed && (
          <div
            onClick={e => e.stopPropagation()}
            style={{ padding: '11px 0 11px 14px', flexShrink: 0 }}
          >
            <input
              type="checkbox"
              checked={allVisibleSelected}
              ref={el => { if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected; }}
              onChange={() => onSelectGroup(visiblePrinters)}
              style={{ accentColor: '#3b82f6', cursor: 'pointer' }}
              title="Select all in this group"
            />
          </div>
        )}
        <button
          onClick={onToggle}
          style={{
            flex: 1,
            display: 'flex', alignItems: 'center', gap: 12,
            background: 'transparent',
            border: 'none',
            color: '#e2e8f0',
            padding: dimmed ? '11px 14px' : '11px 14px 11px 10px',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}
        >
          <span style={{
            fontSize: 11, color: '#64748b',
            width: 12, display: 'inline-block',
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.12s',
          }}>
            ▶
          </span>
          <span style={{ fontWeight: 700, fontSize: 14, color: dimmed ? '#94a3b8' : '#e2e8f0' }}>
            {group.label}
          </span>
          <span style={{ fontSize: 12, color: '#475569' }}>
            {isFiltered ? `${visible} of ${total}` : `${total}`}
          </span>

          {!dimmed && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
              {SUMMARY_PILLS.map(p => {
                const n = summary[p.key];
                if (!n) return null;
                return (
                  <span key={p.key} style={{
                    background: p.bg, color: p.text,
                    fontSize: 10, fontWeight: 700,
                    letterSpacing: '0.03em',
                    borderRadius: 3, padding: '2px 7px',
                  }}>
                    {n} {p.label}
                  </span>
                );
              })}
            </div>
          )}
        </button>
      </div>

      {/* Body */}
      {open && (
        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Column header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '24px 2fr 1fr 1fr 1fr 1fr',
            padding: '4px 10px',
            fontSize: 10, fontWeight: 700, color: '#475569',
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            <span />
            <span>Name</span>
            <span>Group</span>
            <span>Material</span>
            <span>IP</span>
            <span>Status</span>
          </div>

          {group.matched.map(printer => (
            <div
              key={printer.id}
              onClick={() => onClickPrinter(printer)}
              style={{
                display: 'grid',
                gridTemplateColumns: '24px 2fr 1fr 1fr 1fr 1fr',
                alignItems: 'center',
                background: selectedIds.has(printer.id) ? '#131c2e' : '#131720',
                border: `1px solid ${selectedIds.has(printer.id) ? '#1e3a5f' : '#1e2433'}`,
                borderRadius: 6,
                padding: '8px 10px',
                cursor: 'pointer',
                opacity: dimmed ? 0.7 : 1,
                transition: 'border-color 0.1s, background 0.1s',
              }}
              onMouseEnter={e => {
                if (!selectedIds.has(printer.id)) e.currentTarget.style.borderColor = '#3b82f6';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = selectedIds.has(printer.id) ? '#1e3a5f' : '#1e2433';
              }}
            >
              {/* Checkbox — stop propagation so row click still navigates */}
              <div onClick={e => { e.stopPropagation(); onTogglePrinter(printer.id); }}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(printer.id)}
                  onChange={() => {}}
                  style={{ accentColor: '#3b82f6', cursor: 'pointer' }}
                />
              </div>
              <span style={{ fontWeight: 600, fontSize: 13, color: '#e2e8f0' }}>
                {printer.name}
                {dimmed && (
                  <span style={{ marginLeft: 8, fontSize: 11, color: '#475569', fontWeight: 400 }}>
                    decommissioned
                  </span>
                )}
              </span>
              <span style={{ fontSize: 13, color: '#64748b' }}>{printer.group_name || '—'}</span>
              <span style={{ fontSize: 12, color: '#7dd3fc' }}>
                {[printer.loaded_material, printer.loaded_color].filter(Boolean).join(' · ') || '—'}
              </span>
              <span style={{ fontSize: 12, color: '#475569', fontFamily: 'monospace' }}>{printer.ip}</span>
              <span>{dimmed
                ? <span style={{ fontSize: 11, color: '#475569' }}>offline</span>
                : statusBadge(printer.status)
              }</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
