// Elegoo Centauri Carbon driver — SDCP protocol (WebSocket, V3.0.0)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Uses the `sdcp` npm package which handles WebSocket connection management,
// message framing, and UUID-matched request/response correlation.
//
// Connections are kept alive in a module-level Map and reused across poll ticks.
// AutoReconnect handles drops transparently.

const SDCP = require('sdcp');

// Map of printer.id → SDCPPrinterWS instance
const connections = new Map();

// ─── Connection management ────────────────────────────────────────────────────

// Returns a connected SDCPPrinterWS for the given printer DB row.
// Creates and connects a new instance if one doesn't exist yet.
async function getConnection(printer) {
  if (connections.has(printer.id)) {
    return connections.get(printer.id);
  }

  const client = new SDCP.SDCPPrinterWS({
    MainboardIP: printer.ip,
  });

  client.AutoReconnect = 5000; // reconnect every 5s on drop

  client.on('disconnected', () => {
    console.log(`[elegoo] ${printer.name} disconnected`);
  });

  client.on('reconnected', () => {
    console.log(`[elegoo] ${printer.name} reconnected`);
  });

  client.on('error', (err) => {
    // Suppress noisy socket errors from console — reconnect handles them
    if (process.env.DEBUG_ELEGOO) {
      console.warn(`[elegoo] ${printer.name} error:`, err?.message || err);
    }
  });

  await client.Connect(printer.ip);
  connections.set(printer.id, client);
  console.log(`[elegoo] Connected to ${printer.name} (${printer.ip})`);
  return client;
}

// Remove a connection from the pool (called when a printer is unreachable)
function dropConnection(printerId) {
  const client = connections.get(printerId);
  if (client) {
    try { client.Disconnect?.(); } catch (_) {}
    connections.delete(printerId);
  }
}

// ─── Canonical state mapping ──────────────────────────────────────────────────

// Maps SDCP PrintInfo.Status integer codes to canonical status strings.
// Source: SDCP V3.0.0 spec and cassini/elegoo-homeassistant reference implementations.
//
// 0 = Idle (no print running)
// 1 = Printing (active print job)
// 2 = Paused
// 3 = Stopped (user-stopped — treat as FINISHED so operator confirmation fires)
// 4 = Complete (print finished)
// 16+ = Various error codes
function mapStatus(printInfo) {
  if (!printInfo) return 'UNKNOWN';
  const code = printInfo.Status ?? printInfo.CurrentStatus;
  switch (code) {
    case 0:  return 'IDLE';
    case 1:  return 'PRINTING';
    case 2:  return 'PAUSED';
    case 3:  return 'FINISHED'; // stopped — operator must confirm
    case 4:  return 'FINISHED';
    default:
      if (code >= 16) return 'ERROR';
      return 'UNKNOWN';
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Returns { status, progress, timeRemaining }
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | ERROR | OFFLINE | UNKNOWN
// progress (0–100) and timeRemaining (seconds) are null when not printing.
async function getStatus(printer) {
  try {
    const client = await getConnection(printer);
    const raw = await client.GetStatus();

    const printInfo = raw?.Status?.PrintInfo ?? raw?.PrintInfo ?? raw;
    const status = mapStatus(printInfo);

    const progress = (status === 'PRINTING' || status === 'PAUSED')
      ? (printInfo?.CurrentTicks != null && printInfo?.TotalTicks > 0
          ? Math.round((printInfo.CurrentTicks / printInfo.TotalTicks) * 100)
          : null)
      : null;

    const timeRemaining = (status === 'PRINTING' || status === 'PAUSED')
      ? (printInfo?.RemainTime ?? null)
      : null;

    return { status, progress, timeRemaining };
  } catch (_) {
    dropConnection(printer.id);
    return { status: 'OFFLINE', progress: null, timeRemaining: null };
  }
}

// ─── Upload & Print ───────────────────────────────────────────────────────────

// Uploads the G-code file to the printer and starts the print.
// gcodeFullPath must be a resolved absolute path that already exists on disk.
// filename is the bare filename (e.g. "part.gcode") — used as the remote filename.
async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const client = await getConnection(printer);

  console.log(`[elegoo] Uploading ${filename} to ${printer.name}…`);

  await client.UploadFile(gcodeFullPath, {
    ProgressCallback: (progress) => {
      if (progress.Status === 'Uploading') {
        process.stdout.write(`\r[elegoo] ${printer.name} upload: ${progress.Status}`);
      } else {
        console.log(`[elegoo] ${printer.name} upload: ${progress.Status}`);
      }
    },
  });

  console.log(`[elegoo] Upload complete — starting print on ${printer.name}`);

  // Start the print (file path on the printer's USB storage)
  await client.Start(`/usb/${filename}`);

  console.log(`[elegoo] Print started on ${printer.name}`);
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  try {
    const client = await getConnection(printer);
    await client.Stop();
    console.log(`[elegoo] Job cancelled on ${printer.name}`);
  } catch (err) {
    console.warn(`[elegoo] Cancel failed for ${printer.name}: ${err.message}`);
  }
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
// Used by the scheduler after an upload failure to check if the print started anyway.
async function checkIfPrinting(printer) {
  try {
    const { status } = await getStatus(printer);
    return status === 'PRINTING' || status === 'PAUSED';
  } catch (_) {
    return false;
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
