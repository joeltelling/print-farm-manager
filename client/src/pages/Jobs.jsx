import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useConfirm } from '../useConfirm';
import EmptyState from '../components/EmptyState';

// Colors match the Fleet page conventions: blue = printing, green = done.
// Cancelled gets a line-through as a non-color cue against Queued.
const JOB_STATUS = {
  queued:    { bg: '#1f2937', text: '#9ca3af', label: 'Queued' },
  uploading: { bg: '#3b2c69', text: '#a78bfa', label: 'Uploading' },
  printing:  { bg: '#1e3a5f', text: '#60a5fa', label: 'Printing' },
  awaiting:  { bg: '#14532d', text: '#4ade80', label: 'Awaiting Sign-off' },
  finished:  { bg: '#14532d', text: '#86efac', label: 'Finished' },
  failed:    { bg: '#7f1d1d', text: '#f87171', label: 'Failed' },
  cancelled: { bg: '#111827', text: '#6b7280', label: 'Cancelled', strike: true },
};

// The printer can be held (awaiting operator sign-off) while the job row is still
// 'printing' (e.g. a printer goes PRINTING -> IDLE directly between polls, with no
// observable FINISHED/STOPPED tick). The scheduler correctly holds the printer but has
// nothing to resolve the job against yet, so the row stays 'printing' until Set Ready
// or Bad Print is used. Display-only: never write this back as jobs.status.
function displayJobStatus(job) {
  if (job.status === 'printing' && job.printer_is_held === 1 && job.printer_status !== 'PRINTING') {
    return 'awaiting';
  }
  return job.status;
}

const STATUS_OPTIONS = ['all', 'queued', 'uploading', 'printing', 'finished', 'failed', 'cancelled'];

function formatTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startMs, endMs) {
  if (!startMs) return '—';
  const ms  = (endMs || Date.now()) - startMs;
  const s   = Math.floor(ms / 1000);
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const selectSx = {
  background: '#1e2433',
  border: '1px solid #2d3748',
  borderRadius: 4,
  padding: '5px 10px',
  color: '#e2e8f0',
  fontSize: 13,
  outline: 'none',
};

export default function Jobs() {
  const [confirm, confirmModal]   = useConfirm();
  const [jobs, setJobs]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [projects, setProjects]   = useState([]);
  const [printers, setPrinters]   = useState([]);

  // Filters live in the URL so they survive reloads and can be shared/bookmarked
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusFilter, setStatus]   = useState(searchParams.get('status') || 'all');
  const [projectFilter, setProject] = useState(searchParams.get('project') || '');
  const [printerFilter, setPrinter] = useState(searchParams.get('printer') || '');

  useEffect(() => {
    const next = {};
    if (statusFilter !== 'all') next.status = statusFilter;
    if (projectFilter)          next.project = projectFilter;
    if (printerFilter)          next.printer = printerFilter;
    setSearchParams(next, { replace: true });
  }, [statusFilter, projectFilter, printerFilter, setSearchParams]);

  const fetchJobs = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter  !== 'all') params.set('status',     statusFilter);
    if (projectFilter)           params.set('project_id', projectFilter);
    if (printerFilter)           params.set('printer_id', printerFilter);

    try {
      const res  = await fetch(`/api/jobs?${params}`);
      if (!res.ok) throw new Error('Failed to fetch jobs');
      setJobs(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, projectFilter, printerFilter]);

  // Load filter option data once
  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(setProjects).catch(() => {});
    fetch('/api/printers').then(r => r.json()).then(setPrinters).catch(() => {});
  }, []);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 15000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  async function cancelJob(jobId) {
    const ok = await confirm({
      title: 'Cancel Job',
      message: 'Remove this job from the queue?',
      confirmLabel: 'Cancel Job',
      danger: true,
    });
    if (!ok) return;
    await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
    fetchJobs();
  }

  return (
    <div>
      {confirmModal}
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Job Queue</h1>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <select value={statusFilter} onChange={(e) => setStatus(e.target.value)} style={selectSx}>
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>{s === 'all' ? 'All statuses' : s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>

        <select value={projectFilter} onChange={(e) => setProject(e.target.value)} style={selectSx}>
          <option value="">All projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <select value={printerFilter} onChange={(e) => setPrinter(e.target.value)} style={selectSx}>
          <option value="">All printers</option>
          {printers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <span style={{ color: '#475569', fontSize: 13, marginLeft: 4 }}>
          {jobs.length} job{jobs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {loading && <p style={{ color: '#64748b' }}>Loading…</p>}
      {!loading && jobs.length === 0 && (
        statusFilter !== 'all' || projectFilter || printerFilter ? (
          <p style={{ color: '#64748b' }}>No jobs match the current filters — try clearing them.</p>
        ) : (
          <EmptyState
            title="No jobs yet"
            hint="Jobs are created automatically: when a project is Active and one of its parts has G-code uploaded, the scheduler dispatches jobs to idle printers of the matching model. If you expected a job here, check that the project is Active and a matching printer is idle (not held or decommissioned)."
            actionLabel="Go to Projects"
            actionTo="/projects"
          />
        )
      )}

      {/* Below 700px the table collapses to stacked cards */}
      <style>{`
        .jobs-cards { display: none; }
        @media (max-width: 700px) {
          .jobs-table-wrap { display: none; }
          .jobs-cards { display: flex; flex-direction: column; gap: 8px; }
        }
      `}</style>

      {jobs.length > 0 && (
        <div className="jobs-cards">
          {jobs.map(job => {
            const st = JOB_STATUS[displayJobStatus(job)] || { bg: '#1f2937', text: '#9ca3af', label: job.status };
            return (
              <div key={job.id} style={{ background: '#1e2433', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#cbd5e1' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.part_name}</span>
                  <span style={{ background: st.bg, color: st.text, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700, flexShrink: 0, textDecoration: st.strike ? 'line-through' : 'none' }}>
                    {st.label}
                  </span>
                </div>
                <div style={{ color: '#94a3b8', fontSize: 12, marginBottom: 2 }}>
                  {job.project_name} · {job.printer_name} <span style={{ color: '#64748b', fontFamily: 'monospace', fontSize: 11 }}>({job.printer_model})</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#64748b', fontSize: 12 }}>
                  <span>
                    {formatTime(job.started_at)}
                    {job.started_at && <> · {formatDuration(job.started_at, job.finished_at || null)}</>}
                  </span>
                  {job.status === 'queued' && (
                    <button
                      onClick={() => cancelJob(job.id)}
                      style={{ background: '#7f1d1d', color: '#f87171', border: 'none', borderRadius: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="jobs-table-wrap" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#64748b', textAlign: 'left', borderBottom: '1px solid #2d3748' }}>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}>ID</th>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}>Part</th>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}>Project</th>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}>Printer</th>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}>Model</th>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}>Status</th>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}>Started</th>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}>Duration</th>
                <th style={{ padding: '6px 10px', fontWeight: 600 }}></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => {
                const st = JOB_STATUS[displayJobStatus(job)] || { bg: '#1f2937', text: '#9ca3af', label: job.status };
                return (
                  <tr
                    key={job.id}
                    style={{ borderBottom: '1px solid #1e2433', color: '#cbd5e1' }}
                  >
                    <td style={{ padding: '8px 10px', color: '#475569', fontFamily: 'monospace', fontSize: 12 }}>
                      #{job.id}
                    </td>
                    <td style={{ padding: '8px 10px' }}>{job.part_name}</td>
                    <td style={{ padding: '8px 10px', color: '#94a3b8' }}>{job.project_name}</td>
                    <td style={{ padding: '8px 10px' }}>{job.printer_name}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{
                        background: '#0f172a', border: '1px solid #2d3748', borderRadius: 3,
                        padding: '1px 6px', fontSize: 11, fontFamily: 'monospace', color: '#64748b',
                      }}>
                        {job.printer_model}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ background: st.bg, color: st.text, borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700, textDecoration: st.strike ? 'line-through' : 'none' }}>
                        {st.label}
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {formatTime(job.started_at)}
                    </td>
                    <td style={{ padding: '8px 10px', color: '#64748b' }}>
                      {job.started_at
                        ? formatDuration(job.started_at, job.finished_at || null)
                        : '—'}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      {job.status === 'queued' && (
                        <button
                          onClick={() => cancelJob(job.id)}
                          style={{
                            background: '#7f1d1d', color: '#f87171', border: 'none',
                            borderRadius: 4, padding: '3px 10px', fontSize: 12,
                            fontWeight: 600, cursor: 'pointer',
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
