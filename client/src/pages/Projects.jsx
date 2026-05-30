import { useState, useEffect, useCallback, useRef } from 'react';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';

// ── Estimate helpers ──────────────────────────────────────────────────────────

function formatDurationForInput(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatMaterialForInput(grams) {
  if (grams == null) return '';
  if (grams < 1000) return `${Math.round(grams)}g`;
  const kg = (grams / 1000).toFixed(2).replace(/\.?0+$/, '');
  return `${kg}kg`;
}

// Model options are loaded from /api/models at runtime — no hardcoded list here.

const PROJECT_STATUS = {
  draft:     { bg: '#1f2937', text: '#9ca3af', dot: '#6b7280', label: 'Draft' },
  active:    { bg: '#166534', text: '#4ade80', dot: '#4ade80', label: 'Active' },
  paused:    { bg: '#713f12', text: '#fcd34d', dot: '#fcd34d', label: 'Paused' },
  completed: { bg: '#14532d', text: '#86efac', dot: '#86efac', label: 'Completed' },
};

// Dropdown options per project status.
// 'action' is either a status string ('active', 'paused') or a special verb ('complete', 'reactivate').
const STATUS_MENU = {
  draft:     [{ label: 'Activate',        action: 'active' }],
  active:    [{ label: 'Pause project',   action: 'paused' },
              { label: 'Mark complete',   action: 'complete', danger: true }],
  paused:    [{ label: 'Resume project',  action: 'active' },
              { label: 'Mark complete',   action: 'complete', danger: true }],
  completed: [{ label: 'Re-activate',     action: 'reactivate' }],
};

function StatusDropdown({ project, onTransition }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const meta    = PROJECT_STATUS[project.status] || PROJECT_STATUS.draft;
  const options = STATUS_MENU[project.status] || [];

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          background: meta.bg,
          color: meta.text,
          border: `1px solid ${meta.text}50`,
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          lineHeight: 1.4,
        }}
      >
        <span style={{ color: meta.dot, fontSize: 8, lineHeight: 1 }}>●</span>
        {meta.label}
        <span style={{ fontSize: 10, opacity: 0.8 }}>▾</span>
      </button>

      {open && options.length > 0 && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          background: '#1e2433',
          border: '1px solid #334155',
          borderRadius: 6,
          overflow: 'hidden',
          zIndex: 200,
          minWidth: 170,
          boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
        }}>
          {options.map(opt => (
            <button
              key={opt.action}
              onClick={() => { setOpen(false); onTransition(opt.action); }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                color: opt.danger ? '#fca5a5' : '#e2e8f0',
                padding: '9px 14px',
                fontSize: 13,
                cursor: 'pointer',
                borderTop: opt.danger ? '1px solid #1f2937' : 'none',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#0f172a'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const PART_STATUS = {
  open:   { bg: '#1e3a5f', text: '#60a5fa', label: 'Open' },
  closed: { bg: '#14532d', text: '#86efac', label: 'Closed' },
};

const inputSx = {
  background: '#0f172a',
  border: '1px solid #2d3748',
  borderRadius: 6,
  padding: '5px 10px',
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
};

function GcodeUploadPanel({ part, onUploaded }) {
  const [file, setFile]             = useState(null);
  const [partsPerPlate, setPPP]     = useState('');
  const [model, setModel]           = useState('');
  const [error, setError]           = useState(null);
  const [uploading, setUploading]   = useState(false);
  const fileInputRef                = useRef(null);
  const [modelOptions, setModelOptions] = useState([]);
  const [amsSlots, setAmsSlots]     = useState([]);   // [] = not a Bambu model
  const [amsSlot, setAmsSlot]       = useState('');   // '' = not yet chosen

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setModelOptions).catch(() => {});
  }, []);

  // Fetch live AMS slots whenever the model changes.
  // Returns [] for non-Bambu models or when no printer of that model is online.
  useEffect(() => {
    if (!model) { setAmsSlots([]); setAmsSlot(''); return; }
    fetch(`/api/printers/ams?model=${encodeURIComponent(model)}`)
      .then(r => r.json())
      .then(slots => { setAmsSlots(slots); setAmsSlot(''); })
      .catch(() => { setAmsSlots([]); setAmsSlot(''); });
  }, [model]);

  async function handleFileChange(e) {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setError(null);
    try {
      const res = await fetch('/api/gcodes/parse-filename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: f.name }),
      });
      const data = await res.json();
      if (!data.parse_failed) {
        setPPP(String(data.parts_per_plate));
        if (data.printer_model) setModel(data.printer_model);
      }
    } catch (_) {}
  }

  async function handleUpload() {
    if (!file)           { setError('Choose a file first.'); return; }
    if (!partsPerPlate)  { setError('Enter parts per plate.'); return; }
    if (!model)          { setError('Select a printer model.'); return; }
    if (amsSlots.length > 0 && amsSlot === '') {
      setError('Select an AMS slot or External Spool.'); return;
    }

    setUploading(true);
    setError(null);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('part_id', String(part.id));
    fd.append('parts_per_plate', partsPerPlate);
    fd.append('printer_model', model);
    if (amsSlots.length > 0) fd.append('ams_slot', amsSlot);

    try {
      const res  = await fetch('/api/gcodes/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Upload failed.');
      } else {
        setFile(null); setPPP(''); setModel(''); setAmsSlot(''); setAmsSlots([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
        onUploaded();
      }
    } catch (err) {
      setError(err.message);
    }
    setUploading(false);
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <label style={{ cursor: 'pointer' }}>
        <input ref={fileInputRef} type="file" accept=".bgcode,.gcode,.3mf" onChange={handleFileChange} style={{ display: 'none' }} />
        <span style={{
          ...inputSx,
          display: 'inline-block',
          maxWidth: 240,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          color: file ? '#e2e8f0' : '#475569',
        }}>
          {file ? file.name : 'Choose .gcode / .bgcode / .3mf…'}
        </span>
      </label>
      <input
        type="number"
        min={1}
        placeholder="Parts/plate"
        value={partsPerPlate}
        onChange={(e) => setPPP(e.target.value)}
        style={{ ...inputSx, width: 100 }}
      />
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        style={{ ...inputSx, width: 90 }}
      >
        <option value="">Model…</option>
        {modelOptions.map(m => <option key={m.model_id} value={m.model_id}>{m.label}</option>)}
      </select>
      {amsSlots.length > 0 && (
        <select
          value={amsSlot}
          onChange={(e) => setAmsSlot(e.target.value)}
          style={{ ...inputSx, width: 160 }}
        >
          <option value="">AMS slot…</option>
          {amsSlots.map(s => s.slot === -1
            ? <option key="ext" value="-1">External Spool{s.type ? ` — ${s.type}` : ''}</option>
            : <option key={s.slot} value={String(s.slot)}>Slot {s.slot} — {s.type || 'unknown'}</option>
          )}
        </select>
      )}
      <button
        onClick={handleUpload}
        disabled={uploading}
        style={{
          background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4,
          padding: '5px 14px', fontSize: 12, fontWeight: 600,
          cursor: uploading ? 'not-allowed' : 'pointer',
          opacity: uploading ? 0.7 : 1,
        }}
      >
        {uploading ? 'Uploading…' : 'Upload'}
      </button>
      {error && <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>{error}</p>}
    </div>
  );
}

