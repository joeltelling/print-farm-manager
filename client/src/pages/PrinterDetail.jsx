import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import CameraFeed from '../components/CameraFeed';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';

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
  decommission:     { label: 'Decommissioned', bg: '#7f1d1d', color: '#fca5a5' },
  recommission:     { label: 'Recommissioned', bg: '#062b22', color: '#6ee7b7' },
  job_finished:     { label: 'Job Finished',   bg: '#1e1f45', color: '#a5b4fc' },
  job_failed:       { label: 'Job Failed',      bg: '#78350f', color: '#fcd34d' },
  job_cancelled:    { label: 'Job Cancelled',   bg: '#431407', color: '#f59e0b' },
  offline_with_job: { label: 'Went Offline',    bg: '#232639', color: '#a1a1aa' },
  recovered:        { label: 'Recovered',       bg: '#062b22', color: '#6ee7b7' },
  error:            { label: 'Error',           bg: '#7f1d1d', color: '#fca5a5' },
  note:             { label: 'Note',            bg: '#232639', color: '#a1a1aa' },
  info_changed:     { label: 'Info Updated',   bg: '#1e2a3a', color: '#7dd3fc' },
};

function EventBadge({ type }) {
  const m = EVENT_META[type] || { label: type, bg: '#232639', color: '#71717a' };
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
  IDLE:     { bg: '#1e1f45', text: '#a5b4fc' },
  PRINTING: { bg: '#062b22', text: '#6ee7b7' },
  FINISHED: { bg: '#062b22', text: '#6ee7b7' },
  PAUSED:   { bg: '#78350f', text: '#fcd34d' },
  STOPPED:  { bg: '#431407', text: '#f59e0b' },
  ERROR:    { bg: '#7f1d1d', text: '#fca5a5' },
  OFFLINE:  { bg: '#232639', text: '#52525b' },
  UNKNOWN:  { bg: '#232639', text: '#52525b' },
};

const detailLabelStyle = {
  display: 'flex', flexDirection: 'column', gap: 3,
  fontSize: 11, fontWeight: 600, color: '#71717a',
  letterSpacing: '0.04em', textTransform: 'uppercase',
};

