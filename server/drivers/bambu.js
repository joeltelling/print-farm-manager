// Bambu Lab printer driver — MQTT over TLS + FTPS
// Connector family: Bambu MQTT
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Prerequisites on the printer (both required):
//   Settings → Network → LAN Only Mode: ON
//   Settings → Network → Developer Mode: ON  ← appears after LAN Mode is on
//   Developer Mode eliminates the X.509 certificate signing requirement for commands.
//
// Credentials stored in DB:
//   printer.ip            — local IP address
//   printer.api_key       — access code (shown on printer screen under WiFi settings)
//   printer.serial_number — device serial number (used as MQTT topic path)
//
// Connection model (differs from Prusa/Elegoo):
//   Bambu pushes status to device/{serial}/report continuously — there is no
//   request/response polling. We subscribe once and cache the latest payload.
//   getStatus() returns from cache instantly. OFFLINE is returned until the
//   first status message arrives after connect.
//
// Bambu sends partial status updates, not full state each time.
// We merge each incoming update into conn.latestPrint so no fields are lost.
//
// Protocol reference: https://github.com/Doridian/OpenBambuAPI

const mqtt     = require('mqtt');
const ftp      = require('basic-ftp');
const path     = require('path');

// Map of printer.id → { client, latestPrint, connected }
const connections = new Map();

// ─── Connection management ────────────────────────────────────────────────────

// Returns (or creates) the connection object for a printer.
// The MQTT connection is established in the background — callers should
// check conn.connected before sending commands.
function getOrCreateConnection(printer) {
  if (connections.has(printer.id)) {
    return connections.get(printer.id);
  }

  const serial = printer.serial_number;
  const conn   = { client: null, latestPrint: null, connected: false };
  connections.set(printer.id, conn);

  const client = mqtt.connect(`mqtts://${printer.ip}:8883`, {
    username:          'bblp',
    password:          printer.api_key, // access code from printer WiFi settings
    rejectUnauthorized: false,          // Bambu uses a self-signed TLS certificate — intentional
    reconnectPeriod:   5000,
    connectTimeout:    10000,
  });

  conn.client = client;

  client.on('connect', () => {
    conn.connected = true;

    // Subscribe to the printer's status push topic
    client.subscribe(`device/${serial}/report`, (err) => {
      if (err) console.warn(`[bambu] ${printer.name} subscribe error:`, err.message);
    });

    // Request an immediate full status dump so the cache is populated right away
    // rather than waiting for the next natural push interval.
    client.publish(`device/${serial}/request`, JSON.stringify({
      pushing: { sequence_id: '0', command: 'pushall', push_target: 1 },
    }));

    console.log(`[bambu] Connected to ${printer.name} (${printer.ip})`);
  });

  client.on('message', (_topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      // All status fields arrive under data.print.
      // Merge — Bambu sends partial updates, not a full snapshot each time.
      if (data.print) {
        conn.latestPrint = { ...conn.latestPrint, ...data.print };
      }
    } catch (_) {}
  });

  client.on('reconnect', () => {
    conn.connected = false;
    console.log(`[bambu] ${printer.name} reconnecting…`);
  });

  client.on('offline', () => {
    conn.connected = false;
  });

  client.on('error', (err) => {
    conn.connected = false;
    if (process.env.DEBUG_BAMBU) {
      console.warn(`[bambu] ${printer.name} error:`, err?.message || err);
    }
  });

  return conn;
}

function dropConnection(printerId) {
  const conn = connections.get(printerId);
  if (conn) {
    try { conn.client?.end(true); } catch (_) {}
    connections.delete(printerId);
  }
}

// ─── Canonical state mapping ──────────────────────────────────────────────────

