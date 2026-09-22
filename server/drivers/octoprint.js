// OctoPrint driver — OctoPrint REST API (HTTP polling)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// All functions are async and take a `printer` DB row as the first argument.
// uploadAndPrint receives a resolved absolute path to the G-code file on disk.
//
// Reference: https://docs.octoprint.org/en/main/api/index.html
// printer.ip may include a port (e.g. "octopi.local:5000") — OctoPrint commonly
// runs behind its bundled server on :5000 rather than :80, so no port is assumed.

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { resolveHost } = require('../mdns-resolve');
const { describeConnectionError } = require('../connection-test-helpers');

function headers(printer) {
  return { 'X-Api-Key': printer.api_key };
}

// ─── Status ─────────────────────────────────────────────────────────────────

// Returns { status, progress, timeRemaining, currentFile }
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | ERROR | OFFLINE | UNKNOWN
//
// OctoPrint has no persistent "just finished" state like PrusaLink/Moonraker — after a
// print completes it reports the same `operational` flags as a printer that never printed.
// We detect completion by combining the flags with /api/job's leftover progress: not
// printing/paused, a job file is still loaded, and completion sits at 100%. This condition
// naturally stops being true once the operator (or scheduler) starts the next print, and
// poller.js only reacts to it once since the DB status only changes on the transition.
async function getStatus(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    const [printerRes, jobRes] = await Promise.all([
      axios.get(`http://${ip}/api/printer`, { headers: headers(printer), timeout: 8000 }),
      axios.get(`http://${ip}/api/job`, { headers: headers(printer), timeout: 8000 }),
    ]);

    const flags = printerRes.data?.state?.flags || {};
    const job = jobRes.data || {};
    const completion = job.progress?.completion ?? null;
    const hasJobFile = !!job.job?.file?.name;

    let status;
    if (flags.error || flags.closedOrError) {
      status = 'ERROR';
    } else if (flags.printing || flags.pausing || flags.cancelling) {
      status = 'PRINTING';
    } else if (flags.paused) {
      status = 'PAUSED';
    } else if (flags.operational && hasJobFile && completion === 100) {
      status = 'FINISHED';
    } else if (flags.operational) {
      status = 'IDLE';
    } else {
      status = 'UNKNOWN';
    }

    const progress = (status === 'PRINTING') ? completion : null;
    const timeRemaining = (status === 'PRINTING') ? (job.progress?.printTimeLeft ?? null) : null;
    const currentFile = (status === 'PRINTING' && hasJobFile) ? job.job.file.name : null;

    return { status, progress, timeRemaining, currentFile };
  } catch (_) {
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }
}

// ─── Upload & Print ──────────────────────────────────────────────────────────

// Uploads the G-code file to OctoPrint's "local" file location and starts the print in
// one call (OctoPrint supports select+print as multipart form fields, unlike PrusaLink
// which needs a header on the upload and Moonraker which needs a separate print field).
// Throws UPLOAD_CONFLICT if OctoPrint refuses because the same file is mid-print.
async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const ip = await resolveHost(printer.ip);
  const form = new FormData();
  form.append('file', fs.createReadStream(gcodeFullPath), { filename });
  form.append('select', 'true');
  form.append('print', 'true');

  try {
    await axios.post(
      `http://${ip}/api/files/local`,
      form,
      {
        headers: { ...headers(printer), ...form.getHeaders() },
        timeout: 300000, // 5 minutes — large files on slow networks
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
  } catch (err) {
    if (err.response?.status === 409) {
      throw Object.assign(
        new Error(`409 Conflict on upload — file likely mid-print on ${printer.name}`),
        { code: 'UPLOAD_CONFLICT' }
      );
    }
    throw err;
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    await axios.post(
      `http://${ip}/api/job`,
      { command: 'cancel' },
      { headers: headers(printer), timeout: 10000 }
    );
  } catch (err) {
    console.warn(`[octoprint] Cancel failed for ${printer.name}: ${err.message}`);
  }
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
// Used by the scheduler after an upload failure to detect the case where our
// request timed out but the printer received the file and started printing anyway.
async function checkIfPrinting(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    const response = await axios.get(`http://${ip}/api/printer`, {
      headers: headers(printer),
      timeout: 8000,
    });
    const flags = response.data?.state?.flags || {};
    return !!(flags.printing || flags.paused || flags.pausing || flags.cancelling);
  } catch (_) {
    return false;
  }
}

// ─── Camera ─────────────────────────────────────────────────────────────────

// Returns { streamUrl, snapshotUrl } from OctoPrint's configured webcam, or null
// if no webcam is configured, the printer is unreachable, or the API key lacks
// SETTINGS_READ permission. Never throws.
// Reference: https://docs.octoprint.org/en/main/api/settings.html
async function getCameraUrl(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    const res = await axios.get(`http://${ip}/api/settings`, {
      headers: headers(printer),
      timeout: 8000,
    });
    const webcam = res.data?.webcam || {};
    if (!webcam.streamUrl) return null;

    // streamUrl/snapshotUrl are commonly relative (e.g. "/webcam/?action=stream"),
    // proxied through the same host OctoPrint itself is served on.
    const resolve = (u) => (/^https?:\/\//i.test(u) ? u : `http://${ip}${u}`);
    return {
      streamUrl: resolve(webcam.streamUrl),
      snapshotUrl: webcam.snapshotUrl ? resolve(webcam.snapshotUrl) : null,
    };
  } catch (_) {
    return null;
  }
}

// ─── Test connection ─────────────────────────────────────────────────────────

// One-off reachability check for the "Test Connection" button. Does not create or
// touch any cached connection state (OctoPrint has none). Never throws.
async function testConnection(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    await axios.get(`http://${ip}/api/printer`, { headers: headers(printer), timeout: 8000 });
    return { ok: true, message: ip !== printer.ip ? `Connected (resolved to ${ip})` : 'Connected' };
  } catch (err) {
    return { ok: false, message: describeConnectionError(err) };
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, getCameraUrl, testConnection };
