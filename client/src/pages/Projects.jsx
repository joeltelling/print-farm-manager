import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../useToast';
import EmptyState from '../components/EmptyState';
import { useConfirm } from '../useConfirm';
import BulkImportPanel from '../components/BulkImportPanel';

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
  draft:     [{ label: 'Activate',        action: 'active' },
              { label: 'Delete project',  action: 'delete', danger: true }],
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
  open:   { bg: '#1e3a5f', text: '#60a5fa', label: 'Open',     help: 'Still needs parts — the scheduler will keep dispatching jobs for it' },
  closed: { bg: '#14532d', text: '#86efac', label: 'Complete', help: 'Target quantity reached — no more jobs will dispatch for this part' },
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

const uploadLabelSx = {
  fontSize: 10.5,
  fontWeight: 600,
  color: '#64748b',
  marginBottom: 3,
};

function GcodeUploadPanel({ part, onUploaded, filamentTypes, filamentColors, projectMaterial, projectColor, projectGroups, groups }) {
  const [file, setFile]             = useState(null);
  const [partsPerPlate, setPPP]     = useState('');
  const [model, setModel]           = useState('');
  const [error, setError]           = useState(null);
  const [uploading, setUploading]   = useState(false);
  const [uploadPct, setUploadPct]   = useState(null);
  const fileInputRef                = useRef(null);
  const [modelOptions, setModelOptions] = useState([]);
  const [amsSlots, setAmsSlots]     = useState([]);
  const [amsSlot, setAmsSlot]       = useState('');
  const [selectedGroups, setSelectedGroups]   = useState([]);  // [] = all groups (or inherits project)
  const [requiredMaterial, setRequiredMaterial] = useState('');
  const [requiredColor, setRequiredColor]       = useState('');

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setModelOptions).catch(() => {});
  }, []);

  useEffect(() => {
    if (!model) { setAmsSlots([]); setAmsSlot(''); return; }
    fetch(`/api/printers/ams?model=${encodeURIComponent(model)}`)
      .then(r => r.json())
      .then(slots => { setAmsSlots(slots); setAmsSlot(''); })
      .catch(() => { setAmsSlots([]); setAmsSlot(''); });
  }, [model]);

  const [parsedEstPrintSecs, setParsedEstPrintSecs] = useState(null);
  const [parsedMaterialGrams, setParsedMaterialGrams] = useState(null);

  async function handleFileChange(e) {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setError(null);
    setParsedEstPrintSecs(null);
    setParsedMaterialGrams(null);
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
        if (data.est_print_secs != null) setParsedEstPrintSecs(data.est_print_secs);
      }
      if (data.material_grams != null) setParsedMaterialGrams(data.material_grams);
    } catch (_) {}
  }

  function toggleGroup(g) {
    setSelectedGroups(prev =>
      prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]
    );
  }

  const isBambuModel = !!modelOptions.find(m => m.model_id === model && m.connector === 'bambu');
  const bambuNeedsThreemf = isBambuModel && file && !file.name.toLowerCase().endsWith('.3mf');

  async function handleUpload() {
    if (!file)              { setError('Choose a file first.'); return; }
    if (bambuNeedsThreemf)  { setError('Bambu printers require a .3mf file.'); return; }
    if (!partsPerPlate)     { setError('Enter parts per plate.'); return; }
    if (!model)             { setError('Select a printer model.'); return; }
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
    if (parsedEstPrintSecs != null) fd.append('est_print_secs', String(parsedEstPrintSecs));
    if (parsedMaterialGrams != null) fd.append('material_grams', String(parsedMaterialGrams));
    if (selectedGroups.length > 0) fd.append('allowed_groups', JSON.stringify(selectedGroups));
    if (requiredMaterial.trim()) fd.append('required_material', requiredMaterial.trim());
    if (requiredColor.trim())    fd.append('required_color',    requiredColor.trim());

    try {
      // XHR instead of fetch so we can report upload progress on large files
      const { ok, data } = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/gcodes/upload');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          let body = {};
          try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error body */ }
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: body });
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(fd);
      });
      if (!ok) {
        setError(data.error || 'Upload failed.');
      } else {
        setFile(null); setPPP(''); setModel(''); setAmsSlot(''); setAmsSlots([]);
        setParsedEstPrintSecs(null); setParsedMaterialGrams(null);
        setSelectedGroups([]); setRequiredMaterial(''); setRequiredColor('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        onUploaded();
      }
    } catch (err) {
      setError(err.message);
    }
    setUploading(false);
    setUploadPct(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={uploadLabelSx}>File *</div>
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
        </div>
        <div>
          <div style={uploadLabelSx}>Parts per plate *</div>
          <input
            type="number"
            min={1}
            placeholder="e.g. 4"
            title="How many finished parts one plate of this G-code produces — each good print credits this many toward the part's target"
            value={partsPerPlate}
            onChange={(e) => setPPP(e.target.value)}
            style={{ ...inputSx, width: 110 }}
          />
        </div>
        <div>
          <div style={uploadLabelSx}>Printer model *</div>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{ ...inputSx, width: 110 }}
          >
            <option value="">Select…</option>
            {modelOptions.map(m => <option key={m.model_id} value={m.model_id}>{m.label}</option>)}
          </select>
        </div>
        {amsSlots.length > 0 && (
          <div>
            <div style={uploadLabelSx}>AMS slot *</div>
            <select
              value={amsSlot}
              onChange={(e) => setAmsSlot(e.target.value)}
              style={{ ...inputSx, width: 160 }}
            >
              <option value="">Select…</option>
              {amsSlots.map(s => s.slot === -1
                ? <option key="ext" value="-1">External Spool{s.type ? ` — ${s.type}` : ''}</option>
                : <option key={s.slot} value={String(s.slot)}>Slot {s.slot} — {s.type || 'unknown'}</option>
              )}
            </select>
          </div>
        )}
        <button
          onClick={handleUpload}
          disabled={uploading || bambuNeedsThreemf}
          style={{
            background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4,
            padding: '6px 14px', fontSize: 12, fontWeight: 600,
            cursor: (uploading || bambuNeedsThreemf) ? 'not-allowed' : 'pointer',
            opacity: (uploading || bambuNeedsThreemf) ? 0.5 : 1,
          }}
        >
          {uploading ? (uploadPct != null ? `Uploading… ${uploadPct}%` : 'Uploading…') : 'Upload'}
        </button>
      </div>

      {uploading && uploadPct != null && (
        <div style={{ background: '#0f172a', borderRadius: 3, height: 5, overflow: 'hidden' }}>
          <div style={{ background: '#3b82f6', height: '100%', width: `${uploadPct}%`, transition: 'width 0.2s' }} />
        </div>
      )}

      <p style={{ margin: 0, fontSize: 11, color: '#475569' }}>
        Tip: filenames with a model, print time, and weight (e.g. <span className="mono">bracket_MK4S_2h30m_45g.gcode</span>) auto-fill these fields — you can adjust them after upload.
      </p>

      {bambuNeedsThreemf && (
        <p style={{ margin: 0, fontSize: 12, color: '#b45309', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 4, padding: '5px 10px' }}>
          Bambu printers require a <strong>.3mf</strong> file exported from Bambu Studio or Orca Slicer — plain .gcode files are not supported.
        </p>
      )}

      {/* Targeting — material, color, groups */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span
          title="Optional: restrict which printers can run this file. Material/color must match what an operator marked as loaded on the printer; groups restrict dispatch to those printer groups. Leave everything blank to allow any matching printer."
          style={{ fontSize: 11, color: '#475569', flexShrink: 0, cursor: 'help', borderBottom: '1px dotted #334155' }}
        >Targeting:</span>
        {filamentTypes.length > 0 ? (
          <select
            value={requiredMaterial}
            onChange={e => { setRequiredMaterial(e.target.value); setRequiredColor(''); }}
            style={{ ...inputSx, width: 160, fontSize: 12 }}
          >
            <option value="">{projectMaterial ? `— project: ${projectMaterial} —` : '— any material —'}</option>
            {filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        ) : (
          <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>No materials in library</span>
        )}
        {(() => {
          const effectiveMat = requiredMaterial || projectMaterial;
          const colorOptions = filamentColors.filter(c => c.type_name === effectiveMat);
          if (!effectiveMat || colorOptions.length === 0) return null;
          return (
            <select
              value={requiredColor}
              onChange={e => setRequiredColor(e.target.value)}
              style={{ ...inputSx, width: 160, fontSize: 12 }}
            >
              <option value="">{projectColor ? `— project: ${projectColor} —` : '— any color —'}</option>
              {colorOptions.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          );
        })()}
        {groups.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#475569' }}>Groups:</span>
            {groups.map(g => (
              <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: 12, color: selectedGroups.includes(g) ? '#7dd3fc' : '#64748b' }}>
                <input
                  type="checkbox"
                  checked={selectedGroups.includes(g)}
                  onChange={() => toggleGroup(g)}
                  style={{ accentColor: '#3b82f6' }}
                />
                {g}
              </label>
            ))}
            {selectedGroups.length === 0 && (
              <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>
                {projectGroups?.length > 0 ? `(inherits project: ${projectGroups.join(', ')})` : 'all groups'}
              </span>
            )}
          </div>
        )}
      </div>

      {error && <p style={{ color: '#f87171', fontSize: 12, margin: 0 }}>{error}</p>}
    </div>
  );
}

