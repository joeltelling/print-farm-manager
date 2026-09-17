import { useState, useRef, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';
import PageHeader from '../components/PageHeader';

const inputStyle = {
  background: '#12131c',
  border: '1px solid #2d3146',
  borderRadius: 6,
  padding: '6px 10px',
  color: '#f4f4f5',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

const sectionStyle = {
  background: '#232639',
  border: '1px solid #2d3146',
  borderRadius: 10,
  padding: 20,
  marginBottom: 0,
  boxSizing: 'border-box',
};

const filePickStyle = {
  background: '#12131c',
  border: '1px solid #2d3146',
  borderRadius: 6,
  padding: '8px 12px',
  color: '#a1a1aa',
  fontSize: 13,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  maxWidth: '100%',
  boxSizing: 'border-box',
};

const delBtnStyle = {
  background: 'none',
  border: '1px solid #7f1d1d',
  borderRadius: 4,
  color: '#f87171',
  fontSize: 12,
  padding: '3px 10px',
  cursor: 'pointer',
  flexShrink: 0,
};

const CONNECTOR_OPTIONS = [
  { value: 'prusa',            label: 'Prusa (PrusaLink)' },
  { value: 'elegoo-centauri',  label: 'Elegoo (SDCP)' },
  { value: 'elegoo-centauri2', label: 'Elegoo CC2 (MQTT)' },
  { value: 'bambu',            label: 'Bambu (MQTT)' },
  { value: 'klipper',          label: 'Klipper (Moonraker)' },
  { value: 'octoprint',        label: 'OctoPrint' },
];
const CONNECTOR_LABEL = {
  'prusa':            'Prusa (PrusaLink)',
  'elegoo-centauri':  'Elegoo (SDCP)',
  'elegoo-centauri2': 'Elegoo CC2 (MQTT)',
  'bambu':            'Bambu (MQTT)',
  'klipper':          'Klipper (Moonraker)',
  'octoprint':        'OctoPrint',
};
// Connector types that do not use an API key
const NO_API_KEY_TYPES = new Set(['elegoo-centauri', 'klipper']);

// Per-brand hints on where to find connection credentials
const CREDENTIAL_HELP = {
  'prusa':            'API Key: on the printer under Settings → Network → PrusaLink, or in the PrusaLink web UI (open the printer\'s IP in a browser) under Settings → API Key.',
  'elegoo-centauri':  'No API key needed — just the printer\'s IP address, shown on the printer\'s network settings screen.',
  'elegoo-centauri2': 'Enable LAN mode on the printer. The Access Code and Serial Number are shown on the printer\'s network settings screen.',
  'bambu':            'Enable LAN Mode on the printer first. The Access Code is on the printer screen under Settings → WLAN; the Serial Number is under Settings → Device.',
  'klipper':          'No API key needed — just the IP of the machine running Moonraker. Port 7125 is used automatically.',
  'octoprint':        'API Key: in OctoPrint under Settings → API. If OctoPrint isn\'t on port 80 (commonly :5000), include the port in the IP field, e.g. 192.168.1.50:5000.',
};

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') || 'general';
  function setTab(id) { setSearchParams({ tab: id }); }
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [flaggedModels, setFlaggedModels] = useState({});
  const fileRef = useRef(null);
  const [csvFileName, setCsvFileName] = useState('');
  const [restoreFileName, setRestoreFileName] = useState('');

  // Add single printer
  // Printer models — fetched from DB, used throughout this page
  const [allModels, setAllModels] = useState([]);
  const [filamentTypes, setFilamentTypes] = useState([]);   // [{id, name}]
  const [filamentColors, setFilamentColors] = useState([]); // [{id, name, hex_color}]
  const [allGroups, setAllGroups] = useState([]);           // [{name, created_at}]
  const fetchModels = useCallback(() => {
    fetch('/api/models').then(r => r.json()).then(setAllModels).catch(() => {});
    fetch('/api/filaments/types').then(r => r.json()).then(setFilamentTypes).catch(() => {});
    fetch('/api/filaments/colors').then(r => r.json()).then(setFilamentColors).catch(() => {});
    fetch('/api/groups').then(r => r.json()).then(setAllGroups).catch(() => {});
  }, []);
  useEffect(() => { fetchModels(); }, [fetchModels]);

  // Filament Library management
  const [typeForm, setTypeForm] = useState({ name: '' });
  const [typeFormError, setTypeFormError] = useState(null);
  const [typeDeleteError, setTypeDeleteError] = useState({});

  async function handleAddType(e) {
    e.preventDefault();
    setTypeFormError(null);
    try {
      const res = await fetch('/api/filaments/types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: typeForm.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add type');
      setTypeForm({ name: '' });
      fetchModels();
      showToast('Filament type added');
    } catch (err) {
      setTypeFormError(err.message);
    }
  }

  async function handleDeleteType(id, name) {
    setTypeDeleteError(prev => ({ ...prev, [id]: null }));
    try {
      const res = await fetch(`/api/filaments/types/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      fetchModels();
      showToast(`"${name}" removed`);
    } catch (err) {
      setTypeDeleteError(prev => ({ ...prev, [id]: err.message }));
    }
  }

  const [colorForm, setColorForm] = useState({ type_id: '', name: '', hex_color: '' });
  const [colorFormError, setColorFormError] = useState(null);
  const [colorDeleteError, setColorDeleteError] = useState({});

  async function handleAddColor(e) {
    e.preventDefault();
    setColorFormError(null);
    try {
      const res = await fetch('/api/filaments/colors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type_id: parseInt(colorForm.type_id, 10),
          name: colorForm.name,
          hex_color: colorForm.hex_color || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add color');
      setColorForm({ type_id: '', name: '', hex_color: '' });
      fetchModels();
      showToast('Filament color added');
    } catch (err) {
      setColorFormError(err.message);
    }
  }

  async function handleDeleteColor(id, name) {
    setColorDeleteError(prev => ({ ...prev, [id]: null }));
    try {
      const res = await fetch(`/api/filaments/colors/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      fetchModels();
      showToast(`"${name}" removed`);
    } catch (err) {
      setColorDeleteError(prev => ({ ...prev, [id]: err.message }));
    }
  }

  const [addForm, setAddForm] = useState({ name: '', ip: '', api_key: '', serial_number: '', model: '', group_name: '', type: 'prusa', loaded_material: '', loaded_color: '' });
  const [addResult, setAddResult] = useState(null);
  const [addError, setAddError] = useState(null);
  const [adding, setAdding] = useState(false);

  // Keep the Model select's value valid whenever the available models change for the
  // selected brand — e.g. adding a printer model in the section above while this form is
  // open. Without this, the <select> can visually show the newly-added option (the browser
  // defaults to it once it's the only one) while addForm.model silently stays '', so the
  // submitted request fails required-field validation despite the dropdown looking selected.
  useEffect(() => {
    const validModels = allModels.filter(m => m.connector === addForm.type);
    if (!validModels.some(m => m.model_id === addForm.model)) {
      setAddForm(p => ({ ...p, model: validModels[0]?.model_id || '' }));
    }
  }, [allModels, addForm.type, addForm.model]);

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
          serial_number: addForm.serial_number.trim() || undefined,
          model: addForm.model,
          group_name: addForm.group_name.trim() || null,
          type: addForm.type,
          loaded_material: addForm.loaded_material.trim() || null,
          loaded_color: addForm.loaded_color.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Add failed');
      setAddResult(data);
      setAddForm({ name: '', ip: '', api_key: '', serial_number: '', model: 'mk4s', group_name: '', type: 'prusa', loaded_material: '', loaded_color: '' });
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  }

  // Printer Models management
  const [modelForm, setModelForm] = useState({ model_id: '', label: '', connector: 'prusa' });
  const [modelFormError, setModelFormError] = useState(null);
  const [modelDeleteError, setModelDeleteError] = useState({});

  async function handleAddModel(e) {
    e.preventDefault();
    setModelFormError(null);
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add model');
      setModelForm({ model_id: '', label: '', connector: 'prusa' });
      fetchModels();
      showToast('Model added');
    } catch (err) {
      setModelFormError(err.message);
    }
  }

  async function handleDeleteModel(model_id) {
    setModelDeleteError(prev => ({ ...prev, [model_id]: null }));
    try {
      const res = await fetch(`/api/models/${encodeURIComponent(model_id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete model');
      fetchModels();
    } catch (err) {
      setModelDeleteError(prev => ({ ...prev, [model_id]: err.message }));
    }
  }

  // Groups management: the persisted registry a G-code's or project's
  // allowed_groups restriction is picked from. Independent of which printers
  // currently carry a given group_name (see printer_groups in db.js).
  const [groupForm, setGroupForm] = useState({ name: '' });
  const [groupFormError, setGroupFormError] = useState(null);
  const [groupDeleteError, setGroupDeleteError] = useState({});

  async function handleAddGroup(e) {
    e.preventDefault();
    setGroupFormError(null);
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(groupForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add group');
      setGroupForm({ name: '' });
      fetchModels();
      showToast('Group added');
    } catch (err) {
      setGroupFormError(err.message);
    }
  }

  async function handleDeleteGroup(name) {
    setGroupDeleteError(prev => ({ ...prev, [name]: null }));
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete group');
      fetchModels();
    } catch (err) {
      setGroupDeleteError(prev => ({ ...prev, [name]: err.message }));
    }
  }

  // Dispatch batch size setting
  const [batchSize, setBatchSize] = useState('');
  const [batchSizeError, setBatchSizeError] = useState(null);

  // Site name — shown in the sidebar; picked up on next page load
  const [farmName, setFarmName] = useState('');
  const [farmNameError, setFarmNameError] = useState(null);
  const [cameraMode, setCameraMode] = useState('snapshot');
  const [cameraModeError, setCameraModeError] = useState(null);
  const [tlEnabled, setTlEnabled] = useState('true');
  const [tlInterval, setTlInterval] = useState('10');
  const [tlFps, setTlFps] = useState('10');
  const [tlRetention, setTlRetention] = useState('30');
  const [tlError, setTlError] = useState(null);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        if (data.dispatch_batch_size) setBatchSize(data.dispatch_batch_size);
        if (data.farm_name) setFarmName(data.farm_name);
        if (data.camera_mode) setCameraMode(data.camera_mode);
        if (data.timelapse_enabled != null) setTlEnabled(data.timelapse_enabled);
        if (data.timelapse_interval_seconds) setTlInterval(data.timelapse_interval_seconds);
        if (data.timelapse_fps) setTlFps(data.timelapse_fps);
        if (data.timelapse_retention_days) setTlRetention(data.timelapse_retention_days);
      })
      .catch(() => {});
  }, []);

  async function handleSaveBatchSize() {
    setBatchSizeError(null);
    try {
      const res = await fetch('/api/settings/dispatch_batch_size', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: batchSize }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      showToast('Saved');
    } catch (err) {
      setBatchSizeError(err.message);
    }
  }

  async function handleSaveFarmName() {
    setFarmNameError(null);
    try {
      const res = await fetch('/api/settings/farm_name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: farmName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      window.dispatchEvent(new CustomEvent('farmNameChanged', { detail: data.value }));
      showToast('Site name saved');
    } catch (err) {
      setFarmNameError(err.message);
    }
  }

  async function handleSaveCameraMode() {
    setCameraModeError(null);
    try {
      const res = await fetch('/api/settings/camera_mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: cameraMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      showToast('Camera mode saved');
    } catch (err) {
      setCameraModeError(err.message);
    }
  }

  async function handleSaveTimelapse() {
    setTlError(null);
    try {
      for (const [key, value] of [
        ['timelapse_enabled', tlEnabled],
        ['timelapse_interval_seconds', tlInterval],
        ['timelapse_fps', tlFps],
        ['timelapse_retention_days', tlRetention],
      ]) {
        const res = await fetch(`/api/settings/${key}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Save ${key} failed`);
      }
      showToast('Timelapse settings saved');
    } catch (err) {
      setTlError(err.message);
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
    const ok = await confirm({
      title: 'Restore CoMa Data',
      message: 'This replaces all CoMa data present in the backup, including shopfloor and embedded ERP records. This cannot be undone.',
      confirmLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;

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

      // Restore replaces printer_models/groups/filament library/settings wholesale:
      // refresh this page's state (and the sidebar site name) instead of requiring a reload.
      fetchModels();
      fetch('/api/settings')
        .then(r => r.json())
        .then(settingsData => {
          if (settingsData.dispatch_batch_size) setBatchSize(settingsData.dispatch_batch_size);
          setFarmName(settingsData.farm_name || '');
          if (settingsData.camera_mode) setCameraMode(settingsData.camera_mode);
          window.dispatchEvent(new CustomEvent('farmNameChanged', { detail: settingsData.farm_name || 'CoMa' }));
        })
        .catch(() => {});
    } catch (err) {
      setRestoreError(err.message);
    } finally {
      setRestoring(false);
      if (restoreFileRef.current) restoreFileRef.current.value = '';
      setRestoreFileName('');
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
      setCsvFileName('');
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
      showToast(`"${row.name}" saved as ${selectedModel}`);
      setResult((prev) => ({
        ...prev,
        flagged: prev.flagged.filter((f) => f !== flaggedItem),
        imported: prev.imported + 1,
      }));
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  }

  return (
    <div className="coma-settings">
      <style>{`
        .coma-settings-columns {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px 24px;
          align-items: start;
        }
        .coma-settings-col {
          display: flex;
          flex-direction: column;
          gap: 16px;
          min-width: 0;
        }
        .coma-settings-list {
          border: 1px solid #2d3146;
          border-radius: 8px;
          overflow: hidden;
          margin-bottom: 16px;
          background: #121722;
        }
        .coma-settings-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border-bottom: 1px solid #232639;
          min-height: 44px;
          box-sizing: border-box;
        }
        .coma-settings-row:last-child { border-bottom: none; }
        .coma-settings-row:hover { background: #161b27; }
        .coma-settings-row-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 6px 12px;
        }
        @media (max-width: 1100px) {
          .coma-settings-columns { grid-template-columns: 1fr; }
        }
      `}</style>
      {toastEl}
      {confirmModal}
      <PageHeader title="Settings" subtitle="Site, hardware, materials, and backup" />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        {[
          { id: 'general', label: 'General' },
          { id: 'hardware', label: 'Hardware' },
          { id: 'materials', label: 'Materials' },
          { id: 'alerts', label: 'Alerts' },
          { id: 'backup', label: 'Backup' },
          { id: 'about', label: 'About' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              background: tab === t.id ? '#5b21b6' : '#1a2332',
              color: tab === t.id ? '#fff' : '#a1a1aa',
              border: `1px solid ${tab === t.id ? '#5b21b6' : '#2d3146'}`,
              borderRadius: 999,
              padding: '6px 14px',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Server Alerts */}
      {tab === 'alerts' && (
        <section style={{ background: '#232639', borderRadius: 10, padding: 20, marginBottom: 24, maxWidth: 640, border: '1px solid #7f1d1d' }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12, color: '#fca5a5' }}>
            Server Alerts ({alerts.length})
          </h2>
          {alerts.length === 0 && (
            <p style={{ color: '#71717a', fontSize: 13, margin: 0 }}>No server alerts right now.</p>
          )}
          {alerts.map(alert => (
            <div key={alert.id} style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
              background: '#181a27',
              border: '1px solid #7f1d1d',
              borderRadius: 6,
              padding: '10px 12px',
              marginBottom: 8,
              fontSize: 13,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: '#fca5a5', marginBottom: 4 }}>{alert.message}</div>
                <div style={{ color: '#52525b', fontSize: 12 }}>
                  {new Date(alert.timestamp).toLocaleString()}
                </div>
              </div>
              <button
                onClick={() => dismissAlert(alert.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#71717a',
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

      {/* Hardware */}
      {tab === 'hardware' && (
      <div className="coma-settings-columns">
      <div className="coma-settings-col">
<section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Printer Models</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 16 }}>
          Configure which printer models are available on your shopfloor. Models appear in the G-code upload
          selector and the Add Printer form. Deleting a model is blocked if active printers use it.
        </p>

        {allModels.length > 0 && (
          <div className="coma-settings-list">
            {allModels.map(m => (
              <div key={m.model_id} className="coma-settings-row">
                <div className="coma-settings-row-main">
                  <span style={{ color: '#f4f4f5', fontWeight: 600 }}>{m.label}</span>
                  <span style={{ color: '#a1a1aa', fontFamily: 'monospace', fontSize: 12 }}>{m.model_id}</span>
                  <span style={{ color: '#71717a', fontSize: 12 }}>{CONNECTOR_LABEL[m.connector] || m.connector}</span>
                  {modelDeleteError[m.model_id] && (
                    <span style={{ color: '#fca5a5', fontSize: 12 }}>{modelDeleteError[m.model_id]}</span>
                  )}
                </div>
                <button onClick={() => handleDeleteModel(m.model_id)} style={delBtnStyle}>Delete</button>
              </div>
            ))}
          </div>
        )}

        {allModels.length === 0 && (
          <p style={{ color: '#52525b', fontSize: 13, marginBottom: 16 }}>No models configured yet. Add your first model below.</p>
        )}

        <form onSubmit={handleAddModel} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignItems: 'end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Model ID *</label>
            <input
              value={modelForm.model_id}
              onChange={e => setModelForm(p => ({ ...p, model_id: e.target.value }))}
              required
              placeholder="x1c"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Label *</label>
            <input
              value={modelForm.label}
              onChange={e => setModelForm(p => ({ ...p, label: e.target.value }))}
              required
              placeholder="X1 Carbon"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Connector *</label>
            <select
              value={modelForm.connector}
              onChange={e => setModelForm(p => ({ ...p, connector: e.target.value }))}
              style={inputStyle}
            >
              {CONNECTOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <button
            type="submit"
            style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            Add
          </button>
        </form>
        {modelFormError && (
          <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{modelFormError}</div>
        )}
      </section>
{/* Groups */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Groups</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 16 }}>
          Named groups (e.g. racks or rooms) that projects and G-codes can restrict dispatch to. A group
          stays listed here even when no printer currently carries it (assigning a printer's Group field
          on the Printers page auto-registers a new name here too). Deleting a group is blocked while any
          active printer, G-code, or project still references it.
        </p>

        {allGroups.length > 0 && (
          <div className="coma-settings-list">
            {allGroups.map(g => (
              <div key={g.name} className="coma-settings-row">
                <div className="coma-settings-row-main">
                  <span style={{ color: '#f4f4f5', fontWeight: 600 }}>{g.name}</span>
                  {groupDeleteError[g.name] && (
                    <span style={{ color: '#fca5a5', fontSize: 12 }}>{groupDeleteError[g.name]}</span>
                  )}
                </div>
                <button onClick={() => handleDeleteGroup(g.name)} style={delBtnStyle}>Delete</button>
              </div>
            ))}
          </div>
        )}

        {allGroups.length === 0 && (
          <p style={{ color: '#52525b', fontSize: 13, marginBottom: 16 }}>No groups registered yet. Add one below, or it'll be created automatically the first time you type it on a printer.</p>
        )}

        <form onSubmit={handleAddGroup} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Name *</label>
            <input
              value={groupForm.name}
              onChange={e => setGroupForm({ name: e.target.value })}
              required
              placeholder="Rack A"
              style={inputStyle}
            />
          </div>
          <button
            type="submit"
            style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            Add
          </button>
        </form>
        {groupFormError && (
          <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{groupFormError}</div>
        )}
      </section>
      </div>
      <div className="coma-settings-col">
<section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Add Printer</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 12 }}>
          Add a single printer directly without a CSV file.
        </p>
        <div style={{
          background: '#16213a',
          borderLeft: '3px solid #7c3aed',
          borderRadius: 6,
          padding: '8px 12px',
          fontSize: 12.5,
          color: '#a1a1aa',
          marginBottom: 16,
          lineHeight: 1.5,
        }}>
          {CREDENTIAL_HELP[addForm.type]}
        </div>
        <form onSubmit={handleAddPrinter}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Brand *</label>
              <select
                value={addForm.type}
                onChange={e => {
                  const t = e.target.value;
                  const first = allModels.find(m => m.connector === t);
                  setAddForm(p => ({ ...p, type: t, model: first?.model_id || '', serial_number: '' }));
                }}
                style={inputStyle}
              >
                {CONNECTOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Model *</label>
              <select
                value={addForm.model}
                onChange={e => setAddForm(p => ({ ...p, model: e.target.value }))}
                style={inputStyle}
              >
                {allModels.filter(m => m.connector === addForm.type).length === 0
                ? <option value="">— no models configured —</option>
                : allModels.filter(m => m.connector === addForm.type).map(m => (
                    <option key={m.model_id} value={m.model_id}>{m.label}</option>
                  ))}
              </select>
              {allModels.filter(m => m.connector === addForm.type).length === 0 && (
                <div style={{ fontSize: 11.5, color: '#fbbf24', marginTop: 4 }}>
                  No models for this brand yet — add one in Printer Models above first.
                </div>
              )}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Name *</label>
              <input
                value={addForm.name}
                onChange={e => setAddForm(p => ({ ...p, name: e.target.value }))}
                required
                placeholder={addForm.type === 'elegoo-centauri' ? 'Centauri_01' : addForm.type === 'elegoo-centauri2' ? 'CC2_01' : addForm.type === 'bambu' ? 'Bambu_X1C_01' : addForm.type === 'klipper' ? 'Voron_01' : addForm.type === 'octoprint' ? 'OctoPi_01' : 'MK4S_11'}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>IP Address *</label>
              <input
                value={addForm.ip}
                onChange={e => setAddForm(p => ({ ...p, ip: e.target.value }))}
                required
                placeholder="192.168.1.100"
                style={inputStyle}
              />
            </div>
            {(addForm.type === 'bambu' || addForm.type === 'elegoo-centauri2') && (
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Serial Number *</label>
                <input
                  value={addForm.serial_number}
                  onChange={e => setAddForm(p => ({ ...p, serial_number: e.target.value }))}
                  required
                  placeholder={addForm.type === 'bambu' ? '00M09C123400789' : 'CC2-XXXXXX'}
                  style={inputStyle}
                />
              </div>
            )}
            {!NO_API_KEY_TYPES.has(addForm.type) && (
              <div>
                <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>
                  {addForm.type === 'bambu' || addForm.type === 'elegoo-centauri2' ? 'Access Code *' : 'API Key *'}
                </label>
                <input
                  value={addForm.api_key}
                  onChange={e => setAddForm(p => ({ ...p, api_key: e.target.value }))}
                  required
                  placeholder={addForm.type === 'bambu' || addForm.type === 'elegoo-centauri2' ? 'Ab12Cd' : 'xxxxxxxxxxxxxxxx'}
                  style={inputStyle}
                />
              </div>
            )}
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Group (optional)</label>
              <input
                value={addForm.group_name}
                onChange={e => setAddForm(p => ({ ...p, group_name: e.target.value }))}
                placeholder="Rack A"
                list="add-printer-group-options"
                style={inputStyle}
              />
              <datalist id="add-printer-group-options">
                {allGroups.map(g => <option key={g.name} value={g.name} />)}
              </datalist>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Loaded Material</label>
              <select
                value={addForm.loaded_material}
                onChange={e => setAddForm(p => ({ ...p, loaded_material: e.target.value, loaded_color: '' }))}
                style={inputStyle}
              >
                <option value="">— none —</option>
                {filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Loaded Color</label>
              <select
                value={addForm.loaded_color}
                onChange={e => setAddForm(p => ({ ...p, loaded_color: e.target.value }))}
                disabled={!addForm.loaded_material}
                style={inputStyle}
              >
                <option value="">— none —</option>
                {filamentColors
                  .filter(c => c.type_name === addForm.loaded_material)
                  .map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={adding}
            style={{
              background: adding ? '#5b21b6' : '#7c3aed',
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
          <div style={{ marginTop: 14, background: '#062b22', borderRadius: 6, padding: '10px 14px', color: '#34d399', fontSize: 13 }}>
            Printer <strong>{addResult.name}</strong> added (ID #{addResult.id}).
          </div>
        )}
      </section>
{/* CSV Import */}
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Import Printer Registry</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 16 }}>
          Upload a CSV with columns: <code style={{ color: '#a1a1aa' }}>model, name, ip, api_key, group, type</code>.<br />
          Model field value is the ID from the Printer Models list above. Missing mandatory fields and duplicate names are skipped.
        </p>

        <form onSubmit={handleImport} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            required
            style={{ display: 'none' }}
            onChange={e => setCsvFileName(e.target.files?.[0]?.name || '')}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            style={{ ...filePickStyle, flex: '1 1 220px', color: csvFileName ? '#f4f4f5' : '#a1a1aa' }}
          >
            <span style={{
              background: '#181a27', border: '1px solid #2d3146', borderRadius: 4,
              padding: '2px 8px', fontSize: 12, color: '#a5b4fc', fontWeight: 600, flexShrink: 0,
            }}>
              Choose file
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {csvFileName || 'No file selected'}
            </span>
          </button>
          <button
            type="submit"
            disabled={importing}
            style={{
              background: importing ? '#5b21b6' : '#7c3aed',
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
              <Chip color="#34d399" label={`${result.imported} imported`} />
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
                    background: '#181a27',
                    border: '1px solid #7f1d1d',
                    borderRadius: 6,
                    padding: '10px 12px',
                    marginBottom: 8,
                    fontSize: 13,
                  }}>
                    <div style={{ fontWeight: 600, color: '#fca5a5', marginBottom: 4 }}>{f.row.name}</div>
                    <div style={{ color: '#a1a1aa', marginBottom: 8 }}>{f.reason}</div>
                    {f.reason.includes('Cannot infer model') && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <select
                          value={flaggedModels[i] || allModels[0]?.model_id || ''}
                          onChange={(e) => setFlaggedModels((prev) => ({ ...prev, [i]: e.target.value }))}
                          style={{
                            background: '#12131c',
                            border: '1px solid #2d3146',
                            borderRadius: 4,
                            padding: '4px 8px',
                            color: '#f4f4f5',
                            fontSize: 13,
                          }}
                        >
                          {allModels.map((m) => <option key={m.model_id} value={m.model_id}>{m.label}</option>)}
                        </select>
                        <button
                          onClick={() => handleSaveFlagged(f, flaggedModels[i] || allModels[0]?.model_id || '')}
                          style={{
                            background: '#047857',
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
      </div>
      </div>
      )}


      {/* Filament Library */}
      {tab === 'materials' && (
      <>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Filament Library</h2>
        <p style={{ color: '#71717a', fontSize: 13, margin: 0 }}>
          Define the filament types and colors available on your shopfloor. Printers and G-codes select from these lists.
        </p>
      </div>
      <div className="coma-settings-columns">
      <div className="coma-settings-col">
      <section style={sectionStyle}>
{/* Filament Types */}
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa', marginBottom: 10 }}>Types</h3>
        {filamentTypes.length > 0 && (
          <div className="coma-settings-list">
            {filamentTypes.map(t => (
              <div key={t.id} className="coma-settings-row">
                <div className="coma-settings-row-main">
                  <span style={{ color: '#f4f4f5', fontWeight: 600 }}>{t.name}</span>
                  {typeDeleteError[t.id] && (
                    <span style={{ color: '#fca5a5', fontSize: 12 }}>{typeDeleteError[t.id]}</span>
                  )}
                </div>
                <button onClick={() => handleDeleteType(t.id, t.name)} style={delBtnStyle}>Delete</button>
              </div>
            ))}
          </div>
        )}
        {filamentTypes.length === 0 && (
          <p style={{ color: '#52525b', fontSize: 13, marginBottom: 12 }}>No types yet. Add your first below.</p>
        )}
        <form onSubmit={handleAddType} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Type name *</label>
            <input
              value={typeForm.name}
              onChange={e => setTypeForm(p => ({ ...p, name: e.target.value }))}
              required
              placeholder="e.g. PLA, PETG, ASA"
              style={inputStyle}
            />
          </div>
          <button
            type="submit"
            style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            Add Type
          </button>
        </form>
        {typeFormError && <div style={{ marginTop: -16, marginBottom: 16, color: '#fca5a5', fontSize: 13 }}>{typeFormError}</div>}
      </section>
      </div>
      <div className="coma-settings-col">
      <section style={sectionStyle}>
{/* Filament Colors */}
        <h3 style={{ fontSize: 14, fontWeight: 600, color: '#a1a1aa', marginBottom: 10 }}>Colors</h3>
        {filamentColors.length > 0 && (
          <div className="coma-settings-list">
            {filamentColors.map(c => (
              <div key={c.id} className="coma-settings-row">
                <div className="coma-settings-row-main">
                  <span style={{
                    display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
                    background: c.hex_color || '#2d3146', border: '1px solid #52525b', flexShrink: 0,
                  }} title={c.hex_color || 'no color set'} />
                  <span style={{ color: '#f4f4f5', fontWeight: 600 }}>{c.name}</span>
                  <span style={{ color: '#71717a', fontSize: 12 }}>{c.type_name}</span>
                  {c.hex_color && <span style={{ color: '#52525b', fontSize: 11, fontFamily: 'monospace' }}>{c.hex_color}</span>}
                  {colorDeleteError[c.id] && (
                    <span style={{ color: '#fca5a5', fontSize: 12 }}>{colorDeleteError[c.id]}</span>
                  )}
                </div>
                <button onClick={() => handleDeleteColor(c.id, c.name)} style={delBtnStyle}>Delete</button>
              </div>
            ))}
          </div>
        )}
        {filamentColors.length === 0 && (
          <p style={{ color: '#52525b', fontSize: 13, marginBottom: 12 }}>No colors yet. Add your first below.</p>
        )}
        <form onSubmit={handleAddColor} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: 8, alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Type *</label>
            <select
              value={colorForm.type_id}
              onChange={e => setColorForm(p => ({ ...p, type_id: e.target.value }))}
              required
              style={inputStyle}
            >
              <option value="">Select type…</option>
              {filamentTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Color name *</label>
            <input
              value={colorForm.name}
              onChange={e => setColorForm(p => ({ ...p, name: e.target.value }))}
              required
              placeholder="e.g. Black, Galaxy Red"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Hex (optional)</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="color"
                value={colorForm.hex_color || '#000000'}
                onChange={e => setColorForm(p => ({ ...p, hex_color: e.target.value }))}
                style={{ width: 36, height: 34, padding: 2, background: '#12131c', border: '1px solid #2d3146', borderRadius: 4, cursor: 'pointer' }}
                title="Pick a color"
              />
              <input
                value={colorForm.hex_color}
                onChange={e => setColorForm(p => ({ ...p, hex_color: e.target.value }))}
                placeholder="#rrggbb"
                style={{ ...inputStyle, width: 90, fontFamily: 'monospace' }}
              />
            </div>
          </div>
          <button
            type="submit"
            style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', alignSelf: 'flex-end' }}
          >
            Add Color
          </button>
        </form>
        {colorFormError && <div style={{ marginTop: 8, color: '#fca5a5', fontSize: 13 }}>{colorFormError}</div>}
      </section>
      </div>
      </div>
      </>
      )}




      {/* General */}
      {tab === 'general' && (
      <div className="coma-settings-columns">
      <div className="coma-settings-col">
<section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Site name</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 16 }}>
          Shown in the sidebar. Defaults to CoMa if left empty after a restore with no name.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={farmName}
            onChange={e => setFarmName(e.target.value)}
            placeholder="CoMa"
            maxLength={40}
            style={{ ...inputStyle, width: 240 }}
          />
          <button
            onClick={handleSaveFarmName}
            style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            Save
          </button>
        </div>
        {farmNameError && (
          <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{farmNameError}</div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Camera</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 16 }}>
          Default feed on the printer incident screen. Snapshot (low) refreshes a still every 5 seconds. Stream uses MJPEG. Klipper printers only; implemented from Moonraker webcam docs, not yet validated on physical hardware.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            value={cameraMode}
            onChange={e => setCameraMode(e.target.value)}
            style={{ ...inputStyle, width: 180 }}
          >
            <option value="snapshot">Low (snapshot)</option>
            <option value="stream">Stream</option>
          </select>
          <button
            onClick={handleSaveCameraMode}
            style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            Save
          </button>
        </div>
        {cameraModeError && (
          <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{cameraModeError}</div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Timelapse</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 16 }}>
          Capture JPEG frames while a job is PRINTING (or start manually on a printer). Render to MP4 with ffmpeg when available. Interval is independent of the 15 s poll loop. Not yet validated on physical hardware beyond the Klipper simulator.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: '#71717a', marginBottom: 4 }}>Enabled</label>
            <select value={tlEnabled} onChange={e => setTlEnabled(e.target.value)} style={{ ...inputStyle, width: 120 }}>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: '#71717a', marginBottom: 4 }}>Interval (s)</label>
            <input value={tlInterval} onChange={e => setTlInterval(e.target.value)} style={{ ...inputStyle, width: 90 }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: '#71717a', marginBottom: 4 }}>FPS</label>
            <input value={tlFps} onChange={e => setTlFps(e.target.value)} style={{ ...inputStyle, width: 90 }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: '#71717a', marginBottom: 4 }}>Retention (days)</label>
            <input value={tlRetention} onChange={e => setTlRetention(e.target.value)} style={{ ...inputStyle, width: 110 }} />
          </div>
          <button
            onClick={handleSaveTimelapse}
            style={{ background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            Save
          </button>
        </div>
        {tlError && (
          <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{tlError}</div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Polling</h2>
        <p style={{ color: '#71717a', fontSize: 13, margin: 0 }}>
          All printers are polled every <strong style={{ color: '#f4f4f5' }}>15 seconds</strong> via their connector API.
          Polling runs concurrently — all printers are queried in parallel each tick.
          Unreachable printers show as <span style={{ color: '#71717a' }}>OFFLINE</span> and do not affect other printers.
        </p>
      </section>

      {/* Dispatch Settings */}
      </div>
      <div className="coma-settings-col">
<section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Dispatch Settings</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 16 }}>
          The scheduler keeps this many printers uploading or printing at once, pulling
          further down the ready queue to fill that target even if some printers have no
          matching work right now. Reduce this number if your network is saturated during
          large uploads.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>
              Concurrent printers (1-100)
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
              background: '#7c3aed',
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
        </div>
        {batchSizeError && (
          <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 13 }}>{batchSizeError}</div>
        )}
      </section>
      </div>
      </div>
      )}


      {/* CoMa Backup / Restore */}
      {tab === 'backup' && (
      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>CoMa Backup</h2>
        <p style={{ color: '#71717a', fontSize: 13, marginBottom: 16 }}>
          Export one complete snapshot containing shopfloor, G-code files, settings, and all
          embedded ERP data. Use this file to restore on another machine or recover from data loss.
        </p>

        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Export */}
          <button
            onClick={handleExport}
            style={{
              background: '#0f3460',
              color: '#a5b4fc',
              border: '1px solid #5b21b6',
              borderRadius: 6,
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Export CoMa
          </button>

          {/* Restore */}
          <form onSubmit={handleRestore} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', flex: '1 1 280px' }}>
            <input
              ref={restoreFileRef}
              type="file"
              accept=".json"
              required
              style={{ display: 'none' }}
              onChange={e => setRestoreFileName(e.target.files?.[0]?.name || '')}
            />
            <button
              type="button"
              onClick={() => restoreFileRef.current?.click()}
              style={{ ...filePickStyle, flex: '1 1 200px', color: restoreFileName ? '#f4f4f5' : '#a1a1aa' }}
            >
              <span style={{
                background: '#181a27', border: '1px solid #2d3146', borderRadius: 4,
                padding: '2px 8px', fontSize: 12, color: '#a5b4fc', fontWeight: 600, flexShrink: 0,
              }}>
                Choose file
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {restoreFileName || 'No file selected'}
              </span>
            </button>
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
              {restoring ? 'Restoring...' : 'Restore CoMa'}
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
            <div style={{ color: '#34d399', fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
              CoMa data restored successfully
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Chip color="#34d399" label={`${restoreResult.printers} printers`} />
              <Chip color="#34d399" label={`${restoreResult.projects} projects`} />
              <Chip color="#34d399" label={`${restoreResult.parts} parts`} />
              <Chip color="#34d399" label={`${restoreResult.gcodes} G-codes`} />
              <Chip color="#34d399" label={`${restoreResult.jobs} jobs`} />
              <Chip color="#34d399" label={`${restoreResult.printer_models ?? 0} printer models`} />
              <Chip color="#34d399" label={`${restoreResult.printer_groups ?? 0} groups`} />
              <Chip color="#34d399" label={`${restoreResult.filament_types ?? 0} filament types`} />
              <Chip color="#34d399" label={`${restoreResult.filament_colors ?? 0} filament colors`} />
              <Chip
                color="#34d399"
                label={restoreResult.erp
                  ? `${Object.keys(restoreResult.erp).length} ERP tables`
                  : 'existing ERP preserved'}
              />
            </div>
          </div>
        )}
      </section>
      )}

      {/* About */}
      {tab === 'about' && (
      <section style={{ maxWidth: 640, borderTop: '1px solid #232639', paddingTop: 24 }}>
        <p style={{ color: '#a1a1aa', fontSize: 14, lineHeight: 1.7, marginBottom: 8 }}>
          <strong style={{ color: '#f4f4f5' }}>CoMa</strong> (core-manufacturing) is maintained by{' '}
          <a
            href="https://github.com/mdwcoder"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#a78bfa', textDecoration: 'none', fontWeight: 600 }}
          >
            mdwcoder
          </a>
          . It is a Linux-focused fork of a fantastic open-source print farm manager: the solid
          scheduling, multi-brand drivers, and operator safety model are what made this
          possible. This fork grows CoMa into manufacturing (ERP + shopfloor), with denser UX,
          Klipper camera proxying, PWA install, and more, while staying compatible with the
          upstream ideas.
        </p>
        <p style={{ color: '#71717a', fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
          If CoMa helps your manufacturing run smoother, a sponsorship keeps the lights on for
          continued work on this fork. Thank you, and happy printing.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 28 }}>
          <a
            href="https://github.com/sponsors/mdwcoder"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: '#8b5cf6', color: '#fff',
              padding: '9px 18px', borderRadius: 8,
              fontSize: 13, fontWeight: 700, textDecoration: 'none',
            }}
          >
            Sponsor mdwcoder on GitHub
          </a>
          <a
            href="https://github.com/mdwcoder/core-manufacturing"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: '#141620', color: '#a1a1aa',
              border: '1px solid #2d3146',
              padding: '9px 16px', borderRadius: 8,
              fontSize: 13, fontWeight: 600, textDecoration: 'none',
            }}
          >
            GitHub repo
          </a>
        </div>

        <details style={{
          borderTop: '1px solid #232639',
          paddingTop: 12,
          color: '#52525b',
        }}>
          <summary style={{
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 500,
            color: '#52525b',
            userSelect: 'none',
          }}>
            Original project
          </summary>
          <div style={{ marginTop: 12, paddingLeft: 2 }}>
            <p style={{ color: '#52525b', fontSize: 12, lineHeight: 1.65, marginBottom: 12 }}>
              Upstream is{' '}
              <a
                href="https://github.com/joeltelling/print-farm-manager"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#71717a', textDecoration: 'underline' }}
              >
                print-farm-manager
              </a>
              {' '}by Joel (aka 3D Printing Nerd). He built and open-sourced the base tool this
              fork stands on. If you want to support the original author directly, his channels
              are below.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <a
                href="https://buymeacoffee.com/3dprintingnerd"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: 'transparent', color: '#71717a',
                  border: '1px solid #2d3146',
                  padding: '5px 12px', borderRadius: 6,
                  fontSize: 12, fontWeight: 600, textDecoration: 'none',
                }}
              >
                Buy Me a Coffee
              </a>
              <a
                href="https://paypal.me/JoelTelling"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: 'transparent', color: '#71717a',
                  border: '1px solid #2d3146',
                  padding: '5px 12px', borderRadius: 6,
                  fontSize: 12, fontWeight: 600, textDecoration: 'none',
                }}
              >
                PayPal
              </a>
            </div>
          </div>
        </details>
      </section>
      )}
    </div>
  );
}

function Chip({ color, label }) {
  return (
    <span style={{
      background: '#12131c',
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