// Maps Bambu gcode_state strings to canonical status strings.
// Source: OpenBambuAPI — https://github.com/Doridian/OpenBambuAPI
//
// RUNNING  = Active print in progress
// PREPARE  = Bed leveling, heating, homing before first layer — treat as PRINTING
// IDLE     = Standby, no print loaded
// PAUSE    = Print paused by operator or firmware event
// FINISH   = Print complete — triggers operator confirmation in farm UI
// FAILED   = Print did not complete — covers BOTH firmware-detected failures and
//            user-cancelled prints. See the print_error disambiguation in getStatus.
function mapStatus(gcodeState) {
  switch (gcodeState) {
    case 'RUNNING':  return 'PRINTING';
    case 'PREPARE':  return 'PRINTING'; // calibration/homing before layers begin
    case 'IDLE':     return 'IDLE';
    case 'PAUSE':    return 'PAUSED';
    case 'FINISH':   return 'FINISHED';
    case 'FAILED':   return 'ERROR';
    default:         return 'UNKNOWN';
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Bambu reports a user-cancelled print (Stop pressed on the printer screen) as
// gcode_state FAILED — the same state as a genuine print failure — and keeps
// reporting FAILED until the next print starts or the printer power-cycles.
// The two cases are distinguished by print_error:
//   50348044 (0x0300400C) — print cancelled by the user; sent for a few seconds
//                           after the stop, then print_error resets to 0 while
//                           gcode_state stays FAILED
//   any other nonzero     — genuine firmware-detected failure
//   0                     — no active error; FAILED with no error code is a
//                           settled user cancel
// Ref: ha-bambulab pybambu/models.py (isCanceledPrint handling)
const BAMBU_USER_CANCELLED = 50348044;

// Returns { status, progress, timeRemaining, currentFile }
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | STOPPED | ERROR | OFFLINE | UNKNOWN
// progress (0–100), timeRemaining (seconds), and currentFile are null when not printing.
async function getStatus(printer) {
  if (!printer.serial_number) {
    // Misconfigured — serial number required for MQTT topics
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }

  const conn = getOrCreateConnection(printer);

  if (!conn.connected || !conn.latestPrint) {
    // Not yet connected or no status received — report OFFLINE, connection is
    // retrying in the background via reconnectPeriod.
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }

  const print = conn.latestPrint;
  let status  = mapStatus(print.gcode_state);

  // User-cancelled prints report FAILED — remap to STOPPED so the scheduler
  // cancels the job (rather than failing it) and the UI doesn't show a false
  // error. Real failures carry a persistent nonzero print_error.
  if (status === 'ERROR') {
    const printError = print.print_error ?? 0;
    if (printError === 0 || printError === BAMBU_USER_CANCELLED) {
      status = 'STOPPED';
    }
  }

  const progress = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.mc_percent ?? null)
    : null;

  // Bambu reports mc_remaining_time in minutes — convert to seconds for UI consistency.
  const timeRemaining = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.mc_remaining_time != null ? print.mc_remaining_time * 60 : null)
    : null;

  // subtask_name is the file or project currently printing.
  // Strip the multer-prepended timestamp prefix (e.g. "1712345678901_benchy.gcode").
  const rawFilename = (status === 'PRINTING' || status === 'PAUSED')
    ? (print.subtask_name ?? null)
    : null;
  const currentFile = rawFilename ? rawFilename.replace(/^\d+_/, '') : null;

  return { status, progress, timeRemaining, currentFile };
}

// ─── Upload & Print ───────────────────────────────────────────────────────────

// Returns the current AMS slot list from the cached MQTT state, or null if not connected.
// Each slot: { slot, type, color }
//   slot  — compound id: (ams_unit * 4) + tray_id, or -1 for external spool
//   type  — filament type string e.g. 'PLA', or '' if unknown
//   color — RRGGBBAA hex string, or null
// Empty trays (no tray_type field) are omitted. External spool is always included.
function getAmsSlots(printer) {
  const conn = connections.get(printer.id);
  if (!conn?.latestPrint) return null;

  const slots = [];

  const amsUnits = conn.latestPrint.ams?.ams || [];
  for (const unit of amsUnits) {
    const amsId = parseInt(unit.id, 10);
    for (const tray of unit.tray || []) {
      if (!tray.tray_type) continue; // empty slot — no filament loaded
      slots.push({
        slot:  amsId * 4 + parseInt(tray.id, 10),
        type:  tray.tray_type,
        color: tray.tray_color || null,
      });
    }
  }

  // External spool is always an option regardless of whether filament is loaded
  const vt = conn.latestPrint.vt_tray;
  slots.push({
    slot:  -1,
    type:  vt?.tray_type || '',
    color: vt?.tray_color || null,
  });

  return slots;
}