function GcodeEstimateRow({ gc, onDelete, onSaved, filamentTypes, filamentColors, projectMaterial, projectColor, projectGroups, groups }) {
  const [timeDraft, setTimeDraft]         = useState(formatDurationForInput(gc.est_print_secs));
  const [materialDraft, setMaterialDraft] = useState(formatMaterialForInput(gc.material_grams));
  const [parsing, setParsing]             = useState(false);
  const [parsingGcode, setParsingGcode]   = useState(false);
  const [saving, setSaving]               = useState(false);
  const [error, setError]                 = useState(null);
  const [selectedGroups, setSelectedGroups]   = useState(() => {
    try { return gc.allowed_groups ? JSON.parse(gc.allowed_groups) : []; } catch (_) { return []; }
  });
  const [reqMaterial, setReqMaterial] = useState(gc.required_material || '');
  const [reqColor, setReqColor]       = useState(gc.required_color || '');

  useEffect(() => {
    setTimeDraft(formatDurationForInput(gc.est_print_secs));
    setMaterialDraft(formatMaterialForInput(gc.material_grams));
    setReqMaterial(gc.required_material || '');
    setReqColor(gc.required_color || '');
    try { setSelectedGroups(gc.allowed_groups ? JSON.parse(gc.allowed_groups) : []); } catch (_) { setSelectedGroups([]); }
  }, [gc.est_print_secs, gc.material_grams, gc.required_material, gc.required_color, gc.allowed_groups]);

  function toggleGroup(g) {
    setSelectedGroups(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);
  }

  async function parseFromFilename() {
    setParsing(true);
    setError(null);
    try {
      const res = await fetch('/api/gcodes/parse-filename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: gc.filename }),
      });
      const data = await res.json();
      if (data.est_print_secs != null) setTimeDraft(formatDurationForInput(data.est_print_secs));
      if (data.material_grams != null) setMaterialDraft(formatMaterialForInput(data.material_grams));
      if (data.est_print_secs == null && data.material_grams == null) {
        setError('No time or material data found in filename.');
      }
    } catch (err) {
      setError(err.message);
    }
    setParsing(false);
  }

  async function parseFromGcode() {
    setParsingGcode(true);
    setError(null);
    try {
      const res = await fetch(`/api/gcodes/${gc.id}/parse`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Parse failed'); return; }
      if (data.est_print_secs != null) setTimeDraft(formatDurationForInput(data.est_print_secs));
      if (data.material_grams != null) setMaterialDraft(formatMaterialForInput(data.material_grams));
      if (data.est_print_secs == null && data.material_grams == null) {
        setError('No print time or filament data found in gcode file.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setParsingGcode(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/gcodes/${gc.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        print_time:       timeDraft.trim()     || null,
        material_grams:   materialDraft.trim() || null,
        allowed_groups:   selectedGroups.length > 0 ? JSON.stringify(selectedGroups) : null,
        required_material: reqMaterial.trim() || null,
        required_color:    reqColor.trim()    || null,
      }),
    });
    setSaving(false);
    if (res.ok) {
      onSaved?.('Saved');
    } else {
      const d = await res.json();
      setError(d.error || 'Save failed.');
    }
  }

  return (
    <div style={{ background: '#0f172a', borderRadius: 4, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
          onClick={onDelete}
          title="Delete G-code"
          aria-label={`Delete G-code ${gc.filename}`}
          style={{
            background: 'none', border: 'none', color: '#ef4444',
            cursor: 'pointer', padding: '4px 6px', fontSize: 16, lineHeight: 1, flexShrink: 0,
          }}
        >×</button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{gc.parts_per_plate}x</span>
        <span style={{ color: '#475569', fontSize: 11, flexShrink: 0 }}>per plate:</span>
        <input
          type="text"
          placeholder="time e.g. 2h15m"
          value={timeDraft}
          onChange={e => setTimeDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          style={{ ...inputSx, width: 110, fontSize: 12 }}
        />
        <input
          type="text"
          placeholder="material e.g. 45g"
          value={materialDraft}
          onChange={e => setMaterialDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          style={{ ...inputSx, width: 110, fontSize: 12 }}
        />
        <button
          onClick={parseFromFilename}
          disabled={parsing || parsingGcode}
          title="Re-read print time and material weight from the filename (e.g. …_2h30m_45g.gcode)"
          style={{
            background: '#1f2937', color: '#94a3b8',
            border: '1px solid #2d3748', borderRadius: 4,
            padding: '5px 10px', fontSize: 12, cursor: (parsing || parsingGcode) ? 'not-allowed' : 'pointer',
            opacity: (parsing || parsingGcode) ? 0.7 : 1, flexShrink: 0,
          }}
        >
          {parsing ? 'Parsing…' : 'Parse filename'}
        </button>
        <button
          onClick={parseFromGcode}
          disabled={parsing || parsingGcode}
          title="Parse the gcode file content for print time and filament usage metadata"
          style={{
            background: '#1f2937', color: '#94a3b8',
            border: '1px solid #2d3748', borderRadius: 4,
            padding: '5px 10px', fontSize: 12, cursor: (parsing || parsingGcode) ? 'not-allowed' : 'pointer',
            opacity: (parsing || parsingGcode) ? 0.7 : 1, flexShrink: 0,
          }}
        >
          {parsingGcode ? 'Parsing…' : 'Parse G-code'}
        </button>
        <button
          onClick={save}
          disabled={saving}
          style={{
            background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4,
            padding: '4px 10px', fontSize: 11, fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.7 : 1, flexShrink: 0,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Targeting row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          title="Optional: restrict which printers can run this file. Material/color must match what an operator marked as loaded on the printer; groups restrict dispatch to those printer groups. Leave everything blank to allow any matching printer."
          style={{ fontSize: 11, color: '#475569', flexShrink: 0, cursor: 'help', borderBottom: '1px dotted #334155' }}
        >Targeting:</span>
        {filamentTypes.length > 0 ? (
          <select
            value={reqMaterial}
            onChange={e => { setReqMaterial(e.target.value); setReqColor(''); }}
            style={{ ...inputSx, width: 160, fontSize: 12 }}
          >
            <option value="">{projectMaterial ? `— project: ${projectMaterial} —` : '— any material —'}</option>
            {filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        ) : (
          <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>No materials in library</span>
        )}
        {(() => {
          const effectiveMat = reqMaterial || projectMaterial;
          const colorOptions = filamentColors.filter(c => c.type_name === effectiveMat);
          if (!effectiveMat || colorOptions.length === 0) return null;
          return (
            <select
              value={reqColor}
              onChange={e => setReqColor(e.target.value)}
              style={{ ...inputSx, width: 160, fontSize: 12 }}
            >
              <option value="">{projectColor ? `— project: ${projectColor} —` : '— any color —'}</option>
              {colorOptions.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          );
        })()}
        {groups.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: '#475569' }}>Groups:</span>
            {groups.map(g => (
              <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: 12, color: selectedGroups.includes(g) ? '#7dd3fc' : '#64748b' }}>
                <input
                  type="checkbox"
                  checked={selectedGroups.includes(g)}
                  onChange={() => toggleGroup(g)}
                  style={{ accentColor: '#3b82f6' }}
                />
                {g}
              </label>
            ))}
            {selectedGroups.length === 0 && (
              <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>
                {projectGroups?.length > 0 ? `(inherits project: ${projectGroups.join(', ')})` : 'all groups'}
              </span>
            )}
          </div>
        )}
      </div>

      {error && <p style={{ color: '#f87171', fontSize: 11, margin: 0 }}>{error}</p>}
    </div>
  );
}

function PartDetailsPanel({ part, gcodes, onRefresh, onSaved, onConfirm, filamentTypes, filamentColors, projectMaterial, projectColor, projectGroups, groups }) {
  const [have, setHave] = useState(String(part.completed_qty));
  const [need, setNeed] = useState(String(part.target_qty));
  const [saving, setSaving] = useState(false);
  const [qtyError, setQtyError] = useState(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft]     = useState('');
  const nameEscapedRef = useRef(false);

  // Dispatch diagnostic — "why isn't this printing?"
  const [dispatchCheck, setDispatchCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  async function runDispatchCheck() {
    setChecking(true);
    try {
      const res  = await fetch(`/api/parts/${part.id}/dispatch-status`);
      const data = await res.json();
      setDispatchCheck(res.ok ? data : { dispatchable: false, reasons: [data.error || 'Check failed'] });
    } catch (err) {
      setDispatchCheck({ dispatchable: false, reasons: [err.message] });
    }
    setChecking(false);
  }

  useEffect(() => {
    setHave(String(part.completed_qty));
    setNeed(String(part.target_qty));
  }, [part.completed_qty, part.target_qty]);

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

      {/* G-code files with per-gcode estimates */}
      <div>
        <div style={sectionLabel}>G-code Files</div>
        {gcodes.length === 0 && (
          <p style={{ color: '#475569', fontSize: 12, margin: 0 }}>No G-code files uploaded yet.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {gcodes.map(gc => (
            <GcodeEstimateRow
              key={gc.id}
              gc={gc}
              onDelete={() => deleteGcode(gc.id)}
              onSaved={onSaved}
              filamentTypes={filamentTypes}
              filamentColors={filamentColors}
              projectMaterial={projectMaterial}
              projectColor={projectColor}
              projectGroups={projectGroups}
              groups={groups}
            />
          ))}
        </div>
      </div>

      {/* Upload */}
      <div>
        <div style={sectionLabel}>Upload G-code</div>
        <GcodeUploadPanel
          part={part}
          onUploaded={onRefresh}
          filamentTypes={filamentTypes}
          filamentColors={filamentColors}
          projectMaterial={projectMaterial}
          projectColor={projectColor}
          projectGroups={projectGroups}
          groups={groups}
        />
      </div>

      {/* Dispatch diagnostic */}
      <div>
        <button
          onClick={runDispatchCheck}
          disabled={checking}
          style={{
            background: '#1f2937', color: '#94a3b8', border: '1px solid #2d3748',
            borderRadius: 4, padding: '5px 12px', fontSize: 12, cursor: checking ? 'wait' : 'pointer',
          }}
        >
          {checking ? 'Checking…' : "Why isn't this printing?"}
        </button>
        {dispatchCheck && (
          <div style={{
            marginTop: 8, borderRadius: 6, padding: '8px 12px', fontSize: 12, lineHeight: 1.6,
            background: dispatchCheck.dispatchable ? '#14532d' : '#1a1f2e',
            border: `1px solid ${dispatchCheck.dispatchable ? '#166534' : '#7c5806'}`,
            color: dispatchCheck.dispatchable ? '#86efac' : '#fbbf24',
          }}>
            {dispatchCheck.dispatchable ? (
              <>
                Ready to dispatch — a matching idle printer will pick this up on the next sweep.
                {dispatchCheck.notes?.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#a3b3c9' }}>
                    {dispatchCheck.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {dispatchCheck.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
          </div>
        )}
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

  // Bulk import toggle
  const [showBulkImport, setShowBulkImport] = useState(false);

  // Details panels (set of open part IDs)
  const [openPanels, setOpenPanels]       = useState(new Set());

  // Inline rename
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft]     = useState('');
  // Tracks Escape press on project rename so onBlur doesn't trigger a save after cancelling
  const renameEscapedRef = useRef(false);

  // Duplicate modal
  const [dupModal,      setDupModal]      = useState(null); // null | { id }
  const [dupName,       setDupName]       = useState('');
  const [duplicating,   setDuplicating]   = useState(false);

  // Filament library and group registry: fetched once here, passed down to
  // avoid per-gcode-row fetches. The group registry is model-independent (a
  // group is a persisted entity, not derived from which printers currently
  // carry it), so unlike the old per-model /api/printers/groups call this
  // never needs to re-fetch when a gcode's target model changes.
  const [filamentTypes,  setFilamentTypes]  = useState([]);
  const [filamentColors, setFilamentColors] = useState([]);
  const [allGroups,      setAllGroups]      = useState([]);

  useEffect(() => {
    fetch('/api/filaments/types').then(r => r.json()).then(setFilamentTypes).catch(() => {});
    fetch('/api/filaments/colors').then(r => r.json()).then(setFilamentColors).catch(() => {});
    fetch('/api/groups').then(r => r.json()).then(groups => setAllGroups(groups.map(g => g.name))).catch(() => {});
  }, []);

  // Drag-and-drop reorder state
  const [projectDragSrc,  setProjectDragSrc]  = useState(null);
  const [projectDragOver, setProjectDragOver] = useState(null);
  const [partDragSrc,     setPartDragSrc]     = useState(null);
  const [partDragOver,    setPartDragOver]    = useState(null);

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

  function dropProject(targetId) {
    setProjectDragOver(null);
    if (!projectDragSrc || projectDragSrc === targetId) { setProjectDragSrc(null); return; }
    const fromIdx = projects.findIndex(p => p.id === projectDragSrc);
    const toIdx   = projects.findIndex(p => p.id === targetId);
    const reordered = [...projects];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setProjects(reordered);
    setProjectDragSrc(null);
    fetch('/api/projects/reorder', {
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

  async function handleDuplicate() {
    if (!dupName.trim() || duplicating) return;
    setDuplicating(true);
    try {
      const res = await fetch(`/api/projects/${dupModal.id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dupName.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || 'Duplicate failed.', 'error');
        return;
      }
      setDupModal(null);
      await fetchProjects();
      showToast('Project duplicated');
    } finally {
      setDuplicating(false);
    }
  }

  async function handleStatusTransition(action) {
    const id = detailProject.id;

    if (action === 'delete') {
      const partCount = parts.length;
      const ok = await confirm({
        title: `Delete "${detailProject.name}"`,
        message: partCount > 0
          ? `This will permanently delete ${partCount} part(s) and all their G-code files. This cannot be undone.`
          : 'This will permanently delete the project. This cannot be undone.',
        confirmLabel: 'Delete Project',
        danger: true,
      });
      if (!ok) return;
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json();
        showToast(d.error || 'Delete failed.', 'error');
        return;
      }
      goBack();
      await fetchProjects();
      showToast('Project deleted');
      return;
    }

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

  function dropPart(targetId) {
    setPartDragOver(null);
    if (!partDragSrc || partDragSrc === targetId) { setPartDragSrc(null); return; }
    const fromIdx = parts.findIndex(p => p.id === partDragSrc);
    const toIdx   = parts.findIndex(p => p.id === targetId);
    const reordered = [...parts];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    setParts(reordered);
    setPartDragSrc(null);
    fetch('/api/parts/reorder', {
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
    setShowBulkImport(false);
  }

  async function saveProjectFilament(material, color) {
    await fetch(`/api/projects/${detailProject.id}/filament`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required_material: material, required_color: color }),
    });
    await fetchDetail(detailProject.id);
  }

  async function saveProjectGroups(groups) {
    await fetch(`/api/projects/${detailProject.id}/groups`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed_groups: groups }),
    });
    await fetchDetail(detailProject.id);
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

  function handleBulkImported(count) {
    setShowBulkImport(false);
    fetchDetail(selectedId);
    showToast(`Imported ${count} part(s)`);
  }


  // ─── List view ───────────────────────────────────────────────────────────────
  if (selectedId == null) {
    return (
      <div>
        {toastEl}
        {confirmModal}

        {/* ── Duplicate project modal ── */}
        {dupModal && createPortal(
          <div
            style={{
              position: 'fixed', inset: 0,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 1000, padding: 20,
              backdropFilter: 'blur(3px)',
            }}
            onClick={() => { if (!duplicating) setDupModal(null); }}
          >
            <div
              style={{
                background: '#1e2433', border: '1px solid #334155', borderRadius: 10,
                padding: '24px 28px', maxWidth: 420, width: '100%',
                boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
              }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', marginBottom: 6 }}>
                Duplicate Project
              </div>
              <div style={{ color: '#64748b', fontSize: 13, marginBottom: 14 }}>
                All parts and G-code files will be copied. The new project starts as a draft with all quantities reset to zero.
              </div>
              <label style={{ color: '#94a3b8', fontSize: 12, display: 'block', marginBottom: 6 }}>
                New project name
              </label>
              <input
                type="text"
                value={dupName}
                onChange={e => setDupName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleDuplicate(); if (e.key === 'Escape' && !duplicating) setDupModal(null); }}
                style={{ ...inputSx, width: '100%', boxSizing: 'border-box', marginBottom: 20 }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { if (!duplicating) setDupModal(null); }}
                  disabled={duplicating}
                  style={{
                    background: '#1f2937', color: '#9ca3af', border: '1px solid #374151',
                    borderRadius: 6, padding: '8px 18px', fontSize: 13,
                    cursor: duplicating ? 'default' : 'pointer', fontWeight: 500,
                    opacity: duplicating ? 0.4 : 1,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleDuplicate}
                  disabled={!dupName.trim() || duplicating}
                  style={{
                    background: '#1d4ed8', color: '#fff', border: 'none',
                    borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 600,
                    cursor: dupName.trim() && !duplicating ? 'pointer' : 'default',
                    opacity: dupName.trim() && !duplicating ? 1 : 0.5,
                  }}
                >
                  {duplicating ? 'Duplicating…' : 'Duplicate'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

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
          <EmptyState
            title="Create your first project"
            hint={
              <>
                Projects are how work flows through the farm:&nbsp;
                a <strong style={{ color: '#cbd5e1' }}>Project</strong> contains{' '}
                <strong style={{ color: '#cbd5e1' }}>Parts</strong> (what to print and how many),
                each part gets <strong style={{ color: '#cbd5e1' }}>G-code</strong> uploaded per printer model,
                and the scheduler dispatches <strong style={{ color: '#cbd5e1' }}>Jobs</strong> to idle printers
                until every part hits its target quantity. Start with "+ New Project" above.
              </>
            }
          />
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projects.map(p => {
            const s = PROJECT_STATUS[p.status] || PROJECT_STATUS.draft;
            const isDragging = projectDragSrc === p.id;
            const isOver     = projectDragOver === p.id && !isDragging;
            return (
              <div
                key={p.id}
                draggable
                onDragStart={() => setProjectDragSrc(p.id)}
                onDragOver={e => { e.preventDefault(); if (!isDragging) setProjectDragOver(p.id); }}
                onDrop={e => { e.preventDefault(); dropProject(p.id); }}
                onDragEnd={() => { setProjectDragSrc(null); setProjectDragOver(null); }}
                style={{
                  background: '#1e2433',
                  border: `1px solid ${isOver ? '#3b82f6' : '#2d3748'}`,
                  borderRadius: 8,
                  padding: '12px 16px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                  opacity: isDragging ? 0.4 : 1,
                  transition: 'border-color 0.1s, opacity 0.1s',
                }}
              >
                {/* Drag handle */}
                <span
                  title="Drag to reorder"
                  aria-hidden="true"
                  style={{ color: '#334155', fontSize: 16, cursor: 'grab', flexShrink: 0, userSelect: 'none', lineHeight: 1 }}
                >⠿</span>

                {/* Name + description — clicking here navigates */}
                <div style={{ minWidth: 0, flex: 1, cursor: 'pointer' }} onClick={() => setSelectedId(p.id)}>
                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </div>
                  {p.description && (
                    <div style={{ color: '#64748b', fontSize: 12 }}>{p.description}</div>
                  )}
                </div>

                {/* Duplicate button — stop propagation so it doesn't navigate into the project */}
                <div style={{ flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => { setDupModal({ id: p.id }); setDupName(`Copy of ${p.name}`); }}
                    title="Duplicate project"
                    style={{
                      background: 'none', border: '1px solid #334155', borderRadius: 4,
                      padding: '3px 8px', color: '#64748b', fontSize: 12, cursor: 'pointer', lineHeight: 1.4,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = '#e2e8f0'; e.currentTarget.style.borderColor = '#475569'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.borderColor = '#334155'; }}
                  >
                    Copy
                  </button>
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

  let projectGroups = [];
  try { projectGroups = detailProject.allowed_groups ? JSON.parse(detailProject.allowed_groups) : []; } catch (_) {}

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

      {/* Project-level filament defaults */}
      {filamentTypes.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#64748b', flexShrink: 0 }}>Filament:</span>
          <select
            value={detailProject.required_material || ''}
            onChange={e => {
              const mat = e.target.value;
              saveProjectFilament(mat, '');
            }}
            style={{ ...inputSx, fontSize: 12, width: 160 }}
          >
            <option value="">— any material —</option>
            {filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
          <select
            value={detailProject.required_color || ''}
            onChange={e => saveProjectFilament(detailProject.required_material, e.target.value)}
            disabled={!detailProject.required_material}
            style={{ ...inputSx, fontSize: 12, width: 160 }}
          >
            <option value="">— any color —</option>
            {filamentColors
              .filter(c => c.type_name === detailProject.required_material)
              .map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          {(detailProject.required_material || detailProject.required_color) && (
            <span style={{ fontSize: 11, color: '#475569', fontStyle: 'italic' }}>
              applies to all gcodes in this project unless overridden per-gcode
            </span>
          )}
        </div>
      )}

      {/* Project-level group defaults */}
      {allGroups.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#64748b', flexShrink: 0 }}>Groups:</span>
          {allGroups.map(g => (
            <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: 12, color: projectGroups.includes(g) ? '#7dd3fc' : '#64748b' }}>
              <input
                type="checkbox"
                checked={projectGroups.includes(g)}
                onChange={() => {
                  const next = projectGroups.includes(g)
                    ? projectGroups.filter(x => x !== g)
                    : [...projectGroups, g];
                  saveProjectGroups(next);
                }}
                style={{ accentColor: '#3b82f6' }}
              />
              {g}
            </label>
          ))}
          {projectGroups.length === 0 && <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>all groups</span>}
          {projectGroups.length > 0 && (
            <span style={{ fontSize: 11, color: '#475569', fontStyle: 'italic' }}>
              applies to all gcodes in this project unless overridden per-gcode
            </span>
          )}
        </div>
      )}

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

        const isPartDragging = partDragSrc === part.id;
        const isPartOver     = partDragOver === part.id && !isPartDragging;
        return (
          <div
            key={part.id}
            draggable
            onDragStart={() => setPartDragSrc(part.id)}
            onDragOver={e => { e.preventDefault(); if (!isPartDragging) setPartDragOver(part.id); }}
            onDrop={e => { e.preventDefault(); dropPart(part.id); }}
            onDragEnd={() => { setPartDragSrc(null); setPartDragOver(null); }}
            style={{
              background: '#1e2433',
              border: `1px solid ${isPartOver ? '#3b82f6' : '#2d3748'}`,
              borderRadius: 8, padding: '12px 16px', marginBottom: 8,
              opacity: isPartDragging ? 0.4 : 1,
              transition: 'border-color 0.1s, opacity 0.1s',
            }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>

              {/* Name + drag handle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 200, flexShrink: 0 }}>
                <span
                  title="Drag to reorder"
                  aria-hidden="true"
                  style={{ color: '#334155', fontSize: 16, cursor: 'grab', flexShrink: 0, userSelect: 'none', lineHeight: 1 }}
                >⠿</span>
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

              {/* Status indicator — dot + text (not a pill, so it doesn't read as a button
                  next to the Details toggle). Fixed width keeps bar length consistent. */}
              <span
                title={partSt.help}
                style={{
                  color: partSt.text, fontSize: 11, fontWeight: 700,
                  width: 76, flexShrink: 0, cursor: 'help',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: partSt.text, flexShrink: 0 }} />
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
                aria-label={`Delete part ${part.name}`}
                style={{
                  background: 'none', border: 'none', color: '#ef4444',
                  cursor: 'pointer', padding: '4px 6px', fontSize: 18, lineHeight: 1, flexShrink: 0,
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
                filamentTypes={filamentTypes}
                filamentColors={filamentColors}
                projectMaterial={detailProject.required_material || ''}
                projectColor={detailProject.required_color || ''}
                projectGroups={projectGroups}
                groups={allGroups}
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
          <button
            onClick={() => setShowBulkImport(v => !v)}
            style={{
              background: showBulkImport ? '#1e3a5f' : '#1f2937',
              color: showBulkImport ? '#60a5fa' : '#94a3b8',
              border: `1px solid ${showBulkImport ? '#1e40af' : '#2d3748'}`,
              borderRadius: 4, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {showBulkImport ? '− Hide Bulk Import' : '+ Bulk Import'}
          </button>
        </div>
      </div>

      {/* Bulk Import Panel */}
      {showBulkImport && (
        <BulkImportPanel
          projectId={selectedId}
          onImported={handleBulkImported}
        />
      )}
    </div>
  );
}