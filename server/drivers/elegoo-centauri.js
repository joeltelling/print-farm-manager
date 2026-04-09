// Elegoo Centauri Carbon driver — SDCP protocol (WebSocket, V3.0.0)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Uses the `sdcp` npm package which handles WebSocket connection management,
// message framing, and UUID-matched request/response correlation.
//
// Connections are kept alive in a module-level Map and reused across poll ticks.
// AutoReconnect handles drops transparently.

// Require only the WebSocket class directly — sdcp's main index also loads
// SDCPPrinterMQTT which requires 'mqtt-server' (an optional peer dep we don't need).
const SDCPPrinterWS = require('sdcp/SDCPPrinterWS');
const path = require('path');

// Map of printer.id → SDCPPrinterWS instance
const connections = new Map();

// ─── Connection management ────────────────────────────────────────────────────

// Returns a connected SDCPPrinterWS for the given printer DB row.
// Creates and connects a new instance if one doesn't exist yet.
async function getConnection(printer) {
  if (connections.has(printer.id)) {
    return connections.get(printer.id);
  }

  const client = new SDCPPrinterWS({
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
// 0  = Idle (no print running)
// 1  = Printing (active print job)
// 2  = Paused
// 3  = Stopped (user-stopped — treat as FINISHED so operator confirmation fires)
// 4  = Complete (print finished)
// 13 = Active print (layer incrementing) — observed on Centauri Carbon during normal print
// 16 = Preparing / preheating / homing before print starts — treat as PRINTING.
//      Confirmed via raw PrintInfo: TotalLayer and Filename are populated,
//      Progress=0. This is normal FDM startup, not a fault.
// 21 = Another startup/init state (CurrentLayer=0, file loaded) — observed on Centauri Carbon
// Unrecognised codes: UNKNOWN (not ERROR) so stray transient codes don't hold printers.
// Add explicit cases above for any new codes observed in debug logs.
function mapStatus(printInfo) {
  if (!printInfo) return 'UNKNOWN';
  const code = printInfo.Status ?? printInfo.CurrentStatus;
  switch (code) {
    case 0:  return 'IDLE';
    case 1:  return 'PRINTING';
    case 2:  return 'PAUSED';
    case 3:  return 'FINISHED'; // stopped — operator must confirm
    case 4:  return 'FINISHED';
    case 13: return 'PRINTING'; // active print, layer incrementing (observed on Centauri Carbon)
    case 16: return 'PRINTING'; // preparing/preheating — normal FDM startup state
    case 21: return 'PRINTING'; // startup/init state, file loaded (observed on Centauri Carbon)
    default: return 'UNKNOWN';
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

    // Log raw status code whenever it maps to something unexpected so we can
    // refine the mapping based on real Centauri Carbon firmware behaviour.
    const rawCode = printInfo?.Status ?? printInfo?.CurrentStatus;
    if (status === 'UNKNOWN') {
      console.log(`[elegoo] ${printer.name} raw status code: ${rawCode} → ${status} (full PrintInfo: ${JSON.stringify(printInfo)})`);
    }

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

  console.log(`[elegoo] Upload complete — waiting 1s before start on ${printer.name}`);

  // The slicer spec recommends a 1-second delay between upload completion and Start
  // to give the firmware time to close the file before processing the print command.
  await new Promise(resolve => setTimeout(resolve, 1000));

  // sdcp's UploadFile uses path.basename(gcodeFullPath) as the on-printer filename.
  // We bypass client.Start() because the sdcp library sends an incomplete payload
  // ({Filename, Startlayer} only). The Centauri Carbon firmware requires additional
  // fields and crashes when they are missing.
  // Source: ElegooSlicer repo — elegoo-link Cmd 128 implementation.
  const onPrinterFilename = path.basename(gcodeFullPath);
  const response = await client.SendCommand({
    Data: {
      Cmd: 128,
      Data: {
        Filename:           onPrinterFilename,
        StartLayer:         0,
        Calibration_switch: 0,
        PrintPlatformType:  1,
        Tlp_Switch:         0,
        slot_map:           [],
      },
      From: 1,
    },
  });

  const ack = response?.Data?.Data?.Ack;
  if (ack !== 0) {
    const ACK_ERRORS = {
      1: 'device busy',
      2: 'file not found on printer',
      3: 'MD5 checksum mismatch',
      4: 'file read failed',
      5: 'file resolution mismatch',
      6: 'unknown file format or model mismatch',
    };
    const reason = ACK_ERRORS[ack] || `unknown Ack code ${ack}`;
    throw new Error(`Start rejected by ${printer.name}: ${reason} (Ack=${ack})`);
  }

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
