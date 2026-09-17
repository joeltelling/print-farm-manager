import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';

const page = '#0a0f1a';
const card = '#131720';
const border = '#1e2433';
const text = '#e2e8f0';
const muted = '#94a3b8';
const faint = '#64748b';
const blue = '#2563eb';
const red = '#ef4444';

export default function Timelapses() {
  const [rows, setRows] = useState([]);
  const [printers, setPrinters] = useState([]);
  const [filterPrinter, setFilterPrinter] = useState('');
  const [selected, setSelected] = useState(null);
  const [err, setErr] = useState('');
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();

  const load = () => {
    const qs = filterPrinter ? `?printer_id=${encodeURIComponent(filterPrinter)}` : '';
    fetch(`/api/timelapses${qs}`)
      .then(r => r.json())
      .then(setRows)
      .catch(() => setErr('Failed to load timelapses'));
  };

  useEffect(() => {
    fetch('/api/printers').then(r => r.json()).then(setPrinters).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [filterPrinter]);

  const openOne = async (id) => {
    const r = await fetch(`/api/timelapses/${id}`);
    if (!r.ok) {
      showToast('Timelapse not found', 'error');
      return;
    }
    setSelected(await r.json());
  };

  const startManual = async (printerId) => {
    try {
      const r = await fetch(`/api/printers/${printerId}/timelapse/start`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.status);
      showToast(`Timelapse #${body.id} started`);
      load();
    } catch (ex) {
      showToast(`Start failed: ${ex.message}`, 'error');
    }
  };

  const stopOne = async (id) => {
    try {
      const r = await fetch(`/api/timelapses/${id}/stop`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.status);
      showToast(`Timelapse #${id} stopped (rendering)`);
      load();
      if (selected?.id === id) setSelected(body);
    } catch (ex) {
      showToast(`Stop failed: ${ex.message}`, 'error');
    }
  };

  const reRender = async (id) => {
    try {
      const r = await fetch(`/api/timelapses/${id}/render`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.status);
      showToast(`Render ${body.status}`);
      load();
      setSelected(body);
    } catch (ex) {
      showToast(`Render failed: ${ex.message}`, 'error');
    }
  };

  const removeOne = async (id) => {
    const ok = await confirm({
      title: 'Delete timelapse',
      message: `Delete timelapse #${id} and all its frames/video from disk?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/timelapses/${id}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.status);
      showToast(`Deleted #${id}`);
      if (selected?.id === id) setSelected(null);
      load();
    } catch (ex) {
      showToast(`Delete failed: ${ex.message}`, 'error');
    }
  };

  return (
    <div style={{ color: text }}>
      <style>{`
        @media (max-width: 600px) {
          .tl-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>Timelapses</h1>
          <p style={{ margin: '6px 0 0', color: muted, fontSize: 13 }}>
            Auto-captures while a job is PRINTING. Or start a manual capture on any machine with a camera.
          </p>
        </div>
      </div>

      <div style={{
        background: card, border: `1px solid ${border}`, borderRadius: 8,
        padding: 14, marginBottom: 14, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center',
      }}>
        <label style={{ fontSize: 12, color: faint }}>Printer</label>
        <select
          value={filterPrinter}
          onChange={e => setFilterPrinter(e.target.value)}
          style={{ background: '#1e2433', color: text, border: `1px solid ${border}`, borderRadius: 5, padding: '6px 10px' }}
        >
          <option value="">All</option>
          {printers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          defaultValue=""
          onChange={e => {
            if (e.target.value) {
              startManual(e.target.value);
              e.target.value = '';
            }
          }}
          style={{ background: blue, color: '#fff', border: 'none', borderRadius: 5, padding: '6px 12px', fontWeight: 600 }}
        >
          <option value="">Start on machine...</option>
          {printers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Link to="/settings" style={{ color: muted, fontSize: 12 }}>Interval settings</Link>
      </div>

      {err && <div style={{ color: red, marginBottom: 8 }}>{err}</div>}

      <div className="tl-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 14 }}>
        <div style={{ background: card, border: `1px solid ${border}`, borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: faint, textAlign: 'left' }}>
                {['ID', 'Printer', 'Job', 'Status', 'Frames', 'Started', ''].map(h => (
                  <th key={h} style={{ padding: '10px 12px', borderBottom: `1px solid ${border}`, fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const pr = printers.find(p => p.id === r.printer_id);
                return (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${border}`, cursor: 'pointer' }} onClick={() => openOne(r.id)}>
                    <td style={{ padding: '10px 12px' }}>#{r.id}</td>
                    <td style={{ padding: '10px 12px' }}>{pr?.name || r.printer_id}</td>
                    <td style={{ padding: '10px 12px' }}>{r.job_id ?? 'manual'}</td>
                    <td style={{ padding: '10px 12px', color: r.status === 'ready' ? '#22c55e' : muted }}>{r.status}</td>
                    <td style={{ padding: '10px 12px' }}>{r.frame_count}</td>
                    <td style={{ padding: '10px 12px', color: faint }}>{r.started_at ? new Date(r.started_at).toLocaleString() : ''}</td>
                    <td style={{ padding: '10px 12px' }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {r.status === 'capturing' && (
                          <button type="button" onClick={() => stopOne(r.id)} style={btn(blue)}>Stop</button>
                        )}
                        {(r.status === 'failed' || r.status === 'ready') && (
                          <button type="button" onClick={() => reRender(r.id)} style={btn('#1e2433', text)}>Render</button>
                        )}
                        <button type="button" onClick={() => removeOne(r.id)} style={btn('#1e2433', red)}>Del</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr><td colSpan={7} style={{ padding: 20, color: faint }}>No timelapses yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ background: card, border: `1px solid ${border}`, borderRadius: 8, padding: 14, minHeight: 280 }}>
          {!selected && <div style={{ color: faint, fontSize: 13 }}>Select a timelapse to preview.</div>}
          {selected && (
            <>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>#{selected.id} · {selected.status}</div>
              {selected.render_error && (
                <div style={{ color: red, fontSize: 12, marginBottom: 8 }}>{selected.render_error}</div>
              )}
              {selected.status === 'ready' && selected.video_path ? (
                <video
                  key={selected.id}
                  controls
                  style={{ width: '100%', borderRadius: 6, background: '#000' }}
                  src={`/api/timelapses/${selected.id}/video`}
                />
              ) : selected.frame_count > 0 ? (
                <img
                  alt="Last frame"
                  style={{ width: '100%', borderRadius: 6, background: '#000' }}
                  src={`/api/timelapses/${selected.id}/frames/${selected.frame_count}`}
                />
              ) : (
                <div style={{ color: faint, fontSize: 13 }}>No frames yet.</div>
              )}
              <div style={{ marginTop: 10, fontSize: 12, color: muted }}>
                Interval {selected.interval_seconds}s · {selected.frame_count} frames
                {selected.bytes != null ? ` · ${(selected.bytes / 1024 / 1024).toFixed(1)} MB` : ''}
              </div>
            </>
          )}
        </div>
      </div>
      {toastEl}
      {confirmModal}
    </div>
  );
}

function btn(bg, color = '#fff') {
  return {
    background: bg,
    color,
    border: 'none',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };
}
