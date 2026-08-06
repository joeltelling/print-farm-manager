import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const STATUS_COLORS = {
  IDLE:      { bg: '#1e3a5f', text: '#93c5fd', labelKey: 'common.statusIdle' },
  PRINTING:  { bg: '#1e3a5f', text: '#60a5fa', labelKey: 'common.statusPrinting' },
  UPLOADING: { bg: '#3b2c69', text: '#a78bfa', labelKey: 'common.statusUploading' },
  READY:     { bg: '#1e3a5f', text: '#93c5fd', labelKey: 'common.statusReady' },
  FINISHED:  { bg: '#14532d', text: '#86efac', labelKey: 'common.statusFinished' },
  STOPPED:   { bg: '#78350f', text: '#fcd34d', labelKey: 'common.statusStopped' },
  PAUSED:    { bg: '#78350f', text: '#fcd34d', labelKey: 'common.statusPaused' },
  ATTENTION: { bg: '#78350f', text: '#fcd34d', labelKey: 'common.statusAttention' },
  ERROR:     { bg: '#7f1d1d', text: '#fca5a5', labelKey: 'common.statusError' },
  OFFLINE:   { bg: '#1e2433', text: '#475569', labelKey: 'common.statusOffline' },
  UNKNOWN:   { bg: '#1e2433', text: '#475569', labelKey: 'common.statusUnknown' },
};

const SUMMARY_PILLS = [
  { key: 'PRINTING', labelKey: 'printers.pillPrinting', bg: '#1e3a5f', text: '#60a5fa' },
  { key: 'IDLE',     labelKey: 'printers.pillIdle',     bg: '#1a2030', text: '#94a3b8' },
  { key: 'AWAITING', labelKey: 'printers.pillAwaiting', bg: '#14532d', text: '#4ade80' },
  { key: 'ERROR',    labelKey: 'printers.pillError',    bg: '#450a0a', text: '#ef4444' },
  { key: 'PAUSED',   labelKey: 'printers.pillPaused',   bg: '#451a03', text: '#f59e0b' },
  { key: 'OFFLINE',  labelKey: 'printers.pillOffline',  bg: '#0d1117', text: '#475569' },
];

const COLLAPSED_KEY = 'printers.collapsedGroups';
const SHOW_DECOM_KEY = 'printers.showDecommissioned';

function statusBadge(status, t) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.UNKNOWN;
  return (
    <span style={{
      background: c.bg, color: c.text,
      borderRadius: 4, padding: '1px 8px',
      fontSize: 11, fontWeight: 700,
      letterSpacing: '0.03em',
    }}>
      {t(c.labelKey)}
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
  const { t, i18n } = useTranslation();
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
  const [registryGroups, setRegistryGroups] = useState([]);
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
    fetch('/api/groups').then(r => r.json()).then(groups => setRegistryGroups(groups.map(g => g.name))).catch(() => {});
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

  // Registered groups (not just ones currently assigned to a loaded printer):
  // powers the bulk-group autocomplete. Sourced from the persisted registry so
  // a group stays suggested even if no printer currently carries it.
  const existingGroups = useMemo(
    () => [...registryGroups].sort((a, b) => a.localeCompare(b)),
    [registryGroups]
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
        label: id === 'other' ? t('common.other') : (labels[id] || id),
        all,
        matched: matched.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    const decomMatched = decomPrinters.filter(matches)
      .sort((a, b) => a.name.localeCompare(b.name));
    const decomGroup = {
      key: '__decommissioned__',
      label: t('common.statusDecommissioned'),
      all: decomPrinters,
      matched: decomMatched,
    };

    return { groups, totalShown, totalMatched, decomGroup };
  }, [printers, models, search, t, i18n.resolvedLanguage]);

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
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t('printers.title')}</h1>
      <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>
        {t('printers.subtitle')}
      </p>

      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        marginBottom: selectedIds.size > 0 ? 8 : 16,
      }}>
        <input
          type="text"
          placeholder={t('printers.searchPlaceholder')}
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
          <button onClick={expandAll} style={toolbarBtn}>{t('printers.expandAll')}</button>
          <button onClick={collapseAll} style={toolbarBtn}>{t('printers.collapseAll')}</button>
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
          {t('printers.showDecommissioned', { count: decomGroup.all.length })}
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
            {t('printers.selectedCount', { count: selectedIds.size })}
          </span>
          <button onClick={clearSelection} style={{ ...toolbarBtn, fontSize: 11, padding: '4px 8px' }}>
            {t('common.clear')}
          </button>
          <span style={{ fontSize: 11, color: '#475569', flexShrink: 0 }}>{t('printers.setLabel')}</span>
          <select
            value={bulkMaterial}
            onChange={e => { setBulkMaterial(e.target.value); setBulkColor(''); }}
            style={bulkInputSx}
          >
            <option value="">{t('printers.materialPlaceholder')}</option>
            {filamentTypes.map(ft => <option key={ft.id} value={ft.name}>{ft.name}</option>)}
          </select>
          <select
            value={bulkColor}
            onChange={e => setBulkColor(e.target.value)}
            disabled={!bulkMaterial}
            style={bulkInputSx}
          >
            <option value="">{t('printers.colorPlaceholder')}</option>
            {filamentColors
              .filter(c => c.type_name === bulkMaterial)
              .map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <input
            type="text"
            list="bulk-group-options"
            value={bulkGroup}
            onChange={e => setBulkGroup(e.target.value)}
            placeholder={t('printers.groupPlaceholder')}
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
            {applying ? t('printers.applying') : t('printers.applyToSelected')}
          </button>
          <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>
            {t('printers.emptyFieldsUnchanged')}
          </span>
        </div>
      )}

      {isSearching && (
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
          {t('printers.matchCount', { matched: totalMatched, total: totalShown, query: search })}
        </div>
      )}

      {loading && <p style={{ color: '#64748b' }}>{t('common.loading')}</p>}

      {!loading && groups.length === 0 && !showDecom && (
        <p style={{ color: '#475569', fontSize: 14 }}>{t('printers.noPrintersFound')}</p>
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
  const { t } = useTranslation();
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
              title={t('printers.selectAllInGroup')}
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
            {isFiltered ? t('printers.groupHeaderCount', { visible, total }) : total}
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
                    {n} {t(p.labelKey)}
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
            <span>{t('printers.colName')}</span>
            <span>{t('printers.colGroup')}</span>
            <span>{t('printers.colMaterial')}</span>
            <span>{t('printers.colIp')}</span>
            <span>{t('printers.colStatus')}</span>
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
                    {t('printers.decommissionedTag')}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 13, color: '#64748b' }}>{printer.group_name || '—'}</span>
              <span style={{ fontSize: 12, color: '#7dd3fc' }}>
                {[printer.loaded_material, printer.loaded_color].filter(Boolean).join(' · ') || '—'}
              </span>
              <span style={{ fontSize: 12, color: '#475569', fontFamily: 'monospace' }}>{printer.ip}</span>
              <span>{dimmed
                ? <span style={{ fontSize: 11, color: '#475569' }}>{t('printers.offlineTag')}</span>
                : statusBadge(printer.status, t)
              }</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
