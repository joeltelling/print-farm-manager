import { useState, useEffect, useCallback } from 'react';
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
  decommission: { label: 'Decommissioned', bg: '#7f1d1d', color: '#fca5a5' },
  recommission:  { label: 'Recommissioned', bg: '#14532d', color: '#86efac' },
  job_finished:  { label: 'Job Finished',   bg: '#1e3a5f', color: '#93c5fd' },
  job_failed:    { label: 'Job Failed',      bg: '#78350f', color: '#fcd34d' },
  note:          { label: 'Note',            bg: '#1e2433', color: '#94a3b8' },
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

  const fetchData = useCallback(async () => {
    const [printerRes, eventsRes, statsRes] = await Promise.all([
      fetch(`/api/printers/${id}`),
      fetch(`/api/printers/${id}/events`),
      fetch(`/api/printers/${id}/jobs/stats`),
    ]);
    if (printerRes.ok) setPrinter(await printerRes.json());
    if (eventsRes.ok)  setEvents(await eventsRes.json());
    if (statsRes.ok)   setStats(await statsRes.json());
    setLoading(false);
  }, [id]);

  const fetchJobPage = useCallback(async (page) => {
    const res = await fetch(`/api/printers/${id}/jobs?page=${page}`);
    if (res.ok) setJobHistory(await res.json());
  }, [id]);

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
          <span style={{ fontWeight: 800, fontSize: 20, color: '#e2e8f0' }}>{printer.name}</span>
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
        </div>

        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 13, color: '#64748b' }}>
          <span>Model: <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{printer.model}</span></span>
          <span>IP: <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>{printer.ip}</span></span>
          {printer.group_name && (
            <span>Group: <span style={{ color: '#94a3b8' }}>{printer.group_name}</span></span>
          )}
          {printer.type && printer.type !== 'prusa' && (
            <span>Connector: <span style={{ color: '#94a3b8' }}>{printer.type}</span></span>
          )}
        </div>

        {printer.decommissioned_at && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }}>
            Decommissioned: {formatTimestamp(printer.decommissioned_at)}
          </div>
        )}
      </div>

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
        <p style={{ color: '#475569', fontSize: 14 }}>No events recorded yet.</p>
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
                  border: 'none', borderRadius: 5, padding: '5px 14px',
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
                  border: 'none', borderRadius: 5, padding: '5px 14px',
                  fontSize: 13, fontWeight: 600, cursor: jobPage === jobHistory.total_pages ? 'not-allowed' : 'pointer',
                }}
              >Next →</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
