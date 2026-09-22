import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// Alternative path to the existing per-part G-code upload panel (Projects.jsx's
// GcodeUploadPanel): a guided modal that also creates the Project and/or Part
// along the way, triggered by dropping a G-code file anywhere on the Projects
// page or the "+ Upload G-code" button. Ends by calling the exact same
// POST /api/gcodes/upload endpoint the existing panel uses: this is a new
// front door, not a second upload mechanism.

const inputSx = {
  background: '#0f172a',
  border: '1px solid #2d3748',
  borderRadius: 6,
  padding: '6px 10px',
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
};

const labelSx = {
  color: '#94a3b8',
  fontSize: 12,
  display: 'block',
  marginBottom: 4,
};

const primaryBtnSx = (disabled) => ({
  background: disabled ? '#1e3a8a' : '#1d4ed8',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.5 : 1,
});

const secondaryBtnSx = {
  background: '#1f2937',
  color: '#9ca3af',
  border: '1px solid #374151',
  borderRadius: 6,
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const STEPS = ['destination', 'details', 'review'];

export default function GcodeUploadWizard({ initialFile, projects, filamentTypes, filamentColors, groups, onClose, onUploaded }) {
  const [step, setStep] = useState('destination');
  const [file, setFile] = useState(initialFile || null);
  const fileInputRef = useRef(null);

  // ── Destination ──────────────────────────────────────────────────────────
  const [projectMode, setProjectMode] = useState('existing'); // 'existing' | 'new'
  const [projectId, setProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [partMode, setPartMode] = useState('existing'); // 'existing' | 'new'
  const [partsForProject, setPartsForProject] = useState([]);
  const [partId, setPartId] = useState('');
  const [newPartName, setNewPartName] = useState('');
  const [newPartQty, setNewPartQty] = useState('');

  // Existing projects with no parts yet force "new part": there's nothing to pick.
  useEffect(() => {
    if (projectMode !== 'existing' || !projectId) { setPartsForProject([]); return; }
    fetch(`/api/parts?project_id=${projectId}`).then(r => r.json()).then(rows => {
      setPartsForProject(rows);
      setPartMode(rows.length > 0 ? 'existing' : 'new');
      setPartId('');
    }).catch(() => setPartsForProject([]));
  }, [projectMode, projectId]);

  // ── G-code details (mirrors Projects.jsx's GcodeUploadPanel) ────────────
  const [partsPerPlate, setPartsPerPlate] = useState('');
  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState([]);
  const [amsSlots, setAmsSlots] = useState([]);
  const [amsSlot, setAmsSlot] = useState('');
  const [parsedEstPrintSecs, setParsedEstPrintSecs] = useState(null);
  const [parsedMaterialGrams, setParsedMaterialGrams] = useState(null);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [requiredMaterial, setRequiredMaterial] = useState('');
  const [requiredColor, setRequiredColor] = useState('');

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

  // Parse the filename as soon as a file is attached, same as GcodeUploadPanel.
  useEffect(() => {
    if (!file) return;
    fetch('/api/gcodes/parse-filename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name }),
    })
      .then(r => r.json())
      .then(data => {
        if (!data.parse_failed) {
          setPartsPerPlate(String(data.parts_per_plate));
          if (data.printer_model) setModel(data.printer_model);
          if (data.est_print_secs != null) setParsedEstPrintSecs(data.est_print_secs);
        }
        if (data.material_grams != null) setParsedMaterialGrams(data.material_grams);
      })
      .catch(() => {});
  }, [file]);

  function toggleGroup(g) {
    setSelectedGroups(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [uploadPct, setUploadPct] = useState(null);
  const [error, setError] = useState(null);

  const isBambuModel = !!modelOptions.find(m => m.model_id === model && m.connector === 'bambu');
  const bambuNeedsThreemf = isBambuModel && file && !file.name.toLowerCase().endsWith('.3mf');

  const destinationValid =
    (projectMode === 'existing' ? !!projectId : newProjectName.trim().length > 0) &&
    (partMode === 'existing' ? !!partId : (newPartName.trim().length > 0 && Number(newPartQty) > 0));
  const detailsValid = !!file && !!partsPerPlate && !!model && !bambuNeedsThreemf &&
    (amsSlots.length === 0 || amsSlot !== '');

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      // 1. Resolve (or create) the project.
      let resolvedProjectId = projectId;
      if (projectMode === 'new') {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newProjectName.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not create the project');
        resolvedProjectId = data.id;
      }

      // 2. Resolve (or create) the part.
      let resolvedPartId = partId;
      if (partMode === 'new') {
        const res = await fetch('/api/parts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: resolvedProjectId, name: newPartName.trim(), target_qty: parseInt(newPartQty, 10) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not create the part');
        resolvedPartId = data.id;
      }

      // 3. Upload the G-code itself: same endpoint, same multipart shape, same
      // XHR-for-progress approach as Projects.jsx's GcodeUploadPanel.
      const fd = new FormData();
      fd.append('file', file);
      fd.append('part_id', String(resolvedPartId));
      fd.append('parts_per_plate', partsPerPlate);
      fd.append('printer_model', model);
      if (amsSlots.length > 0) fd.append('ams_slot', amsSlot);
      if (parsedEstPrintSecs != null) fd.append('est_print_secs', String(parsedEstPrintSecs));
      if (parsedMaterialGrams != null) fd.append('material_grams', String(parsedMaterialGrams));
      if (selectedGroups.length > 0) fd.append('allowed_groups', JSON.stringify(selectedGroups));
      if (requiredMaterial.trim()) fd.append('required_material', requiredMaterial.trim());
      if (requiredColor.trim()) fd.append('required_color', requiredColor.trim());

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
      if (!ok) throw new Error(data.error || 'Upload failed');

      onUploaded();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
      setUploadPct(null);
    }
  }

  const stepIndex = STEPS.indexOf(step);

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
        backdropFilter: 'blur(3px)',
      }}
      onClick={() => { if (!submitting) onClose(); }}
    >
      <div
        style={{
          background: '#1e2433', border: '1px solid #334155', borderRadius: 10,
          padding: '24px 28px', maxWidth: 560, width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>Upload G-code</div>
          <div style={{ fontSize: 11, color: '#475569' }}>Step {stepIndex + 1} of {STEPS.length}</div>
        </div>
        {file && (
          <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16, fontFamily: 'monospace' }}>
            {file.name}
          </div>
        )}

        {step === 'destination' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {!file && (
              <div>
                <label style={labelSx}>File *</label>
                <label style={{ cursor: 'pointer' }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".bgcode,.gcode,.3mf"
                    onChange={e => setFile(e.target.files[0] || null)}
                    style={{ display: 'none' }}
                  />
                  <span style={{ ...inputSx, display: 'inline-block', cursor: 'pointer', color: '#475569' }}>
                    Choose .gcode / .bgcode / .3mf…
                  </span>
                </label>
              </div>
            )}

            <div>
              <label style={labelSx}>Project</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button
                  onClick={() => setProjectMode('existing')}
                  style={{ ...secondaryBtnSx, padding: '4px 12px', fontSize: 12, background: projectMode === 'existing' ? '#334155' : '#1f2937', color: projectMode === 'existing' ? '#e2e8f0' : '#9ca3af' }}
                >
                  Existing
                </button>
                <button
                  onClick={() => { setProjectMode('new'); setPartMode('new'); setPartId(''); }}
                  style={{ ...secondaryBtnSx, padding: '4px 12px', fontSize: 12, background: projectMode === 'new' ? '#334155' : '#1f2937', color: projectMode === 'new' ? '#e2e8f0' : '#9ca3af' }}
                >
                  New
                </button>
              </div>
              {projectMode === 'existing' ? (
                projects.length > 0 ? (
                  <select value={projectId} onChange={e => setProjectId(e.target.value)} style={{ ...inputSx, width: '100%', boxSizing: 'border-box' }}>
                    <option value="">Select a project…</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                ) : (
                  <div style={{ fontSize: 12, color: '#475569', fontStyle: 'italic' }}>No projects yet: choose "New" above.</div>
                )
              ) : (
                <input
                  type="text"
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  placeholder="Project name"
                  style={{ ...inputSx, width: '100%', boxSizing: 'border-box' }}
                  autoFocus
                />
              )}
            </div>

            {(projectMode === 'new' || projectId) && (
              <div>
                <label style={labelSx}>Part</label>
                {projectMode === 'existing' && partsForProject.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <button
                      onClick={() => setPartMode('existing')}
                      style={{ ...secondaryBtnSx, padding: '4px 12px', fontSize: 12, background: partMode === 'existing' ? '#334155' : '#1f2937', color: partMode === 'existing' ? '#e2e8f0' : '#9ca3af' }}
                    >
                      Existing
                    </button>
                    <button
                      onClick={() => setPartMode('new')}
                      style={{ ...secondaryBtnSx, padding: '4px 12px', fontSize: 12, background: partMode === 'new' ? '#334155' : '#1f2937', color: partMode === 'new' ? '#e2e8f0' : '#9ca3af' }}
                    >
                      New
                    </button>
                  </div>
                )}
                {partMode === 'existing' ? (
                  <select value={partId} onChange={e => setPartId(e.target.value)} style={{ ...inputSx, width: '100%', boxSizing: 'border-box' }}>
                    <option value="">Select a part…</option>
                    {partsForProject.map(p => <option key={p.id} value={p.id}>{p.name} ({p.completed_qty}/{p.target_qty})</option>)}
                  </select>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={newPartName}
                      onChange={e => setNewPartName(e.target.value)}
                      placeholder="Part name"
                      style={{ ...inputSx, flex: 1 }}
                    />
                    <input
                      type="number"
                      min={1}
                      value={newPartQty}
                      onChange={e => setNewPartQty(e.target.value)}
                      placeholder="Target qty"
                      style={{ ...inputSx, width: 100 }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 'details' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <label style={labelSx}>Parts per plate *</label>
                <input
                  type="number"
                  min={1}
                  value={partsPerPlate}
                  onChange={e => setPartsPerPlate(e.target.value)}
                  style={{ ...inputSx, width: 110 }}
                />
              </div>
              <div>
                <label style={labelSx}>Printer model *</label>
                <select value={model} onChange={e => setModel(e.target.value)} style={{ ...inputSx, width: 140 }}>
                  <option value="">Select…</option>
                  {modelOptions.map(m => <option key={m.model_id} value={m.model_id}>{m.label}</option>)}
                </select>
              </div>
              {amsSlots.length > 0 && (
                <div>
                  <label style={labelSx}>AMS slot *</label>
                  <select value={amsSlot} onChange={e => setAmsSlot(e.target.value)} style={{ ...inputSx, width: 160 }}>
                    <option value="">Select…</option>
                    {amsSlots.map(s => s.slot === -1
                      ? <option key="ext" value="-1">External Spool{s.type ? ` (${s.type})` : ''}</option>
                      : <option key={s.slot} value={String(s.slot)}>Slot {s.slot} ({s.type || 'unknown'})</option>
                    )}
                  </select>
                </div>
              )}
            </div>

            {bambuNeedsThreemf && (
              <p style={{ margin: 0, fontSize: 12, color: '#b45309', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 4, padding: '6px 10px' }}>
                Bambu printers require a <strong>.3mf</strong> file: plain .gcode files are not supported.
              </p>
            )}

            <div>
              <label style={labelSx}>Targeting (optional)</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {filamentTypes.length > 0 ? (
                  <select
                    value={requiredMaterial}
                    onChange={e => { setRequiredMaterial(e.target.value); setRequiredColor(''); }}
                    style={{ ...inputSx, width: 150 }}
                  >
                    <option value="">(any material)</option>
                    {filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                  </select>
                ) : (
                  <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>No materials in library</span>
                )}
                {requiredMaterial && filamentColors.filter(c => c.type_name === requiredMaterial).length > 0 && (
                  <select value={requiredColor} onChange={e => setRequiredColor(e.target.value)} style={{ ...inputSx, width: 150 }}>
                    <option value="">(any color)</option>
                    {filamentColors.filter(c => c.type_name === requiredMaterial).map(c => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>
              {groups.length > 0 && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                  <span style={{ fontSize: 11, color: '#475569' }}>Groups:</span>
                  {groups.map(g => (
                    <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: 12, color: selectedGroups.includes(g) ? '#7dd3fc' : '#64748b' }}>
                      <input type="checkbox" checked={selectedGroups.includes(g)} onChange={() => toggleGroup(g)} style={{ accentColor: '#3b82f6' }} />
                      {g}
                    </label>
                  ))}
                  {selectedGroups.length === 0 && <span style={{ fontSize: 11, color: '#334155', fontStyle: 'italic' }}>all groups</span>}
                </div>
              )}
            </div>
          </div>
        )}

        {step === 'review' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#cbd5e1' }}>
            <div>Project: <strong style={{ color: '#e2e8f0' }}>{projectMode === 'new' ? newProjectName.trim() : projects.find(p => String(p.id) === String(projectId))?.name}</strong>{projectMode === 'new' && <span style={{ color: '#7dd3fc', fontSize: 11 }}> (new)</span>}</div>
            <div>Part: <strong style={{ color: '#e2e8f0' }}>{partMode === 'new' ? newPartName.trim() : partsForProject.find(p => String(p.id) === String(partId))?.name}</strong>{partMode === 'new' && <span style={{ color: '#7dd3fc', fontSize: 11 }}> (new, target {newPartQty})</span>}</div>
            <div>Model: <strong style={{ color: '#e2e8f0' }}>{modelOptions.find(m => m.model_id === model)?.label || model}</strong></div>
            <div>Parts per plate: <strong style={{ color: '#e2e8f0' }}>{partsPerPlate}</strong></div>
            {(requiredMaterial || requiredColor) && (
              <div>Targeting: <strong style={{ color: '#e2e8f0' }}>{[requiredMaterial, requiredColor].filter(Boolean).join(' / ')}</strong></div>
            )}
            {selectedGroups.length > 0 && <div>Groups: <strong style={{ color: '#e2e8f0' }}>{selectedGroups.join(', ')}</strong></div>}

            {submitting && uploadPct != null && (
              <div style={{ background: '#0f172a', borderRadius: 3, height: 6, overflow: 'hidden', marginTop: 8 }}>
                <div style={{ background: '#3b82f6', height: '100%', width: `${uploadPct}%`, transition: 'width 0.2s' }} />
              </div>
            )}
          </div>
        )}

        {error && <p style={{ color: '#f87171', fontSize: 12, marginTop: 12 }}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
          <button onClick={() => { if (!submitting) onClose(); }} disabled={submitting} style={{ ...secondaryBtnSx, opacity: submitting ? 0.4 : 1, cursor: submitting ? 'default' : 'pointer' }}>
            Cancel
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {stepIndex > 0 && (
              <button onClick={() => setStep(STEPS[stepIndex - 1])} disabled={submitting} style={secondaryBtnSx}>
                Back
              </button>
            )}
            {step === 'destination' && (
              <button onClick={() => setStep('details')} disabled={!destinationValid || !file} style={primaryBtnSx(!destinationValid || !file)}>
                Next
              </button>
            )}
            {step === 'details' && (
              <button onClick={() => setStep('review')} disabled={!detailsValid} style={primaryBtnSx(!detailsValid)}>
                Next: Review
              </button>
            )}
            {step === 'review' && (
              <button onClick={submit} disabled={submitting} style={primaryBtnSx(submitting)}>
                {submitting ? (uploadPct != null ? `Uploading… ${uploadPct}%` : 'Uploading…') : 'Upload'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