const detailInputStyle = {
  background: '#232639', border: '1px solid #2d3146',
  borderRadius: 5, color: '#f4f4f5',
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
  const [detailsError, setDetailsError]     = useState(null);
  const [savingDetails, setSavingDetails]   = useState(false);

  const [showToast, toastEl] = useToast();
  const [, confirmModal] = useConfirm();
  const [tlBusy, setTlBusy] = useState(false);
  const [activeTl, setActiveTl] = useState(null);

  const refreshTimelapse = useCallback(async () => {
    const res = await fetch(`/api/timelapses?printer_id=${id}&limit=5`);
    if (!res.ok) return;
    const rows = await res.json();
    const capturing = rows.find(r => r.status === 'capturing');
    setActiveTl(capturing || rows[0] || null);
  }, [id]);

  const fetchData = useCallback(async () => {
    const [printerRes, eventsRes, statsRes, modelsRes, typesRes, colorsRes, groupsRes] = await Promise.all([
      fetch(`/api/printers/${id}`),
      fetch(`/api/printers/${id}/events`),
      fetch(`/api/printers/${id}/jobs/stats`),
      fetch('/api/models'),
      fetch('/api/filaments/types'),
      fetch('/api/filaments/colors'),
      fetch('/api/groups'),
    ]);
    if (printerRes.ok)  setPrinter(await printerRes.json());
    if (eventsRes.ok)   setEvents(await eventsRes.json());
    if (statsRes.ok)    setStats(await statsRes.json());
    if (modelsRes.ok)   setModels(await modelsRes.json());
    if (typesRes.ok)    setFilamentTypes(await typesRes.json());
    if (colorsRes.ok)   setFilamentColors(await colorsRes.json());
    if (groupsRes.ok)   setGroups((await groupsRes.json()).map(g => g.name));
    setLoading(false);
    refreshTimelapse();
  }, [id, refreshTimelapse]);

  const fetchJobPage = useCallback(async (page) => {
    const res = await fetch(`/api/printers/${id}/jobs?page=${page}`);
    if (res.ok) setJobHistory(await res.json());
  }, [id]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 15000);
    return () => clearInterval(id);
  }, [fetchData]);
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
    });
    setDetailsError(null);
    setEditingDetails(true);
  }

  function cancelEditDetails() {
    setEditingDetails(false);
    setDetailsError(null);
  }

  async function submitEditDetails(e) {
    e.preventDefault();
    const ip = detailsDraft.ip.trim();
    if (!ip) { setDetailsError('IP address is required'); return; }
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
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setDetailsError(body.error || `Save failed (${res.status})`);
        return;
      }
      setPrinter(await res.json());
      setEditingDetails(false);
    } finally {
      setSavingDetails(false);
    }
  }

  if (loading) return <p style={{ color: '#71717a' }}>Loading…</p>;
  if (!printer) return <p style={{ color: '#fca5a5' }}>Printer not found.</p>;

  const sc = STATUS_COLORS[printer.status] || STATUS_COLORS.UNKNOWN;

  return (
    <div>
      <style>{`
        .coma-incident { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.1fr); gap: 16px; align-items: start; }
        @media (max-width: 900px) { .coma-incident { grid-template-columns: 1fr; } }
      `}</style>
      {/* Back link */}
      <button
        onClick={() => navigate('/printers')}
        style={{
          background: 'none', border: 'none', color: '#8b5cf6',
          fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 18,
        }}
      >
        ← All Printers
      </button>

      {/* Printer header card */}
      <div style={{
        background: '#141620', border: '1px solid #232639',
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
                  background: '#232639', border: '1px solid #2d3146',
                  borderRadius: 5, color: '#f4f4f5',
                  fontSize: 18, fontWeight: 700,
                  padding: '4px 10px', outline: 'none',
                }}
              />
              <button
                type="submit"
                disabled={renaming || !nameDraft.trim()}
                style={{
                  background: renaming || !nameDraft.trim() ? '#232639' : '#5b21b6',
                  color: renaming || !nameDraft.trim() ? '#52525b' : '#fff',
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
                  background: '#232639', color: '#a1a1aa',
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
              <span style={{ fontWeight: 800, fontSize: 20, color: '#f4f4f5' }}>{printer.name}</span>
              <button
                onClick={startRename}
                title="Rename printer"
                style={{
                  background: 'none', border: '1px solid #2d3146',
                  color: '#a1a1aa', borderRadius: 5,
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
                  background: '#232639', color: '#ef4444',
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
                IP Address
                <input
                  autoFocus
                  value={detailsDraft.ip}
                  onChange={e => setDetailsDraft(d => ({ ...d, ip: e.target.value }))}
                  disabled={savingDetails}
                  style={detailInputStyle}
                />
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
            </div>
            {detailsError && (
              <div style={{ fontSize: 12, color: '#fca5a5', marginTop: 6 }}>{detailsError}</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="submit"
                disabled={savingDetails || !detailsDraft.ip?.trim()}
                style={{
                  background: savingDetails || !detailsDraft.ip?.trim() ? '#232639' : '#5b21b6',
                  color: savingDetails || !detailsDraft.ip?.trim() ? '#52525b' : '#fff',
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
                  background: '#232639', color: '#a1a1aa',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', fontSize: 13, color: '#71717a' }}>
            <span>Model: <span style={{ color: '#a1a1aa', fontFamily: 'monospace' }}>{printer.model}</span></span>
            <span>IP: <span style={{ color: '#a1a1aa', fontFamily: 'monospace' }}>{printer.ip}</span></span>
            {printer.group_name && (
              <span>Group: <span style={{ color: '#a1a1aa' }}>{printer.group_name}</span></span>
            )}
            {printer.type && printer.type !== 'prusa' && (
              <span>Connector: <span style={{ color: '#a1a1aa' }}>{printer.type}</span></span>
            )}
            {(printer.loaded_material || printer.loaded_color) && (
              <span>
                Loaded:{' '}
                <span style={{ color: '#7dd3fc' }}>
                  {[printer.loaded_material, printer.loaded_color].filter(Boolean).join(' · ')}
                </span>
              </span>
            )}
            <button
              onClick={startEditDetails}
              style={{
                background: 'none', border: '1px solid #2d3146',
                color: '#a1a1aa', borderRadius: 5,
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
        <div style={{ marginTop: 10, fontSize: 12, color: '#71717a' }}>
          Operator sign-off (Set Ready / Bad Print) lives on the{' '}
          <button
            onClick={() => navigate('/fleet')}
            style={{ background: 'none', border: 'none', color: '#8b5cf6', cursor: 'pointer', padding: 0, fontSize: 12 }}
          >
            Fleet
          </button>
          {' '}page.
        </div>
      </div>

      {/* Stats card */}
      {stats && (
        <div style={{
          background: '#141620', border: '1px solid #232639',
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
              <div style={{ fontSize: 22, fontWeight: 800, color: '#f4f4f5', lineHeight: 1.2 }}>{value}</div>
              <div style={{ fontSize: 11, color: '#52525b', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Add note form */}
      <div className="coma-incident" style={{ marginBottom: 24 }}>
        <CameraFeed
          printerId={printer.id}
          printerType={printer.type}
          printerIp={printer.ip}
        />
        <div style={{
          background: '#141620', border: '1px solid #232639',
          borderRadius: 8, padding: '14px 18px', marginBottom: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#a1a1aa' }}>Timelapse</div>
            <Link to="/timelapses" style={{ fontSize: 12, color: '#71717a' }}>Gallery</Link>
          </div>
          <div style={{ fontSize: 13, color: '#a1a1aa', marginBottom: 10 }}>
            {activeTl
              ? `#${activeTl.id} · ${activeTl.status} · ${activeTl.frame_count} frames${activeTl.job_id ? ` · job ${activeTl.job_id}` : ' · manual'}`
              : 'No capture on this printer yet.'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={tlBusy || activeTl?.status === 'capturing'}
              onClick={async () => {
                setTlBusy(true);
                try {
                  const r = await fetch(`/api/printers/${id}/timelapse/start`, { method: 'POST' });
                  const body = await r.json().catch(() => ({}));
                  if (!r.ok) throw new Error(body.error || r.status);
                  showToast(`Timelapse #${body.id} started`);
                  refreshTimelapse();
                } catch (ex) {
                  showToast(`Start failed: ${ex.message}`, 'error');
                } finally {
                  setTlBusy(false);
                }
              }}
              style={{
                background: activeTl?.status === 'capturing' ? '#232639' : '#7c3aed',
                color: activeTl?.status === 'capturing' ? '#52525b' : '#fff',
                border: 'none', borderRadius: 5, padding: '7px 14px',
                fontSize: 13, fontWeight: 600,
                cursor: activeTl?.status === 'capturing' ? 'not-allowed' : 'pointer',
              }}
            >
              Start capture
            </button>
            <button
              type="button"
              disabled={tlBusy || activeTl?.status !== 'capturing'}
              onClick={async () => {
                setTlBusy(true);
                try {
                  const r = await fetch(`/api/printers/${id}/timelapse/stop`, { method: 'POST' });
                  const body = await r.json().catch(() => ({}));
                  if (!r.ok) throw new Error(body.error || r.status);
                  showToast('Capture stopped (rendering)');
                  refreshTimelapse();
                } catch (ex) {
                  showToast(`Stop failed: ${ex.message}`, 'error');
                } finally {
                  setTlBusy(false);
                }
              }}
              style={{
                background: activeTl?.status === 'capturing' ? '#7f1d1d' : '#232639',
                color: activeTl?.status === 'capturing' ? '#fca5a5' : '#52525b',
                border: 'none', borderRadius: 5, padding: '7px 14px',
                fontSize: 13, fontWeight: 600,
                cursor: activeTl?.status === 'capturing' ? 'pointer' : 'not-allowed',
              }}
            >
              Stop
            </button>
          </div>
        </div>
        <div>
      <div style={{
        background: '#141620', border: '1px solid #232639',
        borderRadius: 8, padding: '14px 18px', marginBottom: 16,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#a1a1aa', marginBottom: 8 }}>Add operator note</div>
        <form onSubmit={submitNote} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Describe an observation, inspection result, or any relevant note…"
            rows={2}
            style={{
              flex: 1,
              background: '#232639', border: '1px solid #2d3146',
              borderRadius: 5, color: '#f4f4f5', fontSize: 13,
              padding: '7px 10px', resize: 'vertical', outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="submit"
            disabled={saving || !note.trim()}
            style={{
              background: saving || !note.trim() ? '#232639' : '#5b21b6',
              color: saving || !note.trim() ? '#52525b' : '#fff',
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
      <div style={{ fontSize: 13, fontWeight: 600, color: '#71717a', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Event History ({events.length})
      </div>

      {events.length === 0 && (
        <p style={{ color: '#52525b', fontSize: 14 }}>
          No history yet: events are recorded automatically as this printer receives jobs, finishes prints, or changes status.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {events.map(ev => (
          <div key={ev.id} style={{
            background: '#141620', border: '1px solid #232639',
            borderRadius: 7, padding: '10px 14px',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <div style={{ paddingTop: 1 }}>
              <EventBadge type={ev.event_type} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {ev.note && (
                <div style={{ fontSize: 13, color: '#d4d4d8', marginBottom: 4, wordBreak: 'break-word' }}>
                  {ev.note}
                </div>
              )}
              <div style={{ fontSize: 11, color: '#52525b' }}>{formatTimestamp(ev.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
        </div>
      </div>
      {/* Job history */}
      {jobHistory.total > 0 && (
        <div style={{ marginTop: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#71717a', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Job History ({jobHistory.total.toLocaleString()})
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#52525b', textAlign: 'left', borderBottom: '1px solid #232639' }}>
                  {['Part', 'Project', 'File', 'Started', 'Duration', 'Parts', 'Status'].map(h => (
                    <th key={h} style={{ padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobHistory.jobs.map(job => {
                  const statusColor = job.status === 'finished' ? '#6ee7b7'
                    : job.status === 'failed'   ? '#fca5a5'
                    : job.status === 'cancelled' ? '#52525b'
                    : '#fcd34d';
                  return (
                    <tr key={job.id} style={{ borderBottom: '1px solid #181a27' }}>
                      <td style={{ padding: '7px 10px', color: '#d4d4d8', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.part_name ?? '—'}</td>
                      <td style={{ padding: '7px 10px', color: '#a1a1aa', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.project_name ?? '—'}</td>
                      <td style={{ padding: '7px 10px', color: '#71717a', fontFamily: 'monospace', fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.gcode_filename ?? '—'}</td>
                      <td style={{ padding: '7px 10px', color: '#71717a', whiteSpace: 'nowrap' }}>{formatTimestamp(job.started_at)}</td>
                      <td style={{ padding: '7px 10px', color: '#a1a1aa', whiteSpace: 'nowrap' }}>{formatDuration(job.duration_ms)}</td>
                      <td style={{ padding: '7px 10px', color: '#a1a1aa', textAlign: 'center' }}>{job.parts_per_plate}</td>
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
                  background: jobPage === 1 ? '#232639' : '#1e1f45',
                  color: jobPage === 1 ? '#52525b' : '#a5b4fc',
                  border: 'none', borderRadius: 5, padding: '8px 16px',
                  fontSize: 13, fontWeight: 600, cursor: jobPage === 1 ? 'not-allowed' : 'pointer',
                }}
              >← Prev</button>
              <span style={{ fontSize: 13, color: '#71717a' }}>
                Page {jobPage} of {jobHistory.total_pages}
              </span>
              <button
                onClick={() => setJobPage(p => Math.min(jobHistory.total_pages, p + 1))}
                disabled={jobPage === jobHistory.total_pages}
                style={{
                  background: jobPage === jobHistory.total_pages ? '#232639' : '#1e1f45',
                  color: jobPage === jobHistory.total_pages ? '#52525b' : '#a5b4fc',
                  border: 'none', borderRadius: 5, padding: '8px 16px',
                  fontSize: 13, fontWeight: 600, cursor: jobPage === jobHistory.total_pages ? 'not-allowed' : 'pointer',
                }}
              >Next →</button>
            </div>
          )}
        </div>
      )}
      {toastEl}
      {confirmModal}
    </div>
  );
}
