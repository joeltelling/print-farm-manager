// Klipper driver — Moonraker REST API (HTTP polling, port 7125)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Moonraker is the standard API layer for Klipper firmware (Voron, etc.).
// All communication is plain HTTP — no persistent connection, no auth required on LAN.
// Upload: POST multipart to /server/files/upload with print=true — starts immediately.

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { resolveHost } = require('../mdns-resolve');
const { describeConnectionError } = require('../connection-test-helpers');

const PORT = 7125;

async function base(printer) {
  // Strip any accidental protocol prefix or trailing slashes — field expects bare IP.
  const raw = printer.ip.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const ip = await resolveHost(raw);
  return `http://${ip}:${PORT}`;
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
      `${await base(printer)}/printer/objects/query`,
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
    `${await base(printer)}/server/files/upload`,
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
    await axios.post(`${await base(printer)}/printer/print/cancel`, null, { timeout: 10000 });
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

// ─── Camera ─────────────────────────────────────────────────────────────────

// Returns { streamUrl, snapshotUrl } for the selected webcam registered in
// Moonraker's webcam management API, or null if none is configured or the
// printer is unreachable. Never throws.
// Reference: https://moonraker.readthedocs.io/en/latest/external_api/webcams/
//
// printer.camera_uid selects a specific webcam (crowsnest can register more than
// one), matched against each entry's Moonraker-assigned uid, the field Moonraker's
// own docs recommend for identifying a webcam, since name is not guaranteed stable.
// Falls back to the first enabled webcam (previous behavior) when camera_uid is
// unset or does not match any entry, so an unconfigured or stale selection degrades
// gracefully instead of returning nothing.
async function getCameraUrl(printer) {
  try {
    const res = await axios.get(`${await base(printer)}/server/webcams/list`, { timeout: 8000 });
    const webcams = res.data?.result?.webcams || [];
    const cam = (printer.camera_uid && webcams.find(w => w.uid === printer.camera_uid))
      || webcams.find(w => w.enabled)
      || webcams[0];
    if (!cam || !cam.stream_url) return null;

    // stream_url/snapshot_url may be a relative path: Moonraker's docs resolve
    // these against the machine's default web port (80, the Fluidd/Mainsail
    // frontend), not Moonraker's own port 7125.
    const rawHost = printer.ip.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/:\d+$/, '');
    const host = await resolveHost(rawHost);
    const resolve = (u) => (/^https?:\/\//i.test(u) ? u : `http://${host}${u}`);
    return {
      streamUrl: resolve(cam.stream_url),
      snapshotUrl: cam.snapshot_url ? resolve(cam.snapshot_url) : null,
    };
  } catch (_) {
    return null;
  }
}

// Returns every webcam Moonraker knows about for this printer, as
// [{ uid, name, enabled }], for the camera picker on the Add Printer and
// printer-edit forms (a crowsnest setup can register more than one). Empty
// array on any failure or when none are configured. Never throws.
async function listCameras(printer) {
  try {
    const res = await axios.get(`${await base(printer)}/server/webcams/list`, { timeout: 8000 });
    const webcams = res.data?.result?.webcams || [];
    return webcams.map(w => ({ uid: w.uid, name: w.name, enabled: !!w.enabled }));
  } catch (_) {
    return [];
  }
}

// ─── Lane data (klipper-filament-sync plugin) ─────────────────────────────────

// Returns per-lane filament state from the klipper-filament-sync plugin
// (github.com/maevebaksa/klipper-filament-sync), or null if the plugin is not
// installed or has nothing stored yet. Never throws.
//
// The plugin has no HTTP API of its own: it writes into Moonraker's generic
// database under namespace "lane_data", keyed "tool0", "tool1", ... (one per
// toolhead), each value shaped { lane, material, color, nozzle_temp?, bed_temp? }.
// Confirmed by reading the plugin's filament_sync_bridge.py directly (its README
// names the namespace but does not document the key/value shape) and cross-checked
// against Moonraker's own database API docs for the request/response envelope.
// Reference: https://moonraker.readthedocs.io/en/latest/external_api/database/
async function getLaneData(printer) {
  try {
    const res = await axios.get(`${await base(printer)}/server/database/item`, {
      params: { namespace: 'lane_data' },
      timeout: 8000,
    });
    const value = res.data?.result?.value;
    if (!value || typeof value !== 'object') return null;

    const lanes = [];
    for (const [key, lane] of Object.entries(value)) {
      const match = /^tool(\d+)$/.exec(key);
      if (!match || !lane || typeof lane !== 'object') continue;
      lanes.push({
        index: Number(match[1]),
        material: lane.material || null,
        color: lane.color || null,
      });
    }
    return lanes.length ? lanes : null;
  } catch (_) {
    return null;
  }
}

// ─── Test connection ─────────────────────────────────────────────────────────

// One-off reachability check for the "Test Connection" button. Does not create or
// touch any cached connection state (Moonraker has none). Never throws.
async function testConnection(printer) {
  try {
    const raw = printer.ip.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const ip = await resolveHost(raw);
    await axios.get(
      `http://${ip}:${PORT}/printer/objects/query`,
      { params: { webhooks: '' }, timeout: 8000 }
    );
    return { ok: true, message: ip !== raw ? `Connected (resolved to ${ip})` : 'Connected' };
  } catch (err) {
    return { ok: false, message: describeConnectionError(err) };
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, getCameraUrl, testConnection, listCameras, getLaneData };