function PartDetailsPanel({ part, gcodes, onRefresh, onSaved, onConfirm }) {
  const [have, setHave] = useState(String(part.completed_qty));
  const [need, setNeed] = useState(String(part.target_qty));
  const [saving, setSaving] = useState(false);
  const [qtyError, setQtyError] = useState(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft]     = useState('');
  const nameEscapedRef = useRef(false);

  const [printTimeDraft, setPrintTimeDraft] = useState(formatDurationForInput(part.print_time_seconds));
  const [materialDraft, setMaterialDraft]   = useState(formatMaterialForInput(part.material_grams));
  const [estimateError, setEstimateError]   = useState(null);
  const [savingEstimate, setSavingEstimate] = useState(false);
  const [parsing, setParsing]               = useState(false);

  useEffect(() => {
    setHave(String(part.completed_qty));
    setNeed(String(part.target_qty));
  }, [part.completed_qty, part.target_qty]);

  useEffect(() => {
    setPrintTimeDraft(formatDurationForInput(part.print_time_seconds));
    setMaterialDraft(formatMaterialForInput(part.material_grams));
  }, [part.print_time_seconds, part.material_grams]);

  async function saveName() {
    if (nameEscapedRef.current) { nameEscapedRef.current = false; return; }
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (!trimmed || trimmed === part.name) return;
    await fetch(`/api/parts/${part.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    onRefresh();
    onSaved?.('Saved');
  }

  async function parseFromGcode() {
    if (gcodes.length === 0) return;
    setParsing(true);
    setEstimateError(null);
    try {
      const res = await fetch(`/api/parts/${part.id}/parse-gcode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gcode_id: gcodes[0].id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEstimateError(data.error || 'Parse failed.');
      } else if (data.nothing_found) {
        setEstimateError(`No time or material data found in "${data.source}".`);
      } else {
        if (data.print_time_seconds != null) setPrintTimeDraft(formatDurationForInput(data.print_time_seconds));
        if (data.material_grams     != null) setMaterialDraft(formatMaterialForInput(data.material_grams));
        if (data.print_time_seconds == null || data.material_grams == null) {
          setEstimateError(
            `Partial parse from "${data.source}" — ` +
            [data.print_time_seconds == null && 'time not found', data.material_grams == null && 'material not found']
              .filter(Boolean).join(', ') + '.'
          );
        }
      }
    } catch (err) {
      setEstimateError(err.message);
    }
    setParsing(false);
  }

  async function saveEstimate() {
    setSavingEstimate(true);
    setEstimateError(null);
    const res = await fetch(`/api/parts/${part.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        print_time: printTimeDraft.trim() || null,
        material:   materialDraft.trim()  || null,
      }),
    });
    setSavingEstimate(false);
    if (res.ok) {
      onRefresh();
      onSaved?.('Estimate saved');
    } else {
      const d = await res.json();
      setEstimateError(d.error || 'Save failed.');
    }
  }

  async function saveQtys() {
    const newHave = parseInt(have, 10);
    const newNeed = parseInt(need, 10);
    if (isNaN(newHave) || newHave < 0) { setQtyError('Have must be 0 or more.'); return; }
    if (isNaN(newNeed) || newNeed < 1) { setQtyError('Need must be at least 1.'); return; }
    if (newHave === part.completed_qty && newNeed === part.target_qty) return;

    const wouldClose = newHave >= newNeed;
    if (wouldClose && part.status === 'open') {
      const ok = await onConfirm({
        title: 'Close Part',
        message: 'This will close the part and stop dispatching.',
        confirmLabel: 'Close Part',
        danger: true,
      });
      if (!ok) return;
    } else if (!wouldClose && part.status === 'closed') {
      const ok = await onConfirm({
        title: 'Reopen Part',
        message: 'This will reopen the part and resume dispatching.',
        confirmLabel: 'Reopen Part',
      });
      if (!ok) return;
    }

    setSaving(true);
    setQtyError(null);
    const res = await fetch(`/api/parts/${part.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed_qty: newHave, target_qty: newNeed }),
    });
    setSaving(false);
    if (res.ok) {
      onRefresh();
      onSaved?.('Saved');
    } else {
      const d = await res.json();
      setQtyError(d.error || 'Save failed.');
    }
  }

  async function deleteGcode(gcodeId) {
    const ok = await onConfirm({
      title: 'Delete G-code',
      message: 'Delete this G-code file?',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await fetch(`/api/gcodes/${gcodeId}`, { method: 'DELETE' });
    onRefresh();
  }

  const sectionLabel = {
    fontSize: 11, fontWeight: 700, color: '#475569',
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8,
  };

  return (
    <div style={{ background: '#0a0f1a', borderRadius: 6, padding: '14px 16px', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* Part name */}
      <div>
        <div style={sectionLabel}>Part Name</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {editingName ? (
            <input
              type="text"
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') saveName();
                if (e.key === 'Escape') { nameEscapedRef.current = true; setEditingName(false); }
              }}
              onBlur={saveName}
              autoFocus
              style={{ ...inputSx, fontSize: 14, fontWeight: 600, width: 220 }}
            />
          ) : (
            <>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{part.name}</span>
              <button
                onClick={() => { nameEscapedRef.current = false; setNameDraft(part.name); setEditingName(true); }}
                title="Rename part"
                style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1 }}
              >✎</button>
            </>
          )}
        </div>
      </div>

      {/* Quantities */}
      <div>
        <div style={sectionLabel}>Quantities</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ color: '#64748b', fontSize: 12 }}>Have (completed)</label>
            <input
              type="number" min={0} value={have}
              onChange={e => setHave(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveQtys()}
              style={{ ...inputSx, width: 90 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ color: '#64748b', fontSize: 12 }}>Need (target)</label>
            <input
              type="number" min={1} value={need}
              onChange={e => setNeed(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveQtys()}
              style={{ ...inputSx, width: 90 }}
            />
          </div>
          <button
            onClick={saveQtys}
            disabled={saving}
            style={{
              background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4,
              padding: '5px 14px', fontSize: 12, fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {qtyError && <p style={{ color: '#f87171', fontSize: 12, margin: '6px 0 0' }}>{qtyError}</p>}
      </div>

      {/* Print Estimate */}
      <div>
        <div style={sectionLabel}>Print Estimate (per part)</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ color: '#64748b', fontSize: 12 }}>Print time</label>
            <input
              type="text"
              placeholder='e.g. 2h15m, 90m, 1:30:00'
              value={printTimeDraft}
              onChange={e => setPrintTimeDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveEstimate()}
              style={{ ...inputSx, width: 150 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ color: '#64748b', fontSize: 12 }}>Material</label>
            <input
              type="text"
              placeholder='e.g. 45g, 1.2kg'
              value={materialDraft}
              onChange={e => setMaterialDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveEstimate()}
              style={{ ...inputSx, width: 120 }}
            />
          </div>
          {gcodes.length > 0 && (
            <button
              onClick={parseFromGcode}
              disabled={parsing}
              title={`Parse from ${gcodes[0].filename}`}
              style={{
                background: '#1f2937', color: '#94a3b8',
                border: '1px solid #2d3748', borderRadius: 4,
                padding: '5px 12px', fontSize: 12, cursor: parsing ? 'not-allowed' : 'pointer',
                opacity: parsing ? 0.7 : 1,
              }}
            >
              {parsing ? 'Parsing…' : 'Parse from file'}
            </button>
          )}
          <button
            onClick={saveEstimate}
            disabled={savingEstimate}
            style={{
              background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4,
              padding: '5px 14px', fontSize: 12, fontWeight: 600,
              cursor: savingEstimate ? 'not-allowed' : 'pointer',
              opacity: savingEstimate ? 0.7 : 1,
            }}
          >
            {savingEstimate ? 'Saving…' : 'Save'}
          </button>
        </div>
        {estimateError && (
          <p style={{ color: '#f87171', fontSize: 12, margin: '6px 0 0' }}>{estimateError}</p>
        )}
      </div>

      {/* G-code files */}
      <div>
        <div style={sectionLabel}>G-code Files</div>
        {gcodes.length === 0 && (
          <p style={{ color: '#475569', fontSize: 12, margin: 0 }}>No G-code files uploaded yet.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {gcodes.map(gc => (
            <div
              key={gc.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: '#0f172a', borderRadius: 4, padding: '5px 10px',
              }}
            >
              <span style={{
                fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0',
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {gc.filename}
              </span>
              <span style={{
                background: '#1e3a5f', color: '#60a5fa', borderRadius: 3,
                padding: '1px 6px', fontSize: 11, fontWeight: 700, flexShrink: 0,
              }}>
                {gc.printer_model}
              </span>
              <button
                onClick={() => deleteGcode(gc.id)}
                title="Delete G-code"
                style={{
                  background: 'none', border: 'none', color: '#ef4444',
                  cursor: 'pointer', padding: '0 2px', fontSize: 16, lineHeight: 1, flexShrink: 0,
                }}
              >×</button>
            </div>
          ))}
        </div>
      </div>

      {/* Upload */}
      <div>
        <div style={sectionLabel}>Upload G-code</div>
        <GcodeUploadPanel part={part} onUploaded={onRefresh} />
      </div>
    </div>
  );
}

export default function Projects() {
  const [showToast, toastEl]              = useToast();
  const [confirm, confirmModal]           = useConfirm();
  const [projects, setProjects]           = useState([]);
  const [loading, setLoading]             = useState(true);

  // Detail view
  const [selectedId, setSelectedId]       = useState(null);
  const [detailProject, setDetailProject] = useState(null);
  const [parts, setParts]                 = useState([]);
  const [gcodesMap, setGcodesMap]         = useState({});

  // New project form
  const [showNewForm, setShowNewForm]     = useState(false);
  const [newName, setNewName]             = useState('');
  const [newDesc, setNewDesc]             = useState('');

  // Add part form
  const [newPartName, setNewPartName]     = useState('');
  const [newPartQty, setNewPartQty]       = useState('');
  const [addingPart, setAddingPart]       = useState(false);

  // Details panels (set of open part IDs)
  const [openPanels, setOpenPanels]       = useState(new Set());

  // Inline rename
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft]     = useState('');
  // Tracks Escape press on project rename so onBlur doesn't trigger a save after cancelling
  const renameEscapedRef = useRef(false);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error('Failed to fetch projects');
      setProjects(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const fetchDetail = useCallback(async (projectId) => {
    const [projRes, partsRes] = await Promise.all([
      fetch(`/api/projects/${projectId}`),
      fetch(`/api/parts?project_id=${projectId}`),
    ]);
    const proj      = await projRes.json();
    const partsData = await partsRes.json();

    const gcodesArrays = await Promise.all(
      partsData.map(p => fetch(`/api/gcodes?part_id=${p.id}`).then(r => r.json()))
    );
    const gcMap = {};
    partsData.forEach((p, i) => { gcMap[p.id] = gcodesArrays[i]; });

    setDetailProject(proj);
    setParts(partsData);
    setGcodesMap(gcMap);
  }, []);

  useEffect(() => {
    if (selectedId != null) fetchDetail(selectedId);
  }, [selectedId, fetchDetail]);

  async function moveProject(projectId, direction) {
    const idx = projects.findIndex(p => p.id === projectId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= projects.length) return;

    const reordered = [...projects];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    setProjects(reordered);

    await fetch('/api/projects/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: reordered.map(p => p.id) }),
    });
  }

  async function createProject() {
    if (!newName.trim()) return;
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || undefined }),
    });
    if (res.ok) {
      setNewName(''); setNewDesc(''); setShowNewForm(false);
      await fetchProjects();
      showToast('Project created');
    }
  }

  async function handleStatusTransition(action) {
    const id = detailProject.id;

    if (action === 'complete') {
      const partCount = parts.filter(p => p.status === 'open').length;
      const msg = partCount > 0
        ? `${partCount} open part(s) will be closed and any queued jobs cancelled.`
        : undefined;
      const ok = await confirm({
        title: `Mark "${detailProject.name}" Complete`,
        message: msg,
        confirmLabel: 'Mark Complete',
        danger: true,
      });
      if (!ok) return;

      await fetch(`/api/projects/${id}/complete`, { method: 'POST' });
      await Promise.all([fetchDetail(id), fetchProjects()]);
      return;
    }

    if (action === 'reactivate') {
      const ok = await confirm({
        title: `Re-activate "${detailProject.name}"`,
        message: 'Parts with remaining qty will be reopened and dispatch will resume.',
        confirmLabel: 'Re-activate',
      });
      if (!ok) return;

      const res  = await fetch(`/api/projects/${id}/reactivate`, { method: 'POST' });
      const data = await res.json();

      if (data.nothing_to_reopen) {
        showToast('All parts are at target qty — adjust quantities first.', 'warning');
        return;
      }

      await Promise.all([fetchDetail(id), fetchProjects()]);
      return;
    }

    // Standard transitions: 'active' (activate/resume) or 'paused'
    await fetch(`/api/projects/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: action }),
    });
    if (action === 'active') {
      fetch('/api/scheduler/dispatch', { method: 'POST' }).catch(() => {});
    }
    await Promise.all([fetchDetail(id), fetchProjects()]);
  }

  async function movePart(partId, direction) {
    const idx = parts.findIndex(p => p.id === partId);
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= parts.length) return;

    const reordered = [...parts];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
    setParts(reordered);

    await fetch('/api/parts/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: reordered.map(p => p.id) }),
    });
  }

  async function deletePart(partId, partName) {
    const ok = await confirm({
      title: 'Delete Part',
      message: `Delete "${partName}"? This will also delete its G-code files and cannot be undone.`,
      confirmLabel: 'Delete Part',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/parts/${partId}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json();
      showToast(d.error || 'Delete failed.', 'error');
      return;
    }
    await fetchDetail(selectedId);
  }

  async function addPart() {
    if (!newPartName.trim() || !newPartQty) return;
    setAddingPart(true);
    await fetch('/api/parts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: selectedId, name: newPartName.trim(), target_qty: parseInt(newPartQty, 10) }),
    });
    setNewPartName(''); setNewPartQty('');
    setAddingPart(false);
    await fetchDetail(selectedId);
    showToast('Part added');
  }

  function togglePanel(partId) {
    setOpenPanels(prev => {
      const next = new Set(prev);
      next.has(partId) ? next.delete(partId) : next.add(partId);
      return next;
    });
  }

  function goBack() {
    setSelectedId(null); setDetailProject(null); setParts([]); setGcodesMap({});
    setOpenPanels(new Set());
  }

  async function saveProjectName() {
    if (renameEscapedRef.current) { renameEscapedRef.current = false; return; }
    const trimmed = projectNameDraft.trim();
    setEditingProjectName(false);
    if (!trimmed || trimmed === detailProject.name) return;
    await fetch(`/api/projects/${detailProject.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    await Promise.all([fetchDetail(detailProject.id), fetchProjects()]);
    showToast('Saved');
  }


  // ─── List view ───────────────────────────────────────────────────────────────
  if (selectedId == null) {
    return (
      <div>
        {toastEl}
        {confirmModal}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Projects</h1>
          <button
            onClick={() => setShowNewForm(v => !v)}
            style={{ background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            + New Project
          </button>
        </div>

        {showNewForm && (
          <div style={{ background: '#1e2433', border: '1px solid #2d3748', borderRadius: 8, padding: 16, marginBottom: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ color: '#94a3b8', fontSize: 12 }}>Name *</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Project name"
                onKeyDown={(e) => e.key === 'Enter' && createProject()}
                style={{ ...inputSx, width: 220 }}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ color: '#94a3b8', fontSize: 12 }}>Description</label>
              <input
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Optional"
                style={{ ...inputSx, width: 280 }}
              />
            </div>
            <button
              onClick={createProject}
              style={{ background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              Create
            </button>
            <button
              onClick={() => { setShowNewForm(false); setNewName(''); setNewDesc(''); }}
              style={{ background: '#1f2937', color: '#9ca3af', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 13, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        )}

        {loading && <p style={{ color: '#64748b' }}>Loading…</p>}
        {!loading && projects.length === 0 && (
          <p style={{ color: '#64748b' }}>No projects yet. Create one above.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projects.map(p => {
            const s = PROJECT_STATUS[p.status] || PROJECT_STATUS.draft;
            return (
              <div
                key={p.id}
                style={{
                  background: '#1e2433', border: '1px solid #2d3748', borderRadius: 8,
                  padding: '12px 16px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                }}
              >
                {/* Priority arrows — stop propagation so clicks don't open the project */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => moveProject(p.id, 'up')}
                    disabled={projects.indexOf(p) === 0}
                    title="Increase priority"
                    style={{
                      background: 'none', border: 'none', padding: 0, fontSize: 10, lineHeight: 1,
                      color: projects.indexOf(p) === 0 ? '#1f2937' : '#475569',
                      cursor: projects.indexOf(p) === 0 ? 'default' : 'pointer',
                    }}
                  >▲</button>
                  <button
                    onClick={() => moveProject(p.id, 'down')}
                    disabled={projects.indexOf(p) === projects.length - 1}
                    title="Decrease priority"
                    style={{
                      background: 'none', border: 'none', padding: 0, fontSize: 10, lineHeight: 1,
                      color: projects.indexOf(p) === projects.length - 1 ? '#1f2937' : '#475569',
                      cursor: projects.indexOf(p) === projects.length - 1 ? 'default' : 'pointer',
                    }}
                  >▼</button>
                </div>

                {/* Name + description — clicking here navigates */}
                <div style={{ minWidth: 0, flex: 1, cursor: 'pointer' }} onClick={() => setSelectedId(p.id)}>
                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </div>
                  {p.description && (
                    <div style={{ color: '#64748b', fontSize: 12 }}>{p.description}</div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0, cursor: 'pointer' }} onClick={() => setSelectedId(p.id)}>
                  <span style={{ background: s.bg, color: s.text, border: `1px solid ${s.text}40`, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
                    {s.label}
                  </span>
                  <span style={{ color: '#475569', fontSize: 13 }}>→</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── Detail view ─────────────────────────────────────────────────────────────
  if (!detailProject) return <p style={{ color: '#64748b' }}>Loading…</p>;

  return (
    <div>
      {toastEl}
      {confirmModal}
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <button
          onClick={goBack}
          style={{ background: '#1f2937', color: '#94a3b8', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 13, cursor: 'pointer' }}
        >
          ← Projects
        </button>
        {editingProjectName ? (
          <input
            type="text"
            value={projectNameDraft}
            onChange={e => setProjectNameDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') saveProjectName();
              if (e.key === 'Escape') { renameEscapedRef.current = true; setEditingProjectName(false); }
            }}
            onBlur={saveProjectName}
            autoFocus
            style={{ ...inputSx, fontSize: 20, fontWeight: 700, width: 280 }}
          />
        ) : (
          <>
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>{detailProject.name}</h1>
            <button
              onClick={() => { renameEscapedRef.current = false; setProjectNameDraft(detailProject.name); setEditingProjectName(true); }}
              title="Rename project"
              style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
            >✎</button>
          </>
        )}
        <StatusDropdown project={detailProject} onTransition={handleStatusTransition} />
      </div>

      {/* Parts */}
      <h2 style={{ fontSize: 14, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
        Parts
      </h2>

      {parts.length === 0 && (
        <p style={{ color: '#475569', fontSize: 14, marginBottom: 16 }}>No parts yet. Add one below.</p>
      )}

      {parts.map(part => {
        const partGs    = gcodesMap[part.id] || [];
        const activeQty = part.active_qty || 0;
        const scale     = Math.max(part.target_qty, part.completed_qty + activeQty);
        const completedPct = scale > 0 ? (part.completed_qty / scale) * 100 : 0;
        const activePct    = scale > 0 ? (activeQty / scale) * 100 : 0;
        const isOver       = part.completed_qty + activeQty > part.target_qty;
        const targetTickPct = isOver && scale > 0 ? (part.target_qty / scale) * 100 : null;
        const pct       = part.target_qty > 0 ? Math.round((part.completed_qty / part.target_qty) * 100) : 0;
        const partSt    = PART_STATUS[part.status] || PART_STATUS.open;
        const panelOpen = openPanels.has(part.id);

        return (
          <div key={part.id} style={{ background: '#1e2433', border: '1px solid #2d3748', borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>

              {/* Name + order buttons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: 200, flexShrink: 0 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <button
                    onClick={() => movePart(part.id, 'up')}
                    disabled={parts.indexOf(part) === 0}
                    title="Move up"
                    style={{
                      background: 'none', border: 'none', color: parts.indexOf(part) === 0 ? '#1f2937' : '#475569',
                      cursor: parts.indexOf(part) === 0 ? 'default' : 'pointer',
                      padding: 0, fontSize: 10, lineHeight: 1,
                    }}
                  >▲</button>
                  <button
                    onClick={() => movePart(part.id, 'down')}
                    disabled={parts.indexOf(part) === parts.length - 1}
                    title="Move down"
                    style={{
                      background: 'none', border: 'none', color: parts.indexOf(part) === parts.length - 1 ? '#1f2937' : '#475569',
                      cursor: parts.indexOf(part) === parts.length - 1 ? 'default' : 'pointer',
                      padding: 0, fontSize: 10, lineHeight: 1,
                    }}
                  >▼</button>
                </div>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{part.name}</span>
              </div>

              {/* Progress */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8', marginBottom: 3 }}>
                  <span>
                    {part.completed_qty}
                    {activeQty > 0 && (
                      <span style={{ color: '#3b82f6', marginLeft: 4 }}>+{activeQty} printing</span>
                    )}
                    {' / '}
                    {part.target_qty}
                  </span>
                  <span>{pct}%</span>
                </div>
                <div style={{ position: 'relative', background: '#0f172a', borderRadius: 4, height: 8 }}>
                  {/* Completed segment */}
                  <div style={{
                    position: 'absolute', left: 0, top: 0, height: '100%',
                    width: `${completedPct}%`,
                    background: '#22c55e',
                    borderRadius: activePct > 0 ? '3px 0 0 3px' : 3,
                    transition: 'width 0.3s',
                  }} />
                  {/* Printing segment */}
                  {activePct > 0 && (
                    <div style={{
                      position: 'absolute', left: `${completedPct}%`, top: 0, height: '100%',
                      width: `${activePct}%`,
                      background: '#3b82f6',
                      borderRadius: '0 3px 3px 0',
                      transition: 'width 0.3s',
                    }} />
                  )}
                  {/* Target tick when active jobs push past the goal */}
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

              {/* Status badge — fixed width so bar length is consistent across all parts */}
              <span style={{
                background: partSt.bg, color: partSt.text, borderRadius: 4,
                padding: '2px 8px', fontSize: 11, fontWeight: 700,
                width: 54, flexShrink: 0, textAlign: 'center',
              }}>
                {partSt.label}
              </span>

              {/* Details toggle */}
              <button
                onClick={() => togglePanel(part.id)}
                style={{
                  background: panelOpen ? '#1e3a5f' : '#1f2937',
                  color: panelOpen ? '#60a5fa' : '#64748b',
                  border: `1px solid ${panelOpen ? '#1e40af' : '#2d3748'}`,
                  borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer', flexShrink: 0,
                }}
              >
                {panelOpen ? '▲ Details' : '▼ Details'}
              </button>

              {/* Delete part */}
              <button
                onClick={() => deletePart(part.id, part.name)}
                title="Delete part"
                style={{
                  background: 'none', border: 'none', color: '#ef4444',
                  cursor: 'pointer', padding: '0 2px', fontSize: 18, lineHeight: 1, flexShrink: 0,
                }}
              >×</button>
            </div>

            {panelOpen && (
              <PartDetailsPanel
                part={part}
                gcodes={partGs}
                onRefresh={() => fetchDetail(selectedId)}
                onSaved={showToast}
                onConfirm={confirm}
              />
            )}
          </div>
        );
      })}

      {/* Add Part form */}
      <div style={{ background: '#1e2433', border: '1px solid #2d3748', borderRadius: 8, padding: 16, marginTop: 8 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
          Add Part
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ color: '#64748b', fontSize: 12 }}>Part name *</label>
            <input
              type="text"
              value={newPartName}
              onChange={(e) => setNewPartName(e.target.value)}
              placeholder="e.g. Left bracket"
              onKeyDown={(e) => e.key === 'Enter' && addPart()}
              style={{ ...inputSx, width: 220 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ color: '#64748b', fontSize: 12 }}>Target qty *</label>
            <input
              type="number"
              min={1}
              value={newPartQty}
              onChange={(e) => setNewPartQty(e.target.value)}
              placeholder="100"
              onKeyDown={(e) => e.key === 'Enter' && addPart()}
              style={{ ...inputSx, width: 100 }}
            />
          </div>
          <button
            onClick={addPart}
            disabled={addingPart}
            style={{
              background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4,
              padding: '6px 14px', fontSize: 13, fontWeight: 600,
              cursor: addingPart ? 'not-allowed' : 'pointer',
              opacity: addingPart ? 0.7 : 1,
            }}
          >
            Add Part
          </button>
        </div>
      </div>
    </div>
  );
}
