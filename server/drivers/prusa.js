// Prusa driver — PrusaLink REST API (HTTP polling)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// All functions are async and take a `printer` DB row as the first argument.
// uploadAndPrint receives a resolved absolute path to the G-code file on disk.

const axios = require('axios');
const fs = require('fs');
const { resolveHost } = require('../mdns-resolve');

// ─── Status ─────────────────────────────────────────────────────────────────

// Returns { status, progress, timeRemaining }
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | ERROR | OFFLINE | READY | UNKNOWN
// progress and timeRemaining are null when not printing.
async function getStatus(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    const response = await axios.get(`http://${ip}/api/v1/status`, {
      headers: { 'X-Api-Key': printer.api_key },
      timeout: 8000,
    });

    const data = response.data;
    const status = (data?.printer?.state || 'UNKNOWN').toUpperCase();
    const progress = (status === 'PRINTING' && data?.job) ? (data.job.progress ?? null) : null;
    const timeRemaining = (status === 'PRINTING' && data?.job) ? (data.job.time_remaining ?? null) : null;

    return { status, progress, timeRemaining, currentFile: null };
  } catch (_) {
    return { status: 'OFFLINE', progress: null, timeRemaining: null };
  }
}

// ─── Upload & Print ──────────────────────────────────────────────────────────

// Uploads the G-code file to the printer's USB storage and starts the print.
// gcodeFullPath must be a resolved absolute path that already exists on disk.
// filename is the bare filename to use on the printer (e.g. "part.bgcode").
// Throws UPLOAD_CONFLICT if a transfer is already in progress on the printer.
async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const ip = await resolveHost(printer.ip);

  // Delete any existing copy on the USB drive to avoid stale file conflicts.
  // A 409 means a file transfer is already in progress — propagate as UPLOAD_CONFLICT
  // so the caller can apply a longer retry delay.
  try {
    await axios.delete(
      `http://${ip}/api/v1/files/usb/${encodeURIComponent(filename)}`,
      { headers: { 'X-Api-Key': printer.api_key }, timeout: 10000 }
    );
    console.log(`[prusa] Deleted existing ${filename} from ${printer.name}`);
  } catch (err) {
    if (err.response?.status === 409) {
      throw Object.assign(
        new Error(`409 Conflict on pre-delete — file transfer likely still in progress on ${printer.name}`),
        { code: 'UPLOAD_CONFLICT' }
      );
    }
    // 404 = file wasn't there, that's fine. Any other error is a warning, not fatal.
    if (!err.response || err.response.status !== 404) {
      console.warn(`[prusa] Pre-delete warning for ${printer.name}: ${err.message}`);
    }
  }

  const fileStream = fs.createReadStream(gcodeFullPath);
  const stat = fs.statSync(gcodeFullPath);

  try {
    await axios.put(
      `http://${ip}/api/v1/files/usb/${encodeURIComponent(filename)}`,
      fileStream,
      {
        headers: {
          'X-Api-Key': printer.api_key,
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Print-After-Upload': '1',
        },
        timeout: 300000, // 5 minutes — large files on slow networks
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
  } catch (err) {
    if (err.response?.status === 409) {
      throw Object.assign(
        new Error(`409 Conflict on upload — file transfer likely still in progress on ${printer.name}`),
        { code: 'UPLOAD_CONFLICT' }
      );
    }
    throw err;
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

// Cancel the current job on the printer.
// Not currently used by the scheduler — stub for interface completeness.
async function cancelJob(_printer) {
  // PrusaLink v1 does not expose a reliable cancel endpoint.
  // To be implemented when needed.
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
// Used by the scheduler after an upload failure to detect the case where our
// request timed out but the printer received the file and started printing anyway.
async function checkIfPrinting(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    const response = await axios.get(`http://${ip}/api/v1/status`, {
      headers: { 'X-Api-Key': printer.api_key },
      timeout: 8000,
    });
    const state = (response.data?.printer?.state || '').toUpperCase();
    return state === 'PRINTING' || state === 'PAUSED';
  } catch (_) {
    return false;
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