// Uploads the G-code file to the printer via FTPS, then triggers printing via MQTT.
// gcodeFullPath must be a resolved absolute path that already exists on disk.
// options.amsSlot: -1 = external spool, 0–N = AMS slot, null = default (external)
async function uploadAndPrint(printer, gcodeFullPath, _filename, options = {}) {
  const { amsSlot = null } = options;
  if (!printer.serial_number) {
    throw new Error(`Bambu printer ${printer.name} has no serial number configured`);
  }

  const onPrinterFilename = path.basename(gcodeFullPath);
  const ext = path.extname(onPrinterFilename).toLowerCase();

  // Bambu printers only support .3mf files via the project_file MQTT command.
  // The gcode_file command is non-functional on A-series (A1, A2, A2L) and
  // wrapping a plain gcode in a minimal .3mf does not satisfy firmware validation.
  // Operators must export .3mf from Bambu Studio or Orca Slicer.
  if (ext !== '.3mf') {
    throw new Error(
      `Bambu printer ${printer.name} requires a .3mf file. ` +
      `Export from Bambu Studio or Orca Slicer instead of uploading a plain .gcode.`
    );
  }

  // ── FTPS upload ──────────────────────────────────────────────────────────
  // .3mf files go to the SD card root.
  console.log(`[bambu] Uploading ${onPrinterFilename} to ${printer.name} via FTPS…`);

  const ftpClient = new ftp.Client();
  ftpClient.ftp.verbose = !!process.env.DEBUG_BAMBU;

  try {
    await ftpClient.access({
      host:    printer.ip,
      port:    990,
      user:    'bblp',
      password: printer.api_key,
      secure:  'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    await ftpClient.uploadFrom(gcodeFullPath, onPrinterFilename);
    console.log(`[bambu] Upload complete on ${printer.name}`);
  } finally {
    ftpClient.close();
  }

  // ── MQTT print trigger ───────────────────────────────────────────────────
  const conn = getOrCreateConnection(printer);

  if (!conn.connected) {
    throw new Error(`Bambu printer ${printer.name} MQTT not connected — cannot trigger print`);
  }

  // ams_mapping format for LAN printing: a flat array where index = filament slot
  // in the .3mf (0-based) and value = physical AMS tray ID (0-15).
  // For single-color prints: [amsSlot] (one element).
  // For external spool or no AMS: [] (empty).
  // Ref: https://github.com/Doridian/OpenBambuAPI (issue #38 + mqtt.md)
  const subtaskName = path.basename(onPrinterFilename, '.3mf');
  const useAms      = amsSlot != null && amsSlot >= 0;
  const printPayload = {
    sequence_id:     '0',
    command:         'project_file',
    param:           'Metadata/plate_1.gcode',
    subtask_name:    subtaskName,
    url:             `ftp:///${onPrinterFilename}`,
    bed_type:        'auto',
    timelapse:       false,
    bed_leveling:    true,
    flow_cali:       false,
    vibration_cali:  true,
    layer_inspect:   false,
    use_ams:         useAms,
    ams_mapping:     useAms ? [amsSlot] : [],
    profile_id:      '0',
    project_id:      '0',
    subtask_id:      '0',
    task_id:         '0',
  };

  const mqttPayload = JSON.stringify({ print: printPayload });
  console.log(`[bambu] MQTT payload → ${printer.name}: ${mqttPayload}`);
  conn.client.publish(`device/${printer.serial_number}/request`, mqttPayload, (err) => {
    if (err) console.error(`[bambu] MQTT publish failed for ${printer.name}:`, err.message);
    else console.log(`[bambu] MQTT publish confirmed for ${printer.name}`);
  });
}

// ─── File cleanup ─────────────────────────────────────────────────────────────

// Deletes a file from the printer's SD card via FTPS.
// Called by the scheduler after a job finishes to prevent accumulation of files.
async function deleteFile(printer, filename) {
  if (!filename) return;

  // All Bambu uploads are .3mf files at the SD card root.
  const remotePath = filename;

  const ftpClient = new ftp.Client();
  ftpClient.ftp.verbose = !!process.env.DEBUG_BAMBU;

  try {
    await ftpClient.access({
      host:    printer.ip,
      port:    990,
      user:    'bblp',
      password: printer.api_key,
      secure:  'implicit',
      secureOptions: { rejectUnauthorized: false },
    });

    await ftpClient.remove(remotePath);
    console.log(`[bambu] Deleted ${remotePath} from ${printer.name}`);
  } catch (err) {
    // Non-fatal — file may have already been deleted or never uploaded
    console.warn(`[bambu] Could not delete ${filename} from ${printer.name}: ${err.message}`);
  } finally {
    ftpClient.close();
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  if (!printer.serial_number) return;

  const conn = connections.get(printer.id);
  if (!conn?.connected) {
    console.warn(`[bambu] ${printer.name} not connected — cannot cancel`);
    return;
  }

  conn.client.publish(`device/${printer.serial_number}/request`, JSON.stringify({
    print: { sequence_id: '0', command: 'stop' },
  }));

  console.log(`[bambu] Job cancelled on ${printer.name}`);
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
async function checkIfPrinting(printer) {
  const { status } = await getStatus(printer);
  return status === 'PRINTING' || status === 'PAUSED';
}

// Tear down every live MQTT connection — called on graceful shutdown so the
// process exits cleanly instead of being held open by reconnect timers.
function closeAll() {
  for (const id of [...connections.keys()]) dropConnection(id);
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, getAmsSlots, deleteFile, dropConnection, closeAll };
