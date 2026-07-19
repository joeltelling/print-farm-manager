// Klipper driver, Moonraker REST API (HTTP polling, default port 7125)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Moonraker is the standard API layer for Klipper firmware (Voron, etc.).
// All communication is plain HTTP — no persistent connection, no auth required on LAN.
// Upload: POST multipart to /server/files/upload with print=true — starts immediately.

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const DEFAULT_PORT = 7125;

function base(printer) {
  // Strip any accidental protocol prefix or trailing slashes — field expects bare IP.
  const cleaned = printer.ip.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // Optional ":port" suffix lets multiple Moonraker instances share one host.
  const match = cleaned.match(/^(.+):(\d+)$/);
  const host = match ? match[1] : cleaned;
  const port = match ? match[2] : DEFAULT_PORT;
  return `http://${host}:${port}`;
}

// ─── Status ─────────────────────────────────────────────────────────────────

// Moonraker print_stats.state → canonical status
const STATE_MAP = {
  standby:   'IDLE',
  printing:  'PRINTING',
  paused:    'PAUSED',
  complete:  'FINISHED',
  error:     'ERROR',
  cancelled: 'STOPPED',
};

async function getStatus(printer) {
  try {
    const res = await axios.get(
      `${base(printer)}/printer/objects/query`,
      {
        params: { print_stats: '', virtual_sdcard: '', webhooks: '' },
        timeout: 8000,
      }
    );

    const stats  = res.data?.result?.status?.print_stats  || {};
    const vsd    = res.data?.result?.status?.virtual_sdcard || {};
    const hooks  = res.data?.result?.status?.webhooks || {};

    // If Klipper itself is not ready (startup, shutdown, error), report offline.
    if (hooks.state && hooks.state !== 'ready') {
      return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
    }

    const status = STATE_MAP[stats.state] || 'UNKNOWN';

    let progress    = null;
    let timeRemaining = null;
    let currentFile = null;

    if (status === 'PRINTING' || status === 'PAUSED') {
      const pct = vsd.progress ?? null;
      if (pct != null) progress = Math.round(pct * 100);

      // Estimate time remaining from elapsed print time and file progress.
      // Only meaningful once a few percent in — avoid div-by-zero and wildly
      // inaccurate early estimates.
      const elapsed = stats.print_duration ?? 0;
      if (pct != null && pct > 0.02 && elapsed > 0) {
        timeRemaining = Math.round(elapsed * (1 - pct) / pct);
      }

      if (stats.filename) {
        currentFile = stats.filename;
      }
    }

    return { status, progress, timeRemaining, currentFile };
  } catch (_) {
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }
}

// ─── Upload & Print ──────────────────────────────────────────────────────────

// Uploads the G-code file to Moonraker's gcodes directory, then triggers a print.
// Moonraker deduplicates by filename — uploading a file that already exists
// overwrites it silently, so no pre-delete step is needed.
async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const form = new FormData();
  form.append('file', fs.createReadStream(gcodeFullPath), { filename });
  form.append('print', 'true'); // must be a form field, not a query param

  await axios.post(
    `${base(printer)}/server/files/upload`,
    form,
    {
      headers: form.getHeaders(),
      timeout: 300000, // 5 minutes for large files
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  try {
    await axios.post(`${base(printer)}/printer/print/cancel`, null, { timeout: 10000 });
  } catch (err) {
    console.warn(`[klipper] Cancel failed for ${printer.name}: ${err.message}`);
  }
}

// ─── Check if printing ────────────────────────────────────────────────────────

async function checkIfPrinting(printer) {
  try {
    const { status } = await getStatus(printer);
    return status === 'PRINTING' || status === 'PAUSED';
  } catch (_) {
    return false;
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
