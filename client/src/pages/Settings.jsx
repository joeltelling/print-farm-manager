import { useState, useRef, useCallback, useEffect } from 'react';

const inputStyle = {
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: 6,
  padding: '6px 10px',
  color: '#e2e8f0',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

const PRUSA_MODELS  = ['mk4', 'mk4s', 'c1', 'c1l', 'xl'];
const ELEGOO_MODELS = ['centauri-carbon'];
const MODEL_OPTIONS = [...PRUSA_MODELS, ...ELEGOO_MODELS];

const TYPE_OPTIONS = [
  { value: 'prusa',           label: 'Prusa (PrusaLink)' },
  { value: 'elegoo-centauri', label: 'Elegoo (SDCP)' },
];

export default function Settings() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [flaggedModels, setFlaggedModels] = useState({});
  const fileRef = useRef(null);

  // Add single printer
  const [addForm, setAddForm] = useState({ name: '', ip: '', api_key: '', model: 'mk4s', group_name: '', type: 'prusa' });
  const [addResult, setAddResult] = useState(null);
  const [addError, setAddError] = useState(null);
  const [adding, setAdding] = useState(false);

  async function handleAddPrinter(e) {
    e.preventDefault();
    setAdding(true);
    setAddResult(null);
    setAddError(null);
    try {
      const res = await fetch('/api/printers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addForm.name.trim(),
          ip: addForm.ip.trim(),
          api_key: addForm.api_key.trim(),
          model: addForm.model,
          group_name: addForm.group_name.trim() || null,
          type: addForm.type,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Add failed');
      setAddResult(data);
      setAddForm({ name: '', ip: '', api_key: '', model: 'mk4s', group_name: '', type: 'prusa' });
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  // Dispatch batch size setting
  const [batchSize, setBatchSize] = useState('');
  const [batchSizeSaved, setBatchSizeSaved] = useState(false);
  const [batchSizeError, setBatchSizeError] = useState(null);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        if (data.dispatch_batch_size) setBatchSize(data.dispatch_batch_size);
      })
      .catch(() => {});
  }, []);

  async function handleSaveBatchSize() {
    setBatchSizeSaved(false);
    setBatchSizeError(null);
    try {
      const res = await fetch('/api/settings/dispatch_batch_size', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: batchSize }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setBatchSizeSaved(true);
      setTimeout(() => setBatchSizeSaved(false), 3000);
    } catch (err) {
      setBatchSizeError(err.message);
    }
  }

  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    function fetchAlerts() {
      fetch('/api/notifications')
        .then(r => r.json())
        .then(setAlerts)
        .catch(() => {});
    }
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 15000);
    return () => clearInterval(interval);
  }, []);

  async function dismissAlert(id) {
    await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
    setAlerts(prev => prev.filter(a => a.id !== id));
  }

  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null);
  const [restoreError, setRestoreError] = useState(null);
  const restoreFileRef = useRef(null);

  const handleExport = useCallback(() => {
    window.location.href = '/api/backup';
  }, []);

  async function handleRestore(e) {
    e.preventDefault();
    const file = restoreFileRef.current?.files[0];
    if (!file) return;
    if (!window.confirm('This will replace ALL current farm data with the backup. Continue?')) return;

    setRestoring(true);
    setRestoreResult(null);
    setRestoreError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/backup/restore', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Restore failed');
      setRestoreResult(data);
    } catch (err) {
      setRestoreError(err.message);
    } finally {
      setRestoring(false);
      if (restoreFileRef.current) restoreFileRef.current.value = '';
    }
  }

  async function handleImport(e) {
    e.preventDefault();
    const file = fileRef.current?.files[0];
    if (!file) return;

    setImporting(true);
    setResult(null);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/printers/import', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setResult(data);
      // Init model selectors for flagged rows that need manual model selection
      const initial = {};
      data.flagged.forEach((f, i) => {
        if (f.reason.includes('Cannot infer model')) {
          initial[i] = 'mk4s';
        }
      });
      setFlaggedModels(initial);
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleSaveFlagged(flaggedItem, selectedModel) {
    const { row } = flaggedItem;
    try {
      const res = await fetch('/api/printers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: row.name,
          ip: row.ip,
          api_key: row.api_key,
          group_name: row.group || null,
          type: row.type || 'prusa',
          model: selectedModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      alert(`Printer "${row.name}" saved as ${selectedModel}.`);
      // Remove from flagged list
      setResult((prev) => ({
        ...prev,
        flagged: prev.flagged.filter((f) => f !== flaggedItem),
        imported: prev.imported + 1,
      }));
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>Settings</h1>

      {/* Server Alerts */}
      {alerts.length > 0 && (
        <section style={{ background: '#1e2433', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640, border: '1px solid #7f1d1d' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#fca5a5' }}>
            Server Alerts ({alerts.length})
          </h2>
          {alerts.map(alert => (
            <div key={alert.id} style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
              background: '#1a1f2e',
              border: '1px solid #7f1d1d',
              borderRadius: 6,
              padding: '10px 12px',
              marginBottom: 8,
              fontSize: 13,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: '#fca5a5', marginBottom: 4 }}>{alert.message}</div>
                <div style={{ color: '#475569', fontSize: 12 }}>
                  {new Date(alert.timestamp).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => dismissAlert(alert.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  cursor: 'pointer',
                  fontSize: 16,
                  lineHeight: 1,
                  padding: '0 4px',
                  flexShrink: 0,
                }}
                title="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </section>
      )}

      {/* CSV Import */}
      <section style={{ background: '#1e2433', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Import Printer Registry</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>
          Upload a CSV with columns: <code style={{ color: '#94a3b8' }}>name, ip, api_key, group, type</code>.<br />
          Model is inferred from the printer name. Duplicate names are skipped.
        </p>

        <form onSubmit={handleImport} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            required
            style={{
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 6,
              padding: '6px 10px',
              color: '#e2e8f0',
              fontSize: 13,
              flex: '1 1 200px',
            }}
          />
          <button
            type="submit"
            disabled={importing}
            style={{
              background: importing ? '#1e40af' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: importing ? 'not-allowed' : 'pointer',
              opacity: importing ? 0.7 : 1,
            }}
          >
            {importing ? 'Importing…' : 'Import CSV'}
          </button>
        </form>

        {error && (
          <div style={{ marginTop: 14, background: '#7f1d1d', borderRadius: 6, padding: '10px 14px', color: '#fca5a5', fontSize: 13 }}>
            {error}
          </div>
        )}

        {result && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <Chip color="#4ade80" label={`${result.imported} imported`} />
              <Chip color="#fbbf24" label={`${result.skipped} skipped (duplicates)`} />
              <Chip color="#f87171" label={`${result.flagged.length} flagged`} />
            </div>

            {result.flagged.length > 0 && (
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: '#f87171', marginBottom: 8 }}>
                  Flagged rows — resolve manually:
                </p>
                {result.flagged.map((f, i) => (
                  <div key={i} style={{
                    background: '#1a1f2e',
                    border: '1px solid #7f1d1d',
                    borderRadius: 6,
                    padding: '10px 12px',
                    marginBottom: 8,
                    fontSize: 13,
                  }}>
                    <div style={{ fontWeight: 600, color: '#fca5a5', marginBottom: 4 }}>{f.row.name}</div>
                    <div style={{ color: '#94a3b8', marginBottom: 8 }}>{f.reason}</div>
                    {f.reason.includes('Cannot infer model') && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <select
                          value={flaggedModels[i] || 'mk4s'}
                          onChange={(e) => setFlaggedModels((prev) => ({ ...prev, [i]: e.target.value }))}
                          style={{
                            background: '#0f172a',
                            border: '1px solid #334155',
                            borderRadius: 4,
                            padding: '4px 8px',
                            color: '#e2e8f0',
                            fontSize: 13,
                          }}
                        >
                          {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <button
                          onClick={() => handleSaveFlagged(f, flaggedModels[i] || 'mk4s')}
                          style={{
                            background: '#15803d',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 4,
                            padding: '4px 12px',
                            fontSize: 13,
                            cursor: 'pointer',
                          }}
                        >
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Add Single Printer */}
      <section style={{ background: '#1e2433', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Add Printer</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>
          Add a single printer directly without a CSV file.
        </p>
        <form onSubmit={handleAddPrinter}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Brand *</label>
              <select
                value={addForm.type}
                onChange={e => {
                  const t = e.target.value;
                  const defaultModel = t === 'elegoo-centauri' ? 'centauri-carbon' : 'mk4s';
                  setAddForm(p => ({ ...p, type: t, model: defaultModel }));
                }}
                style={inputStyle}
              >
                {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Model *</label>
              <select
                value={addForm.model}
                onChange={e => setAddForm(p => ({ ...p, model: e.target.value }))}
                style={inputStyle}
              >
                {(addForm.type === 'elegoo-centauri' ? ELEGOO_MODELS : PRUSA_MODELS).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Name *</label>
              <input
                value={addForm.name}
                onChange={e => setAddForm(p => ({ ...p, name: e.target.value }))}
                required
                placeholder={addForm.type === 'elegoo-centauri' ? 'Centauri_01' : 'MK4S_11'}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>IP Address *</label>
              <input
                value={addForm.ip}
                onChange={e => setAddForm(p => ({ ...p, ip: e.target.value }))}
                required
                placeholder="192.168.1.100"
                style={inputStyle}
              />
            </div>
            {addForm.type !== 'elegoo-centauri' && (
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>API Key *</label>
                <input
                  value={addForm.api_key}
                  onChange={e => setAddForm(p => ({ ...p, api_key: e.target.value }))}
                  required
                  placeholder="xxxxxxxxxxxxxxxx"
                  style={inputStyle}
                />
              </div>
            )}
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>Group (optional)</label>
              <input
                value={addForm.group_name}
                onChange={e => setAddForm(p => ({ ...p, group_name: e.target.value }))}
                placeholder="Rack A"
                style={inputStyle}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={adding}
            style={{
              background: adding ? '#1e40af' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: adding ? 'not-allowed' : 'pointer',
              opacity: adding ? 0.7 : 1,
            }}
          >
            {adding ? 'Adding…' : 'Add Printer'}
          </button>
        </form>
        {addError && (
          <div style={{ marginTop: 14, background: '#7f1d1d', borderRadius: 6, padding: '10px 14px', color: '#fca5a5', fontSize: 13 }}>
            {addError}
          </div>
        )}
        {addResult && (
          <div style={{ marginTop: 14, background: '#14532d', borderRadius: 6, padding: '10px 14px', color: '#4ade80', fontSize: 13 }}>
            Printer <strong>{addResult.name}</strong> added (ID #{addResult.id}).
          </div>
        )}
      </section>

      {/* Dispatch Settings */}
      <section style={{ background: '#1e2433', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Dispatch Settings</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>
          Control how many printers receive a file simultaneously when the scheduler sweeps.
          Reduce this number if your network is saturated during large batch uploads — each batch
          waits for all printers to reach <em>printing</em> before the next batch fires.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
              Printers per batch (1–100)
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={batchSize}
              onChange={e => setBatchSize(e.target.value)}
              style={{ ...inputStyle, width: 80 }}
            />
          </div>
          <button
            onClick={handleSaveBatchSize}
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              alignSelf: 'flex-end',
            }}
          >
            Save
          </button>
          {batchSizeSaved && (
            <span style={{ color: '#4ade80', fontSize: 13, alignSelf: 'flex-end', paddingBottom: 2 }}>Saved</span>
          )}
        </div>
        {batchSizeError && (
          <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{batchSizeError}</div>
        )}
      </section>

      {/* Farm Backup / Restore */}
      <section style={{ background: '#1e2433', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Farm Backup</h2>
        <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>
          Export a full snapshot of your printers, projects, parts, G-code files, and job history.
          Use the same file to restore on another machine or recover from data loss.
        </p>

        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Export */}
          <button
            onClick={handleExport}
            style={{
              background: '#0f3460',
              color: '#93c5fd',
              border: '1px solid #1e40af',
              borderRadius: 6,
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Export Farm
          </button>

          {/* Restore */}
          <form onSubmit={handleRestore} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              ref={restoreFileRef}
              type="file"
              accept=".json"
              required
              style={{
                background: '#0f172a',
                border: '1px solid #334155',
                borderRadius: 6,
                padding: '6px 10px',
                color: '#e2e8f0',
                fontSize: 13,
                flex: '1 1 200px',
              }}
            />
            <button
              type="submit"
              disabled={restoring}
              style={{
                background: restoring ? '#7f1d1d' : '#991b1b',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '8px 18px',
                fontSize: 13,
                fontWeight: 600,
                cursor: restoring ? 'not-allowed' : 'pointer',
                opacity: restoring ? 0.7 : 1,
              }}
            >
              {restoring ? 'Restoring…' : 'Restore Farm'}
            </button>
          </form>
        </div>

        {restoreError && (
          <div style={{ marginTop: 14, background: '#7f1d1d', borderRadius: 6, padding: '10px 14px', color: '#fca5a5', fontSize: 13 }}>
            {restoreError}
          </div>
        )}

        {restoreResult && (
          <div style={{ marginTop: 14 }}>
            <div style={{ color: '#4ade80', fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
              Farm restored successfully
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Chip color="#4ade80" label={`${restoreResult.printers} printers`} />
              <Chip color="#4ade80" label={`${restoreResult.projects} projects`} />
              <Chip color="#4ade80" label={`${restoreResult.parts} parts`} />
              <Chip color="#4ade80" label={`${restoreResult.gcodes} G-codes`} />
              <Chip color="#4ade80" label={`${restoreResult.jobs} jobs`} />
            </div>
          </div>
        )}
      </section>

      {/* Polling interval info */}
      <section style={{ background: '#1e2433', borderRadius: 10, padding: 20, maxWidth: 640 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Polling</h2>
        <p style={{ color: '#64748b', fontSize: 13 }}>
          All printers are polled every <strong style={{ color: '#e2e8f0' }}>15 seconds</strong> via the PrusaLink API.
          Polling runs concurrently — all printers are queried in parallel each tick.
          Unreachable printers show as <span style={{ color: '#6b7280' }}>OFFLINE</span> and do not affect other printers.
        </p>
      </section>
    </div>
  );
}

function Chip({ color, label }) {
  return (
    <span style={{
      background: '#0f172a',
      border: `1px solid ${color}40`,
      borderRadius: 20,
      padding: '3px 12px',
      fontSize: 13,
      color,
      fontWeight: 600,
    }}>
      {label}
    </span>
  );
}
