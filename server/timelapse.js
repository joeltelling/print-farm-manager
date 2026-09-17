/**
 * Timelapse capture: JPEG frames on an independent interval, optional ffmpeg MP4 render.
 * Hosted for Linux; ffmpeg is an external binary (child_process.spawn), not an npm dep.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { fetchSnapshotBuffer } = require('./camera');

const DATA_DIR = path.join(__dirname, 'data');
const TIMELAPSE_ROOT = path.join(DATA_DIR, 'timelapse');

// Retention sweep interval. Must exceed a typical short print so we do not
// thrash disk while a capture is still writing frames.
const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;

let ffmpegAvailable = null;
const activeTimers = new Map(); // key: timelapse id → interval handle
let retentionTimer = null;
let dbRef = null;

function probeFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 });
    ffmpegAvailable = r.status === 0;
  } catch (_) {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

function setting(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value != null ? row.value : fallback;
  } catch (_) {
    return fallback;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function frameName(n) {
  return `frame-${String(n).padStart(6, '0')}.jpg`;
}

function getTimelapse(db, id) {
  return db.prepare('SELECT * FROM timelapses WHERE id = ?').get(id);
}

function listTimelapses(db, opts = {}) {
  let q = 'SELECT * FROM timelapses WHERE 1=1';
  const params = [];
  if (opts.printer_id) { q += ' AND printer_id = ?'; params.push(opts.printer_id); }
  if (opts.job_id) { q += ' AND job_id = ?'; params.push(opts.job_id); }
  if (opts.part_id) { q += ' AND part_id = ?'; params.push(opts.part_id); }
  if (opts.status) { q += ' AND status = ?'; params.push(opts.status); }
  q += ' ORDER BY started_at DESC LIMIT ?';
  params.push(Math.min(Math.max(parseInt(opts.limit || '100', 10), 1), 500));
  return db.prepare(q).all(...params);
}

async function captureOneFrame(db, tlId) {
  const tl = getTimelapse(db, tlId);
  if (!tl || tl.status !== 'capturing') return;
  const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(tl.printer_id);
  if (!printer) return;

  let buf;
  try {
    buf = await fetchSnapshotBuffer(printer);
  } catch (err) {
    console.log(`[timelapse] snapshot failed for #${tlId}: ${err.message}`);
    return;
  }
  if (!buf) return;

  const dir = tl.dir_path || path.join(TIMELAPSE_ROOT, String(tl.job_id || `p${tl.printer_id}-${tl.id}`));
  ensureDir(dir);
  const next = (tl.frame_count || 0) + 1;
  const file = path.join(dir, frameName(next));
  fs.writeFileSync(file, buf);
  db.prepare(`
    UPDATE timelapses SET frame_count = ?, dir_path = ? WHERE id = ?
  `).run(next, dir, tlId);
}

function startCaptureLoop(db, tlId, intervalSeconds) {
  stopCaptureLoop(tlId);
  const ms = Math.max(2, Number(intervalSeconds) || 10) * 1000;
  const tick = () => { captureOneFrame(db, tlId).catch(() => {}); };
  tick();
  activeTimers.set(tlId, setInterval(tick, ms));
}

function stopCaptureLoop(tlId) {
  const t = activeTimers.get(tlId);
  if (t) {
    clearInterval(t);
    activeTimers.delete(tlId);
  }
}

/**
 * Start capturing for a job (idempotent on job_id UNIQUE).
 */
function startForJob(db, { jobId, printerId, partId }) {
  if (setting(db, 'timelapse_enabled', 'true') === 'false') return null;

  const existing = db.prepare('SELECT * FROM timelapses WHERE job_id = ?').get(jobId);
  if (existing) {
    if (existing.status === 'capturing') {
      startCaptureLoop(db, existing.id, existing.interval_seconds);
      return existing;
    }
    return existing;
  }

  const interval = parseInt(setting(db, 'timelapse_interval_seconds', '10'), 10) || 10;
  const dir = path.join(TIMELAPSE_ROOT, String(jobId));
  ensureDir(dir);
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO timelapses (job_id, printer_id, part_id, status, interval_seconds, frame_count, dir_path, started_at)
    VALUES (?, ?, ?, 'capturing', ?, 0, ?, ?)
  `).run(jobId, printerId, partId || null, interval, dir, now);
  const tl = getTimelapse(db, r.lastInsertRowid);
  startCaptureLoop(db, tl.id, interval);
  console.log(`[timelapse] started #${tl.id} for job ${jobId}`);
  return tl;
}

