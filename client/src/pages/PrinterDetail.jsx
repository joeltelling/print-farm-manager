import { useState, useEffect, useCallback } from 'react';
import { cameraTransform } from '../cameraTransform';
import { useParams, useNavigate } from 'react-router-dom';

function formatTimestamp(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatHours(ms) {
  if (!ms || ms <= 0) return '0h';
  const h = ms / 3600000;
  return h >= 100 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

const EVENT_META = {
  decommission:  { label: 'Decommissioned', bg: '#7f1d1d', color: '#fca5a5' },
  recommission:  { label: 'Recommissioned', bg: '#14532d', color: '#86efac' },
  job_finished:  { label: 'Job Finished',   bg: '#1e3a5f', color: '#93c5fd' },
  job_failed:    { label: 'Job Failed',      bg: '#78350f', color: '#fcd34d' },
  note:          { label: 'Note',            bg: '#1e2433', color: '#94a3b8' },
  info_changed:  { label: 'Info Updated',   bg: '#1e2a3a', color: '#7dd3fc' },
};

function EventBadge({ type }) {
  const m = EVENT_META[type] || { label: type, bg: '#1e2433', color: '#64748b' };
  return (
    <span style={{
      background: m.bg, color: m.color,
      borderRadius: 4, padding: '2px 9px',
      fontSize: 11, fontWeight: 700,
      letterSpacing: '0.04em', whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

const STATUS_COLORS = {
  IDLE:     { bg: '#1e3a5f', text: '#93c5fd' },
  PRINTING: { bg: '#14532d', text: '#86efac' },
  FINISHED: { bg: '#14532d', text: '#86efac' },
  PAUSED:   { bg: '#78350f', text: '#fcd34d' },
  ERROR:    { bg: '#7f1d1d', text: '#fca5a5' },
  OFFLINE:  { bg: '#1e2433', text: '#475569' },
  UNKNOWN:  { bg: '#1e2433', text: '#475569' },
};

const detailLabelStyle = {
  display: 'flex', flexDirection: 'column', gap: 3,
  fontSize: 11, fontWeight: 600, color: '#64748b',
  letterSpacing: '0.04em', textTransform: 'uppercase',
};

const detailInputStyle = {
  background: '#1e2433', border: '1px solid #2d3748',
  borderRadius: 5, color: '#e2e8f0',
  fontSize: 13, fontWeight: 400,
  padding: '5px 9px', outline: 'none',
  fontFamily: 'inherit',
};

export default function PrinterDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [printer, setPrinter]   = useState(null);
  const [events, setEvents]     = useState([]);
  const [stats, setStats]       = useState(null);
  const [camera, setCamera]     = useState(null);
  const [cameraError, setCameraError] = useState(false);
  const [liveView, setLiveView] = useState(false);
  const [jobHistory, setJobHistory] = useState({ jobs: [], page: 1, total_pages: 1, total: 0 });
  const [jobPage, setJobPage]   = useState(1);
  const [loading, setLoading]   = useState(true);
  const [note, setNote]         = useState('');
  const [saving, setSaving]     = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft]     = useState('');
  const [nameError, setNameError]     = useState(null);
  const [renaming, setRenaming]       = useState(false);
  const [models, setModels]           = useState([]);
  const [filamentTypes, setFilamentTypes]   = useState([]);
  const [filamentColors, setFilamentColors] = useState([]);
  const [groups, setGroups]                 = useState([]);
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft]     = useState({});
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult]         = useState(null); // { ok, message } | null
  const [cameraList, setCameraList]         = useState(null); // [{ uid, name, enabled }] | null
  const [loadingCameras, setLoadingCameras] = useState(false);
  const [detailsError, setDetailsError]     = useState(null);
  const [savingDetails, setSavingDetails]   = useState(false);
  const [catalogDismissed, setCatalogDismissed] = useState(false);
  const [catalogOptions, setCatalogOptions] = useState(null); // { projects, parts }
  const [catalogForm, setCatalogForm]       = useState({ part_id: '', parts_per_plate: '', note: '' });
  const [catalogError, setCatalogError]     = useState(null);
  const [catalogSaving, setCatalogSaving]   = useState(false);

  const fetchData = useCallback(async () => {
    const [printerRes, eventsRes, statsRes, modelsRes, typesRes, colorsRes, groupsRes, cameraRes] = await Promise.all([
      fetch(`/api/printers/${id}`),
      fetch(`/api/printers/${id}/events`),
      fetch(`/api/printers/${id}/jobs/stats`),
      fetch('/api/models'),
      fetch('/api/filaments/types'),
      fetch('/api/filaments/colors'),
      fetch('/api/groups'),
      fetch(`/api/printers/${id}/camera`),
    ]);
    if (printerRes.ok)  setPrinter(await printerRes.json());
    if (eventsRes.ok)   setEvents(await eventsRes.json());
    if (statsRes.ok)    setStats(await statsRes.json());
    if (modelsRes.ok)   setModels(await modelsRes.json());
    if (typesRes.ok)    setFilamentTypes(await typesRes.json());
    if (colorsRes.ok)   setFilamentColors(await colorsRes.json());
    if (groupsRes.ok)   setGroups((await groupsRes.json()).map(g => g.name));
    setCameraError(false);
    setLiveView(false);
    setCamera(cameraRes.ok ? await cameraRes.json() : null);
    setLoading(false);
  }, [id]);

  const fetchJobPage = useCallback(async (page) => {
    const res = await fetch(`/api/printers/${id}/jobs?page=${page}`);
    if (res.ok) setJobHistory(await res.json());
  }, [id]);

  // Load the Project/Part picker's options only when the "catalog this print" popup is
  // actually needed (see needs_catalog in server/routes/printers.js), and only once per
  // visit to this page: no extra requests on the common case where nothing was
  // externally dispatched.
  useEffect(() => {
    if (printer?.needs_catalog && !catalogOptions && !catalogDismissed) {
      Promise.all([fetch('/api/projects'), fetch('/api/parts')]).then(async ([projectsRes, partsRes]) => {
        setCatalogOptions({
          projects: projectsRes.ok ? await projectsRes.json() : [],
          parts: partsRes.ok ? await partsRes.json() : [],
        });
      });
    }
  }, [printer, catalogOptions, catalogDismissed]);

  async function submitCatalog(e) {
    e.preventDefault();
    setCatalogSaving(true);
    setCatalogError(null);
    try {
      const res = await fetch(`/api/printers/${id}/catalog-print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          part_id: catalogForm.part_id,
          parts_per_plate: catalogForm.parts_per_plate,
          note: catalogForm.note.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setCatalogError(body.error || `Failed (${res.status})`); return; }
      setCatalogOptions(null);
      setCatalogForm({ part_id: '', parts_per_plate: '', note: '' });
      fetchData();
    } finally {
      setCatalogSaving(false);
    }
  }

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { fetchJobPage(jobPage); }, [fetchJobPage, jobPage]);

  async function submitNote(e) {
    e.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    await fetch(`/api/printers/${id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: note.trim() }),
    });
    setNote('');
    setSaving(false);
    fetchData();
  }

  function startRename() {
    setNameDraft(printer.name);
    setNameError(null);
    setEditingName(true);
  }

  function cancelRename() {
    setEditingName(false);
    setNameError(null);
  }

  async function submitRename(e) {
    e.preventDefault();
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNameError('Name cannot be empty');
      return;
    }
    if (trimmed === printer.name) {
      setEditingName(false);
      return;
    }
    setRenaming(true);
    setNameError(null);
    try {
      const res = await fetch(`/api/printers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setNameError(body.error || `Rename failed (${res.status})`);
        return;
      }
      setPrinter(await res.json());
      setEditingName(false);
    } finally {
      setRenaming(false);
    }
  }

  const NO_API_KEY_TYPES = new Set(['elegoo-centauri', 'klipper']);

  function startEditDetails() {
    setDetailsDraft({
      ip: printer.ip || '',
      api_key: printer.api_key || '',
      serial_number: printer.serial_number || '',
      group_name: printer.group_name || '',
      model: printer.model || '',
      loaded_material: printer.loaded_material || '',
      loaded_color: printer.loaded_color || '',
      auto_advance: !!printer.auto_advance,
      camera_uid: printer.camera_uid || '',
      camera_rotation: printer.camera_rotation || 0,
      camera_flip_h: !!printer.camera_flip_h,
      camera_flip_v: !!printer.camera_flip_v,
    });
    setDetailsError(null);
    setEditingDetails(true);
    setCameraList(null);
  }

  function cancelEditDetails() {
    setEditingDetails(false);
    setDetailsError(null);
    setTestResult(null);
    setCameraList(null);
  }

  async function handleListCameras() {
    setLoadingCameras(true);
    try {
      const res = await fetch('/api/printers/list-cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: printer.type,
          ip: detailsDraft.ip.trim(),
          api_key: detailsDraft.api_key.trim(),
          serial_number: detailsDraft.serial_number.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      setCameraList(res.ok ? data.cameras || [] : []);
    } catch (_) {
      setCameraList([]);
    } finally {
      setLoadingCameras(false);
    }
  }

  async function handleTestConnection() {
    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/printers/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: printer.type,
          ip: detailsDraft.ip.trim(),
          api_key: detailsDraft.api_key.trim(),
          serial_number: detailsDraft.serial_number.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResult(res.ok ? data : { ok: false, message: data.error || `Failed (${res.status})` });
    } catch (err) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTestingConnection(false);
    }
  }

  async function submitEditDetails(e) {
    e.preventDefault();
    const ip = detailsDraft.ip.trim();
    if (!ip) { setDetailsError('IP address or hostname is required'); return; }
    setSavingDetails(true);
    setDetailsError(null);
    try {
      const res = await fetch(`/api/printers/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip,
          api_key: detailsDraft.api_key.trim(),
          serial_number: detailsDraft.serial_number.trim(),
          group_name: detailsDraft.group_name.trim() || null,
          model: detailsDraft.model,
          loaded_material: detailsDraft.loaded_material.trim() || null,
          loaded_color: detailsDraft.loaded_color.trim() || null,
          auto_advance: detailsDraft.auto_advance,
          camera_uid: detailsDraft.camera_uid || null,
          camera_rotation: detailsDraft.camera_rotation,
          camera_flip_h: detailsDraft.camera_flip_h,
          camera_flip_v: detailsDraft.camera_flip_v,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDetailsError(body.error || `Save failed (${res.status})`);
        return;
      }
      setPrinter(await res.json());
      setEditingDetails(false);
      setTestResult(null);
    } finally {
      setSavingDetails(false);
    }
  }

  if (loading) return <p style={{ color: '#64748b' }}>Loading…</p>;
  if (!printer) return <p style={{ color: '#fca5a5' }}>Printer not found.</p>;

  const sc = STATUS_COLORS[printer.status] || STATUS_COLORS.UNKNOWN;

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Back link */}
      <button
        onClick={() => navigate('/printers')}
        style={{
          background: 'none', border: 'none', color: '#3b82f6',
          fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 18,
        }}
      >
        ← All Printers
      </button>

      {/* Printer header card */}
      <div style={{
        background: '#131720', border: '1px solid #1e2433',
        borderRadius: 8, padding: '16px 20px', marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          {editingName ? (
            <form onSubmit={submitRename} style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '1 1 auto' }}>
              <input
                autoFocus
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') cancelRename(); }}
                disabled={renaming}
                style={{
                  flex: 1, minWidth: 180,
                  background: '#1e2433', border: '1px solid #2d3748',
                  borderRadius: 5, color: '#e2e8f0',
                  fontSize: 18, fontWeight: 700,
                  padding: '4px 10px', outline: 'none',
                }}
              />
              <button
                type="submit"
                disabled={renaming || !nameDraft.trim()}
                style={{
                  background: renaming || !nameDraft.trim() ? '#1e2433' : '#1e40af',
                  color: renaming || !nameDraft.trim() ? '#475569' : '#fff',
                  border: 'none', borderRadius: 5,
                  padding: '6px 14px', fontSize: 13, fontWeight: 600,
                  cursor: renaming || !nameDraft.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {renaming ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={cancelRename}
                disabled={renaming}
                style={{
                  background: '#1e2433', color: '#94a3b8',
                  border: 'none', borderRadius: 5,
                  padding: '6px 14px', fontSize: 13, fontWeight: 600,
                  cursor: renaming ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <span style={{ fontWeight: 800, fontSize: 20, color: '#e2e8f0' }}>{printer.name}</span>
              <button
                onClick={startRename}
                title="Rename printer"
                style={{
                  background: 'none', border: '1px solid #2d3748',
                  color: '#94a3b8', borderRadius: 5,
                  padding: '3px 10px', fontSize: 11, fontWeight: 600,
                  cursor: 'pointer', letterSpacing: '0.04em',
                }}
              >
                Rename
              </button>
              {printer.is_active ? (
                <span style={{
                  background: sc.bg, color: sc.text,
                  borderRadius: 4, padding: '2px 9px', fontSize: 12, fontWeight: 700,
                }}>
                  {printer.status}
                </span>
              ) : (
                <span style={{
                  background: '#1e2433', color: '#ef4444',
                  borderRadius: 4, padding: '2px 9px', fontSize: 12, fontWeight: 700,
                }}>
                  DECOMMISSIONED
                </span>
              )}
            </>
          )}
        </div>
        {nameError && (
          <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 8 }}>
            {nameError}
          </div>
        )}

        {editingDetails ? (
          <form onSubmit={submitEditDetails} style={{ marginTop: 4 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
              <label style={detailLabelStyle}>
                IP Address or Hostname
                <input
                  autoFocus
                  value={detailsDraft.ip}
                  onChange={e => { setDetailsDraft(d => ({ ...d, ip: e.target.value })); setTestResult(null); }}
                  disabled={savingDetails}
                  placeholder="192.168.1.100 or octoprint-01"
                  style={detailInputStyle}
                />
                {/* .local (mDNS) names are resolved by the app itself (server/mdns-resolve.js),
                    independent of the OS resolver, so this works in the Docker image too. It
                    does depend on mDNS multicast reaching the app, which most networks allow
                    but some restrictive setups block. See docs/installation.md. */}
                {/\.local$/i.test(detailsDraft.ip.trim()) && (
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, fontWeight: 400 }}>
                    ".local" names are supported. If this printer ever shows OFFLINE and its IP
                    resolves fine elsewhere, your network may be blocking mDNS multicast; using
                    the printer's IP address instead (ideally with a DHCP reservation) is a
                    reliable fallback.
                  </div>
                )}
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, fontWeight: 400 }}>
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testingConnection || !detailsDraft.ip?.trim()}
                    style={{
                      background: 'transparent', color: '#94a3b8', border: '1px solid #2d3748',
                      borderRadius: 6, padding: '4px 10px', fontSize: 12,
                      cursor: testingConnection || !detailsDraft.ip?.trim() ? 'default' : 'pointer',
                      opacity: testingConnection || !detailsDraft.ip?.trim() ? 0.6 : 1,
                    }}
                  >
                    {testingConnection ? 'Testing...' : 'Test Connection'}
                  </button>
                  {testResult && (
                    <span style={{ fontSize: 12, color: testResult.ok ? '#22c55e' : '#ef4444' }}>
                      {testResult.ok ? '✓' : '✗'} {testResult.message}
                    </span>
                  )}
                </div>
              </label>
              {!NO_API_KEY_TYPES.has(printer.type) && (
                <label style={detailLabelStyle}>
                  API Key
                  <input
                    value={detailsDraft.api_key}
                    onChange={e => setDetailsDraft(d => ({ ...d, api_key: e.target.value }))}
                    disabled={savingDetails}
                    style={detailInputStyle}
                  />
                </label>
              )}
              <label style={detailLabelStyle}>
                Group
                <input
                  value={detailsDraft.group_name}
                  onChange={e => setDetailsDraft(d => ({ ...d, group_name: e.target.value }))}
                  disabled={savingDetails}
                  placeholder="optional"
                  list="printer-detail-group-options"
                  style={detailInputStyle}
                />
                <datalist id="printer-detail-group-options">
                  {groups.map(g => <option key={g} value={g} />)}
                </datalist>
              </label>
              <label style={detailLabelStyle}>
                Serial Number
                <input
                  value={detailsDraft.serial_number}
                  onChange={e => setDetailsDraft(d => ({ ...d, serial_number: e.target.value }))}
                  disabled={savingDetails}
                  placeholder="optional"
                  style={detailInputStyle}
                />
              </label>
              <label style={detailLabelStyle}>
                Model
                <select
                  value={detailsDraft.model}
                  onChange={e => setDetailsDraft(d => ({ ...d, model: e.target.value }))}
                  disabled={savingDetails}
                  style={{ ...detailInputStyle, cursor: 'pointer' }}
                >
                  {models.map(m => (
                    <option key={m.model_id} value={m.model_id}>{m.label}</option>
                  ))}
                </select>
              </label>
              <label style={detailLabelStyle}>
                Loaded Material
                <select
                  value={detailsDraft.loaded_material}
                  onChange={e => setDetailsDraft(d => ({ ...d, loaded_material: e.target.value, loaded_color: '' }))}
                  disabled={savingDetails}
                  style={{ ...detailInputStyle, cursor: 'pointer' }}
                >
                  <option value="">— none —</option>
                  {filamentTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              </label>
              <label style={detailLabelStyle}>
                Loaded Color
                <select
                  value={detailsDraft.loaded_color}
                  onChange={e => setDetailsDraft(d => ({ ...d, loaded_color: e.target.value }))}
                  disabled={savingDetails || !detailsDraft.loaded_material}
                  style={{ ...detailInputStyle, cursor: detailsDraft.loaded_material ? 'pointer' : 'not-allowed' }}
                >
                  <option value="">— none —</option>
                  {filamentColors
                    .filter(c => c.type_name === detailsDraft.loaded_material)
                    .map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </label>
              <label style={{ ...detailLabelStyle, flexDirection: 'row', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0 }}>
                <input
                  type="checkbox"
                  checked={!!detailsDraft.auto_advance}
                  onChange={e => setDetailsDraft(d => ({ ...d, auto_advance: e.target.checked }))}
                  disabled={savingDetails}
                  style={{ accentColor: '#3b82f6' }}
                />
                Belt printer (auto-advance, skips confirmation)
              </label>
            </div>
            {(printer.type === 'klipper' || printer.type === 'octoprint') && (
              <div style={{
                background: '#0f172a', border: '1px solid #1e2433',
                borderRadius: 6, padding: 12, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <div style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>Camera</div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label style={detailLabelStyle}>
                    Rotation
                    <select
                      value={detailsDraft.camera_rotation}
                      onChange={e => setDetailsDraft(d => ({ ...d, camera_rotation: Number(e.target.value) }))}
                      disabled={savingDetails}
                      style={{ ...detailInputStyle, width: 100 }}
                    >
                      <option value={0}>0°</option>
                      <option value={90}>90°</option>
                      <option value={180}>180°</option>
                      <option value={270}>270°</option>
                    </select>
                  </label>
                  <label style={{ ...detailLabelStyle, flexDirection: 'row', alignItems: 'center', gap: 6, textTransform: 'none', letterSpacing: 0 }}>
                    <input
                      type="checkbox"
                      checked={detailsDraft.camera_flip_h}
                      onChange={e => setDetailsDraft(d => ({ ...d, camera_flip_h: e.target.checked }))}
                      disabled={savingDetails}
                      style={{ accentColor: '#3b82f6' }}
                    />
                    Flip horizontal
                  </label>
                  <label style={{ ...detailLabelStyle, flexDirection: 'row', alignItems: 'center', gap: 6, textTransform: 'none', letterSpacing: 0 }}>
                    <input
                      type="checkbox"
                      checked={detailsDraft.camera_flip_v}
                      onChange={e => setDetailsDraft(d => ({ ...d, camera_flip_v: e.target.checked }))}
                      disabled={savingDetails}
                      style={{ accentColor: '#3b82f6' }}
                    />
                    Flip vertical
                  </label>
                </div>
                {printer.type === 'klipper' && (
                  <label style={detailLabelStyle}>
                    Camera (crowsnest, for a printer with more than one configured)
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select
                        value={detailsDraft.camera_uid}
                        onChange={e => setDetailsDraft(d => ({ ...d, camera_uid: e.target.value }))}
                        disabled={savingDetails}
                        style={{ ...detailInputStyle, maxWidth: 260 }}
                      >
                        <option value="">Default (first enabled)</option>
                        {(cameraList || []).map(c => (
                          <option key={c.uid} value={c.uid}>{c.name}{c.enabled ? '' : ' (disabled)'}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={handleListCameras}
                        disabled={loadingCameras || !detailsDraft.ip?.trim()}
                        style={{
                          background: 'transparent', color: '#94a3b8', border: '1px solid #2d3748',
                          borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 400,
                          cursor: loadingCameras || !detailsDraft.ip?.trim() ? 'default' : 'pointer',
                          opacity: loadingCameras || !detailsDraft.ip?.trim() ? 0.6 : 1,
                        }}
                      >
                        {loadingCameras ? 'Loading...' : 'Find cameras'}
                      </button>
                    </div>
                    {cameraList !== null && cameraList.length === 0 && (
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, fontWeight: 400 }}>
                        No cameras found. Confirm the printer is reachable and crowsnest is configured.
                      </div>
                    )}
                  </label>
                )}
              </div>
            )}
            {detailsError && (
              <div style={{ fontSize: 12, color: '#fca5a5', marginTop: 6 }}>{detailsError}</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="submit"
                disabled={savingDetails || !detailsDraft.ip?.trim()}
                style={{
                  background: savingDetails || !detailsDraft.ip?.trim() ? '#1e2433' : '#1e40af',
                  color: savingDetails || !detailsDraft.ip?.trim() ? '#475569' : '#fff',
                  border: 'none', borderRadius: 5,
                  padding: '6px 16px', fontSize: 13, fontWeight: 600,
                  cursor: savingDetails || !detailsDraft.ip?.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {savingDetails ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={cancelEditDetails}
                disabled={savingDetails}
                style={{
                  background: '#1e2433', color: '#94a3b8',
                  border: 'none', borderRadius: 5,
                  padding: '6px 14px', fontSize: 13, fontWeight: 600,
                  cursor: savingDetails ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', fontSize: 13, color: '#64748b' }}>
            <span>Model: <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{printer.model}</span></span>
            <span>IP: <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{printer.ip}</span></span>
            {printer.group_name && (
              <span>Group: <span style={{ color: '#94a3b8' }}>{printer.group_name}</span></span>
            )}
            {printer.type && printer.type !== 'prusa' && (
              <span>Connector: <span style={{ color: '#94a3b8' }}>{printer.type}</span></span>
            )}
            {(printer.loaded_material || printer.loaded_color) && (
              <span>
                Loaded:{' '}
                <span style={{ color: '#7dd3fc' }}>
                  {[printer.loaded_material, printer.loaded_color].filter(Boolean).join(' · ')}
                </span>
              </span>
            )}
            {!!printer.auto_advance && (
              <span style={{ background: '#1e2a3a', color: '#7dd3fc', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
                Belt printer, auto-advance
              </span>
            )}
            <button
              onClick={startEditDetails}
              style={{
                background: 'none', border: '1px solid #2d3748',
                color: '#94a3b8', borderRadius: 5,
                padding: '3px 10px', fontSize: 11, fontWeight: 600,
                cursor: 'pointer', letterSpacing: '0.04em', marginLeft: 'auto',
              }}
            >
              Edit
            </button>
          </div>
        )}

        {printer.decommissioned_at && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }}>
            Decommissioned: {formatTimestamp(printer.decommissioned_at)}
          </div>
        )}
      </div>

      {/* Camera card: only rendered when the printer's connector supports a live feed.
          The live feed is an MJPEG stream (continuous video, not a single image) that
          keeps pulling bandwidth for as long as the <img> stays mounted. It does not
          autoplay: a snapshot (or, if the connector has none, a placeholder) shows by
          default, and the operator opts in with "Watch Live". */}
      {camera?.available && (
        <div style={{
          background: '#131720', border: '1px solid #1e2433',
          borderRadius: 8, padding: '14px 18px', marginBottom: 24,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Camera</div>
            {!cameraError && (
              <button
                onClick={() => setLiveView(v => !v)}
                style={{
                  background: liveView ? '#2563eb' : 'transparent',
                  color: liveView ? '#fff' : '#94a3b8',
                  border: '1px solid #2d3748', borderRadius: 6,
                  padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                }}
              >
                {liveView ? 'Stop Live View' : 'Watch Live'}
              </button>
            )}
          </div>
          {cameraError ? (
            <div style={{ fontSize: 13, color: '#64748b' }}>Camera feed unavailable.</div>
          ) : liveView ? (
            <img
              key={camera.streamUrl}
              src={camera.streamUrl}
              alt={`${printer.name} camera feed`}
              onError={() => setCameraError(true)}
              style={{ width: '100%', maxWidth: 480, borderRadius: 6, display: 'block', background: '#0a0f1a', transform: cameraTransform(camera) }}
            />
          ) : camera.snapshotUrl ? (
            <img
              key={camera.snapshotUrl}
              src={camera.snapshotUrl}
              alt={`${printer.name} camera snapshot`}
              onError={() => setCameraError(true)}
              style={{ width: '100%', maxWidth: 480, borderRadius: 6, display: 'block', background: '#0a0f1a', transform: cameraTransform(camera) }}
            />
          ) : (
            <div style={{
              width: '100%', maxWidth: 480, height: 140, borderRadius: 6,
              background: '#0a0f1a', border: '1px dashed #2d3748',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, color: '#475569',
            }}>
              No snapshot configured. Click "Watch Live" to start streaming.
            </div>
          )}
        </div>
      )}

      {/* Stats card */}
      {stats && (
        <div style={{
          background: '#131720', border: '1px solid #1e2433',
          borderRadius: 8, padding: '14px 20px', marginBottom: 24,
          display: 'flex', gap: 0, flexWrap: 'wrap',
        }}>
          {[
            { label: 'Jobs Run',      value: stats.total_jobs.toLocaleString() },
            { label: 'Parts Made',    value: stats.total_parts.toLocaleString() },
            { label: 'Success Rate',  value: stats.success_rate != null ? `${stats.success_rate}%` : '—' },
            { label: 'Print Hours',   value: formatHours(stats.total_print_ms) },
          ].map(({ label, value }) => (
            <div key={label} style={{
              flex: '1 1 120px', padding: '4px 16px 4px 0', minWidth: 100,
            }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#e2e8f0', lineHeight: 1.2 }}>{value}</div>
              <div style={{ fontSize: 11, color: '#475569', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Add note form */}
      <div style={{
        background: '#131720', border: '1px solid #1e2433',
        borderRadius: 8, padding: '14px 18px', marginBottom: 24,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>Add operator note</div>
        <form onSubmit={submitNote} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Describe an observation, inspection result, or any relevant note…"
            rows={2}
            style={{
              flex: 1,
              background: '#1e2433', border: '1px solid #2d3748',
              borderRadius: 5, color: '#e2e8f0', fontSize: 13,
              padding: '7px 10px', resize: 'vertical', outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="submit"
            disabled={saving || !note.trim()}
            style={{
              background: saving || !note.trim() ? '#1e2433' : '#1e40af',
              color: saving || !note.trim() ? '#475569' : '#fff',
              border: 'none', borderRadius: 5,
              padding: '7px 16px', fontSize: 13, fontWeight: 600,
              cursor: saving || !note.trim() ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {saving ? 'Saving…' : 'Add Note'}
          </button>
        </form>
      </div>

      {/* Event timeline */}
      <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Event History ({events.length})
      </div>

      {events.length === 0 && (
        <p style={{ color: '#475569', fontSize: 14 }}>
          No history yet — events are recorded automatically as this printer receives jobs, finishes prints, or changes status.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {events.map(ev => (
          <div key={ev.id} style={{
            background: '#131720', border: '1px solid #1e2433',
            borderRadius: 7, padding: '10px 14px',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <div style={{ paddingTop: 1 }}>
              <EventBadge type={ev.event_type} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {ev.note && (
                <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 4, wordBreak: 'break-word' }}>
                  {ev.note}
                </div>
              )}
              <div style={{ fontSize: 11, color: '#475569' }}>{formatTimestamp(ev.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
      {/* Job history */}
      {jobHistory.total > 0 && (
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#64748b', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Job History ({jobHistory.total.toLocaleString()})
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#475569', textAlign: 'left', borderBottom: '1px solid #1e2433' }}>
                  {['Part', 'Project', 'File', 'Started', 'Duration', 'Parts', 'Status'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobHistory.jobs.map(job => {
                  const statusColor = job.status === 'finished' ? '#86efac'
                    : job.status === 'failed'   ? '#fca5a5'
                    : job.status === 'cancelled' ? '#475569'
                    : '#fcd34d';
                  return (
                    <tr key={job.id} style={{ borderBottom: '1px solid #1a1f2e' }}>
                      <td style={{ padding: '7px 10px', color: '#cbd5e1', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.part_name ?? '—'}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.project_name ?? '—'}</td>
                      <td style={{ padding: '7px 10px', color: '#64748b', fontFamily: 'monospace', fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.gcode_filename ?? '—'}</td>
                      <td style={{ padding: '7px 10px', color: '#64748b', whiteSpace: 'nowrap' }}>{formatTimestamp(job.started_at)}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8', whiteSpace: 'nowrap' }}>{formatDuration(job.duration_ms)}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8', textAlign: 'center' }}>{job.parts_per_plate}</td>
                      <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                        <span style={{ color: statusColor, fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>{job.status}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {jobHistory.total_pages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setJobPage(p => Math.max(1, p - 1))}
                disabled={jobPage === 1}
                style={{
                  background: jobPage === 1 ? '#1e2433' : '#1e3a5f',
                  color: jobPage === 1 ? '#475569' : '#93c5fd',
                  border: 'none', borderRadius: 5, padding: '8px 16px',
                  fontSize: 13, fontWeight: 600, cursor: jobPage === 1 ? 'not-allowed' : 'pointer',
                }}
              >← Prev</button>
              <span style={{ fontSize: 13, color: '#64748b' }}>
                Page {jobPage} of {jobHistory.total_pages}
              </span>
              <button
                onClick={() => setJobPage(p => Math.min(jobHistory.total_pages, p + 1))}
                disabled={jobPage === jobHistory.total_pages}
                style={{
                  background: jobPage === jobHistory.total_pages ? '#1e2433' : '#1e3a5f',
                  color: jobPage === jobHistory.total_pages ? '#475569' : '#93c5fd',
                  border: 'none', borderRadius: 5, padding: '8px 16px',
                  fontSize: 13, fontWeight: 600, cursor: jobPage === jobHistory.total_pages ? 'not-allowed' : 'pointer',
                }}
              >Next →</button>
            </div>
          )}
        </div>
      )}

      {/* Uncataloged-print popup: opens automatically when this printer is actively printing
          or shows finished with no job the farm dispatched (see needs_catalog). Lets the
          operator attach whatever OrcaSlicer, or any other tool outside the farm, sent
          straight to the printer to a real Part, instead of leaving it untracked forever. */}
      {printer.needs_catalog && catalogOptions && !catalogDismissed && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: 20, backdropFilter: 'blur(3px)',
          }}
        >
          <form
            onSubmit={submitCatalog}
            style={{
              background: '#1e2433', border: '1px solid #334155', borderRadius: 10,
              padding: '24px 28px', maxWidth: 440, width: '100%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
              Uncataloged print on {printer.name}
            </div>
            <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6, marginBottom: 16 }}>
              This printer is {printer.status === 'PRINTING' ? 'printing' : 'showing a finished print'}, but the farm has no record of dispatching it, likely sliced and sent directly from OrcaSlicer or another tool. Tell us what it is so the count gets tracked.
            </div>

            <label style={{ display: 'block', fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>
              Part
            </label>
            <select
              required
              value={catalogForm.part_id}
              onChange={e => setCatalogForm(f => ({ ...f, part_id: e.target.value }))}
              disabled={catalogSaving}
              style={{ ...detailInputStyle, width: '100%', marginBottom: 14, cursor: 'pointer', boxSizing: 'border-box' }}
            >
              <option value="">Select a part…</option>
              {catalogOptions.projects
                .filter(pr => pr.status !== 'completed')
                .map(pr => {
                  const parts = catalogOptions.parts.filter(p => p.project_id === pr.id && p.status === 'open');
                  if (parts.length === 0) return null;
                  return (
                    <optgroup key={pr.id} label={pr.name}>
                      {parts.map(p => (
                        <option key={p.id} value={p.id}>{p.name} ({p.completed_qty}/{p.target_qty})</option>
                      ))}
                    </optgroup>
                  );
                })}
            </select>

            <label style={{ display: 'block', fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>
              Quantity on this plate
            </label>
            <input
              type="number"
              min={1}
              required
              value={catalogForm.parts_per_plate}
              onChange={e => setCatalogForm(f => ({ ...f, parts_per_plate: e.target.value }))}
              disabled={catalogSaving}
              style={{ ...detailInputStyle, width: '100%', marginBottom: 14, boxSizing: 'border-box' }}
            />

            <label style={{ display: 'block', fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>
              Note (optional)
            </label>
            <textarea
              rows={2}
              value={catalogForm.note}
              onChange={e => setCatalogForm(f => ({ ...f, note: e.target.value }))}
              disabled={catalogSaving}
              style={{ ...detailInputStyle, width: '100%', marginBottom: 14, resize: 'vertical', boxSizing: 'border-box' }}
            />

            {catalogError && (
              <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 14 }}>{catalogError}</div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setCatalogDismissed(true)}
                disabled={catalogSaving}
                style={{
                  background: '#1f2937', color: '#9ca3af', border: '1px solid #374151',
                  borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 500,
                  cursor: catalogSaving ? 'not-allowed' : 'pointer',
                }}
              >
                Not now
              </button>
              <button
                type="submit"
                disabled={catalogSaving || !catalogForm.part_id || !catalogForm.parts_per_plate}
                style={{
                  background: catalogSaving || !catalogForm.part_id || !catalogForm.parts_per_plate ? '#374151' : '#1e40af',
                  color: catalogSaving || !catalogForm.part_id || !catalogForm.parts_per_plate ? '#6b7280' : '#fff',
                  border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: 13, fontWeight: 600,
                  cursor: catalogSaving || !catalogForm.part_id || !catalogForm.parts_per_plate ? 'not-allowed' : 'pointer',
                }}
              >
                {catalogSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
