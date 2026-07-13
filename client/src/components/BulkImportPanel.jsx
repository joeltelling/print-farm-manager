import { useState, useRef, useEffect } from 'react';

const sx = { i: { background: '#0f172a', border: '1px solid #2d3748', borderRadius: 4, padding: '4px 8px', color: '#e2e8f0', fontSize: 12, outline: 'none' },
  btn: { background: '#1f2937', color: '#94a3b8', border: '1px solid #2d3748', borderRadius: 4, padding: '4px 10px', fontSize: 11, cursor: 'pointer' },
  btnPrimary: { background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' } };

function partName(fn) { const i = fn.lastIndexOf('.'); const b = i >= 0 ? fn.slice(0, i) : fn; return b.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim() || fn; }

export default function BulkImportPanel({ projectId, onImported }) {
  const [items, setItems] = useState([]);
  const [files, setFiles] = useState([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);
  const [models, setModels] = useState([]);
  const [filamentTypes, setFilamentTypes] = useState([]);
  const [allColors, setAllColors] = useState([]);
  const [bulkMaterial, setBulkMaterial] = useState('');
  const [bulkColor, setBulkColor] = useState('');
  const [bulkGroups, setBulkGroups] = useState('');
  const [availableGroups, setAvailableGroups] = useState([]);
  const fileRef = useRef(null);

  useEffect(() => {
    fetch('/api/printers').then(r => r.json())
      .then(ps => setModels([...new Set(ps.filter(p => p.model).map(p => p.model))]))
      .catch(() => {});
    fetch('/api/filaments/types').then(r => r.json()).then(setFilamentTypes).catch(() => {});
    fetch('/api/filaments/colors').then(r => r.json()).then(setAllColors).catch(() => {});
    fetch('/api/groups').then(r => r.json()).then(groups => setAvailableGroups(groups.map(g => g.name))).catch(() => {});
  }, []);

  function addFiles(e) {
    const sel = Array.from(e.target.files || []);
    if (!sel.length) return;
    setError(null);
    setItems(p => [...p, ...sel.map(f => ({ file: f, name: partName(f.name), qty: 1, ppp: 1, model: '', fn: f.name, amsSlot: '', groups: '', material: '', color: '' }))]);
    setFiles(p => [...p, ...sel]);
    fileRef.current.value = '';
  }

  function upd(idx, f, v) { setItems(p => p.map((it, i) => i === idx ? { ...it, [f]: v } : it)); }
  function bulk(f, v) { setItems(p => p.map(it => ({ ...it, [f]: v }))); }
  function rm(idx) { setItems(p => p.filter((_, i) => i !== idx)); setFiles(p => p.filter((_, i) => i !== idx)); }

  async function doImport() {
    if (!items.length || !items.every(it => it.model)) { setError('All files need a printer model.'); return; }
    setImporting(true); setError(null);
    const fd = new FormData();
    fd.append('project_id', String(projectId));
    const overrides = items.map(it => {
      const groupsRaw = (it.groups || '').trim() || bulkGroups.trim();
      const groupsArr = groupsRaw ? groupsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      return {
        fn: it.fn, name: it.name, quantity: it.qty, parts_per_plate: it.ppp, printer_model: it.model,
        ams_slot: it.amsSlot || '',
        allowed_groups: groupsArr.length ? JSON.stringify(groupsArr) : '',
        required_material: it.material || bulkMaterial || '', required_color: it.color || bulkColor || '',
      };
    });
    fd.append('overrides', JSON.stringify(overrides));
    for (const it of items) fd.append('files', it.file);
    try {
      const res = await fetch('/api/parts/bulk-import', { method: 'POST', body: fd });
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        const snippet = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
        setError(`Server error (${res.status}): ${snippet}`);
        return;
      }
      if (!res.ok) { setError(data.error || 'Import failed'); return; }
      setItems([]); setFiles([]); onImported(data.count);
    } catch (err) { setError(err.message); }
    finally { setImporting(false); }
  }

  const th = (t, w) => ({ color: '#64748b', fontSize: 11, fontWeight: 600, textAlign: 'left', padding: '4px 8px', width: w });
  const effectiveMat = bulkMaterial;
  const colorOptions = allColors.filter(c => !effectiveMat || c.type_name === effectiveMat);
  return (
    <div style={{ background: '#1e2433', border: '1px solid #2d3748', borderRadius: 8, padding: 16, marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>Bulk Import Parts</h3>
        {items.length > 0 && <span style={{ fontSize: 12, color: '#64748b' }}>{items.length} file(s) staged</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ cursor: 'pointer' }}>
          <input ref={fileRef} type="file" accept=".gcode,.bgcode,.3mf" multiple onChange={addFiles} style={{ display: 'none' }} />
          <span style={{ ...sx.btn, display: 'inline-block', cursor: 'pointer' }}>+ Select G-code Files</span>
        </label>
        {items.length > 0 && <>
          <button onClick={() => { setItems([]); setFiles([]); setError(null); }} style={{ ...sx.btn, color: '#f87171' }}>Clear All</button>
          <button onClick={doImport} disabled={importing} style={{ ...sx.btnPrimary, opacity: importing ? 0.6 : 1 }}>{importing ? 'Importing…' : `Import ${items.length} Part(s)`}</button>
        </>}
      </div>
      {items.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #2d3748' }}>
          <span style={{ fontSize: 11, color: '#475569' }}>Bulk set all:</span>
          <span style={{ fontSize: 11, color: '#64748b' }}>Qty</span><input type="number" min={1} placeholder="1" onChange={e => e.target.value && bulk('qty', +e.target.value)} style={{ ...sx.i, width: 70 }} />
          <span style={{ fontSize: 11, color: '#64748b' }}>Per Plate</span><input type="number" min={1} placeholder="1" onChange={e => e.target.value && bulk('ppp', +e.target.value)} style={{ ...sx.i, width: 70 }} />
          {models.length > 0 && <><span style={{ fontSize: 11, color: '#64748b' }}>Model</span><select onChange={e => e.target.value && bulk('model', e.target.value)} style={{ ...sx.i, width: 100, fontSize: 11 }}><option value="">Set all…</option>{models.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}</select></>}
        </div>
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #2d3748' }}>
          <span style={{ fontSize: 11, color: '#475569', flexShrink: 0 }}>Targeting (all rows):</span>
          {filamentTypes.length > 0 && <><span style={{ fontSize: 11, color: '#64748b' }}>Material</span><select value={bulkMaterial} onChange={e => { setBulkMaterial(e.target.value); setBulkColor(''); }} style={{ ...sx.i, width: 120, fontSize: 11 }}><option value="">— any —</option>{filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}</select></>}
          {colorOptions.length > 0 && <><span style={{ fontSize: 11, color: '#64748b' }}>Color</span><select value={bulkColor} onChange={e => setBulkColor(e.target.value)} style={{ ...sx.i, width: 120, fontSize: 11 }}><option value="">— any —</option>{colorOptions.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select></>}
          {availableGroups.length > 0 && <><span style={{ fontSize: 11, color: '#64748b' }}>Groups</span><input type="text" value={bulkGroups} onChange={e => setBulkGroups(e.target.value)} placeholder="comma-separated" list="bulk-group-list" style={{ ...sx.i, width: 160, fontSize: 11 }} /><datalist id="bulk-group-list">{availableGroups.map(g => <option key={g} value={g} />)}</datalist></>}
          <span style={{ fontSize: 11, color: '#64748b' }}>AMS Slot</span><select onChange={e => e.target.value && bulk('amsSlot', e.target.value)} style={{ ...sx.i, width: 130, fontSize: 11 }}><option value="">— choose a slot —</option><option value="-1">External Spool</option><option value="0">AMS Slot 1</option><option value="1">AMS Slot 2</option><option value="2">AMS Slot 3</option><option value="3">AMS Slot 4</option></select>
        </div>
      )}
      {items.length > 0 && (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ borderBottom: '1px solid #2d3748' }}>
              <th style={th('File', undefined)}>File</th><th style={th('Part Name', undefined)}>Part Name</th>
              <th style={{ ...th('Qty', 70), textAlign: 'center' }}>Qty</th><th style={{ ...th('Per Plate', 70), textAlign: 'center' }}>Plate</th>
              <th style={th('Model', 100)}>Model *</th><th style={{ width: 30 }} />
            </tr></thead>
            <tbody>{items.map((it, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #1e2433' }}>
                <td style={{ padding: '4px 8px', color: '#94a3b8', fontSize: 11, fontFamily: 'monospace', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.fn}</td>
                <td style={{ padding: '4px 8px' }}><input value={it.name} onChange={e => upd(idx, 'name', e.target.value)} style={{ ...sx.i, width: '100%', boxSizing: 'border-box' }} /></td>
                <td style={{ padding: '4px 8px', textAlign: 'center' }}><input type="number" min={1} value={it.qty} onChange={e => upd(idx, 'qty', +e.target.value || 1)} style={{ ...sx.i, width: 70, textAlign: 'center' }} /></td>
                <td style={{ padding: '4px 8px', textAlign: 'center' }}><input type="number" min={1} value={it.ppp} onChange={e => upd(idx, 'ppp', +e.target.value || 1)} style={{ ...sx.i, width: 70, textAlign: 'center' }} /></td>
                <td style={{ padding: '4px 8px' }}>{models.length > 0
                  ? <select value={it.model} onChange={e => upd(idx, 'model', e.target.value)} style={{ ...sx.i, width: 90, fontSize: 11 }}><option value="">Select…</option>{models.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}</select>
                  : <input value={it.model} onChange={e => upd(idx, 'model', e.target.value)} placeholder="e.g. mk4s" style={{ ...sx.i, width: 90, fontSize: 11 }} />}
                </td>
                <td style={{ padding: '4px 4px' }}><button onClick={() => rm(idx)} title="Remove" aria-label="Remove file" style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px 6px', fontSize: 18, lineHeight: 1, flexShrink: 0 }}>×</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {error && <p style={{ color: '#f87171', fontSize: 12, margin: '10px 0 0' }}>{error}</p>}
      <p style={{ margin: '12px 0 0', fontSize: 11, color: '#475569' }}>G-code files are parsed for print time, filament usage, and filament type automatically. Use the targeting bar to set material, color, groups, and AMS slot for all rows. Part names default to the filename.</p>
    </div>
  );
}