/**
 * Manual capture for a printer with no associated job.
 */
function startForPrinter(db, printerId) {
  const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(printerId);
  if (!printer) {
    const err = new Error('Printer not found');
    err.status = 404;
    throw err;
  }
  const open = db.prepare(`
    SELECT * FROM timelapses
    WHERE printer_id = ? AND job_id IS NULL AND status = 'capturing'
    ORDER BY started_at DESC LIMIT 1
  `).get(printerId);
  if (open) {
    startCaptureLoop(db, open.id, open.interval_seconds);
    return open;
  }

  const interval = parseInt(setting(db, 'timelapse_interval_seconds', '10'), 10) || 10;
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO timelapses (job_id, printer_id, part_id, status, interval_seconds, frame_count, dir_path, started_at)
    VALUES (NULL, ?, NULL, 'capturing', ?, 0, NULL, ?)
  `).run(printerId, interval, now);
  const tl = getTimelapse(db, r.lastInsertRowid);
  const dir = path.join(TIMELAPSE_ROOT, `p${printerId}-${tl.id}`);
  ensureDir(dir);
  db.prepare('UPDATE timelapses SET dir_path = ? WHERE id = ?').run(dir, tl.id);
  startCaptureLoop(db, tl.id, interval);
  console.log(`[timelapse] started manual #${tl.id} for printer ${printerId}`);
  return getTimelapse(db, tl.id);
}

function stopCapture(db, tlId) {
  stopCaptureLoop(tlId);
  const tl = getTimelapse(db, tlId);
  if (!tl) {
    const err = new Error('Timelapse not found');
    err.status = 404;
    throw err;
  }
  if (tl.status !== 'capturing') return tl;
  db.prepare(`UPDATE timelapses SET status = 'rendering', ended_at = ? WHERE id = ?`)
    .run(Date.now(), tlId);
  renderAsync(db, tlId);
  return getTimelapse(db, tlId);
}

function stopForPrinter(db, printerId) {
  const open = db.prepare(`
    SELECT * FROM timelapses
    WHERE printer_id = ? AND status = 'capturing'
    ORDER BY started_at DESC LIMIT 1
  `).get(printerId);
  if (!open) {
    const err = new Error('No active timelapse on this printer');
    err.status = 404;
    throw err;
  }
  return stopCapture(db, open.id);
}

function stopForJob(db, jobId) {
  const tl = db.prepare('SELECT * FROM timelapses WHERE job_id = ?').get(jobId);
  if (!tl || tl.status !== 'capturing') return null;
  return stopCapture(db, tl.id);
}

function renderAsync(db, tlId) {
  setImmediate(() => {
    renderTimelapse(db, tlId).catch((err) => {
      console.error(`[timelapse] render failed #${tlId}:`, err.message);
      db.prepare(`
        UPDATE timelapses SET status = 'failed', render_error = ? WHERE id = ?
      `).run(err.message, tlId);
    });
  });
}

function renderTimelapse(db, tlId) {
  return new Promise((resolve, reject) => {
    const tl = getTimelapse(db, tlId);
    if (!tl) return reject(new Error('Timelapse not found'));
    if (!tl.dir_path || !fs.existsSync(tl.dir_path)) {
      return reject(new Error('No frames directory'));
    }
    if ((tl.frame_count || 0) < 1) {
      db.prepare(`UPDATE timelapses SET status = 'failed', render_error = ? WHERE id = ?`)
        .run('No frames captured', tlId);
      return resolve(getTimelapse(db, tlId));
    }

    if (ffmpegAvailable == null) probeFfmpeg();
    if (!ffmpegAvailable) {
      db.prepare(`
        UPDATE timelapses SET status = 'failed', render_error = ?
        WHERE id = ?
      `).run('ffmpeg not found in PATH; frames are still available for download', tlId);
      return resolve(getTimelapse(db, tlId));
    }

    const fps = parseInt(setting(db, 'timelapse_fps', '10'), 10) || 10;
    const out = path.join(tl.dir_path, 'timelapse.mp4');
    const args = [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(tl.dir_path, 'frame-%06d.jpg'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      out,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
      }
      let bytes = null;
      try { bytes = fs.statSync(out).size; } catch (_) {}
      db.prepare(`
        UPDATE timelapses SET status = 'ready', video_path = ?, bytes = ?, render_error = NULL
        WHERE id = ?
      `).run(out, bytes, tlId);
      console.log(`[timelapse] ready #${tlId} (${tl.frame_count} frames)`);
      resolve(getTimelapse(db, tlId));
    });
  });
}

function deleteTimelapse(db, tlId) {
  const tl = getTimelapse(db, tlId);
  if (!tl) {
    const err = new Error('Timelapse not found');
    err.status = 404;
    throw err;
  }
  stopCaptureLoop(tlId);
  if (tl.dir_path && fs.existsSync(tl.dir_path)) {
    try { fs.rmSync(tl.dir_path, { recursive: true, force: true }); } catch (_) {}
  }
  db.prepare('DELETE FROM timelapses WHERE id = ?').run(tlId);
  return { ok: true };
}

function sweepRetention(db) {
  const days = parseInt(setting(db, 'timelapse_retention_days', '30'), 10) || 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const old = db.prepare(`
    SELECT id FROM timelapses
    WHERE status IN ('ready', 'failed', 'discarded')
      AND COALESCE(ended_at, started_at) < ?
  `).all(cutoff);
  for (const row of old) {
    try { deleteTimelapse(db, row.id); } catch (_) {}
  }
  if (old.length) console.log(`[timelapse] retention removed ${old.length} old captures`);
}

/**
 * Hook from poller / scheduler: sync capture state with printer PRINTING jobs.
 */
function onPrinterStatus(db, { printerId, newStatus }) {
  if (setting(db, 'timelapse_enabled', 'true') === 'false') return;

  if (newStatus === 'PRINTING') {
    const job = db.prepare(`
      SELECT id, part_id FROM jobs
      WHERE printer_id = ? AND status = 'printing'
      ORDER BY started_at DESC, id DESC LIMIT 1
    `).get(printerId);
    if (job) startForJob(db, { jobId: job.id, printerId, partId: job.part_id });
    return;
  }

  // Leaving PRINTING: stop any job-linked capturing row for this printer
  if (newStatus !== 'PRINTING' && newStatus !== 'PAUSED') {
    const open = db.prepare(`
      SELECT * FROM timelapses
      WHERE printer_id = ? AND status = 'capturing' AND job_id IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `).get(printerId);
    if (open) stopCapture(db, open.id);
  }
}

function start(db) {
  dbRef = db;
  probeFfmpeg();
  console.log(`[timelapse] ffmpeg ${ffmpegAvailable ? 'available' : 'NOT found (frames-only mode)'}`);
  ensureDir(TIMELAPSE_ROOT);

  // Resume any capturing rows left from a previous process
  const open = db.prepare("SELECT * FROM timelapses WHERE status = 'capturing'").all();
  for (const tl of open) {
    startCaptureLoop(db, tl.id, tl.interval_seconds);
  }
  if (open.length) console.log(`[timelapse] resumed ${open.length} capture(s)`);

  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = setInterval(() => {
    try { sweepRetention(db); } catch (e) {
      console.error('[timelapse] retention sweep failed:', e.message);
    }
  }, RETENTION_SWEEP_MS);
}

function stop() {
  for (const id of [...activeTimers.keys()]) stopCaptureLoop(id);
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  dbRef = null;
}

module.exports = {
  TIMELAPSE_ROOT,
  RETENTION_SWEEP_MS,
  start,
  stop,
  startForJob,
  startForPrinter,
  stopForPrinter,
  stopForJob,
  stopCapture,
  renderTimelapse,
  listTimelapses,
  getTimelapse,
  deleteTimelapse,
  onPrinterStatus,
  probeFfmpeg,
  frameName,
};
