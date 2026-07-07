// Creality driver — Creality local API (WebSocket status/control + HTTP file upload)
// Connector family: Creality (K1 / K1C / K1 Max / K2 / Ender-3 V3 / Hi series)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// This is the API used by Creality Print / OrcaSlicer's "Creality Print" host — the
// same one the printer's own touchscreen and the Creality app speak on the LAN.
//
// Connection model (like bambu.js, not prusa.js):
//   The printer pushes telemetry over a persistent WebSocket on port 9999 as a stream
//   of *partial* JSON objects (each frame carries only the fields that changed). We hold
//   one socket per printer in a module-level Map, merge every frame into a cached "latest"
//   object, and answer getStatus() from that cache instantly. OFFLINE is returned until the
//   first frame arrives after (re)connect — an open socket with no data yet is not a
//   reachable printer, and reporting stale pre-disconnect state is how false FINISHED
//   transitions happen (see docs/driver-authoring.md).
//
// Upload is a separate transport: HTTP multipart POST to /upload/<name>, then the print is
// triggered over the WebSocket with an opGcodeFile "set" command pointing at the uploaded
// file's on-printer path.
//
// Protocol references (reverse-engineered — no official spec):
//   OrcaSlicer src/slic3r/Utils/CrealityPrint.cpp  (upload endpoint + opGcodeFile trigger)
//   OrcaSlicer issue #2103                          (upload/print flow, curl example)
//   github.com/3dg1luk43/ha_creality_ws             (state codes, telemetry field names)

const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const WS_PORT = 9999;

// On-printer directory where uploaded G-code lands (Klipper-based Creality firmware).
// The opGcodeFile trigger references files by this absolute path with a "printprt:" scheme.
const REMOTE_GCODE_DIR = '/usr/data/printer_data/gcodes';

// Map of printer.id → { ws, latest, connected, heartbeat, reconnectTimer, closed }
const connections = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Bare host (strip any protocol prefix / trailing slash the operator may have pasted).
function hostOf(printer) {
  return printer.ip.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// Coerce a value that may arrive as a number or numeric string to a Number, else null.
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

// ─── Connection management ────────────────────────────────────────────────────

// Returns (or lazily creates) the connection object for a printer. The socket is
// established in the background — callers check conn.connected / conn.latest.
function getOrCreateConnection(printer) {
  if (connections.has(printer.id)) return connections.get(printer.id);

  const conn = { ws: null, latest: null, connected: false, heartbeat: null, reconnectTimer: null, closed: false };
  connections.set(printer.id, conn);
  connect(printer, conn);
  return conn;
}

function connect(printer, conn) {
  const url = `ws://${hostOf(printer)}:${WS_PORT}/`;
  let ws;
  try {
    ws = new WebSocket(url, { handshakeTimeout: 8000 });
  } catch (_) {
    scheduleReconnect(printer, conn);
    return;
  }
  conn.ws = ws;

  ws.on('open', () => {
    conn.connected = true;
    // Prime the cache immediately and keep the socket warm — the printer streams
    // telemetry, and re-requesting the print objects doubles as a keepalive.
    safeSend(ws, { method: 'get', params: { reqPrintObjects: 1 } });
    clearInterval(conn.heartbeat);
    conn.heartbeat = setInterval(() => safeSend(ws, { method: 'get', params: { reqPrintObjects: 1 } }), 10000);
    console.log(`[creality] Connected to ${printer.name} (${hostOf(printer)})`);
  });

  ws.on('message', (buf) => {
    try {
      const data = JSON.parse(buf.toString());
      if (data && typeof data === 'object') {
        // Telemetry keys arrive at the top level; some frames nest them under `params`.
        // Merge both — Creality sends partial updates, not a full snapshot each frame.
        conn.latest = { ...(conn.latest || {}), ...data };
        if (data.params && typeof data.params === 'object') {
          conn.latest = { ...conn.latest, ...data.params };
        }
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    conn.connected = false;
    clearInterval(conn.heartbeat);
    // Drop cached state so a reconnect reports OFFLINE until fresh telemetry arrives,
    // rather than replaying stale pre-disconnect state (avoids false FINISHED flaps).
    conn.latest = null;
    if (!conn.closed) scheduleReconnect(printer, conn);
  });

  ws.on('error', (err) => {
    if (process.env.DEBUG_CREALITY) console.warn(`[creality] ${printer.name} error:`, err?.message || err);
  });
}

function scheduleReconnect(printer, conn) {
  if (conn.closed || conn.reconnectTimer) return;
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null;
    if (!conn.closed) connect(printer, conn);
  }, 5000);
}

// Wait until the socket is connected with fresh telemetry, up to timeoutMs.
async function waitForData(conn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conn.connected && conn.latest) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return conn.connected && !!conn.latest;
}

// ─── Canonical state mapping ──────────────────────────────────────────────────

// Maps the printer's cached telemetry to a canonical status string.
//
// Native `state` codes (github.com/3dg1luk43/ha_creality_ws):
//   0 = standby / processing (idle when no file loaded; heating/preparing when one is)
//   1 = printing
//   4 = stopped (user pressed Stop on the printer)
//   5 = paused
// Other signals: err.errcode (nonzero = fault), withSelfTest (1–99 = self-test/calibration),
// printProgress (percent), printFileName (loaded file).
//
// Creality has no dedicated "just finished" state — after a successful print the machine
// returns to state 0 while leaving printFileName loaded and printProgress at 100. We
// synthesize FINISHED from that (the OctoPrint-style pattern): the condition stays true
// until the next print starts (which resets progress and filename), so poller.js reacts to
// it exactly once. state 4 (Stop) maps to STOPPED, distinct from a firmware fault (ERROR).
function mapStatus(s) {
  if (!s) return 'UNKNOWN';

  const errcode = (s.err && typeof s.err === 'object') ? num(s.err.errcode) : 0;
  const state = num(s.state);
  const selfTest = num(s.withSelfTest) || 0;
  const progress = num(s.printProgress ?? s.dProgress);
  const hasFile = !!s.printFileName;

  if (errcode) return 'ERROR';
  if (state === 5) return 'PAUSED';
  if (state === 4) return 'STOPPED';                       // Stop pressed at the printer
  if (hasFile && progress != null && progress >= 100 && state !== 1) return 'FINISHED';
  if (selfTest >= 1 && selfTest <= 99) return 'PRINTING';  // self-test / calibration — occupied
  if (state === 1) return 'PRINTING';
  if (hasFile) return 'PRINTING';                          // state 0 + file loaded → heating/preparing
  return 'IDLE';
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Returns { status, progress, timeRemaining, currentFile }.
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | STOPPED | ERROR | OFFLINE | UNKNOWN
async function getStatus(printer) {
  try {
    const conn = getOrCreateConnection(printer);

    if (!conn.connected || !conn.latest) {
      // Not connected yet or no telemetry since (re)connect — background reconnect is running.
      return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
    }

    const s = conn.latest;
    const status = mapStatus(s);

    if (status === 'UNKNOWN' && process.env.DEBUG_CREALITY) {
      console.log(`[creality] ${printer.name} unmapped telemetry: ${JSON.stringify(s)}`);
    }

    const active = status === 'PRINTING' || status === 'PAUSED';
    const progress = active ? num(s.printProgress ?? s.dProgress) : null;
    const timeRemaining = active ? num(s.printLeftTime) : null;

    // Strip the multer-prepended timestamp prefix (e.g. "1712345678901_benchy.gcode").
    const rawFile = active ? (s.printFileName || null) : null;
    const currentFile = rawFile ? rawFile.replace(/^\d+_/, '') : null;

    return { status, progress, timeRemaining, currentFile };
  } catch (_) {
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }
}

// ─── Upload & Print ───────────────────────────────────────────────────────────

// Uploads the G-code over HTTP, then triggers the print over the WebSocket and waits
// until the printer confirms it started. gcodeFullPath is a resolved absolute path.
async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const host = hostOf(printer);

  // ── HTTP multipart upload ────────────────────────────────────────────────
  // Multipart (field "file") — a raw body POST makes some firmware prepend the HTTP
  // headers into the saved G-code (OrcaSlicer issue #8128), which then errors on print.
  const form = new FormData();
  form.append('file', fs.createReadStream(gcodeFullPath), { filename });

  const headers = form.getHeaders();
  // The K1 LAN API is unauthenticated by default; send a Bearer token only if configured
  // (some Creality Print / Nebula setups require one).
  if (printer.api_key) headers['Authorization'] = `Bearer ${printer.api_key}`;

  console.log(`[creality] Uploading ${filename} to ${printer.name}…`);
  try {
    await axios.post(
      `http://${host}/upload/${encodeURIComponent(filename)}`,
      form,
      { headers, timeout: 300000, maxContentLength: Infinity, maxBodyLength: Infinity } // 5 min for large files
    );
  } catch (err) {
    if (err.response?.status === 409) {
      throw Object.assign(
        new Error(`409 Conflict on upload — transfer likely already in progress on ${printer.name}`),
        { code: 'UPLOAD_CONFLICT' }
      );
    }
    throw err;
  }
  console.log(`[creality] Upload complete on ${printer.name} — triggering print`);

  // ── WebSocket print trigger ──────────────────────────────────────────────
  const conn = getOrCreateConnection(printer);
  if (!await waitForData(conn, 10000)) {
    throw new Error(`Creality ${printer.name} WebSocket not connected — cannot trigger print`);
  }

  safeSend(conn.ws, {
    method: 'set',
    params: { opGcodeFile: `printprt:${REMOTE_GCODE_DIR}/${filename}` },
  });

  // Resolve only once the printer confirms it started — the scheduler marks the job
  // 'printing' the moment this resolves. Poll the cached telemetry (nudging a refresh each
  // tick) for up to 20s. If it never confirms, throw so the scheduler retries; a print that
  // actually started despite a missed confirmation is recovered via checkIfPrinting().
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    safeSend(conn.ws, { method: 'get', params: { reqPrintObjects: 1 } });
    await new Promise(r => setTimeout(r, 1000));
    const { status } = await getStatus(printer);
    if (status === 'PRINTING' || status === 'PAUSED') {
      console.log(`[creality] Print started on ${printer.name}`);
      return;
    }
  }
  throw new Error(`Creality ${printer.name} did not report printing within 20s of the print command`);
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  try {
    const conn = getOrCreateConnection(printer);
    if (!await waitForData(conn, 8000)) {
      console.warn(`[creality] ${printer.name} not connected — cannot cancel`);
      return;
    }
    safeSend(conn.ws, { method: 'set', params: { stop: 1 } });
    console.log(`[creality] Job cancelled on ${printer.name}`);
  } catch (err) {
    console.warn(`[creality] Cancel failed for ${printer.name}: ${err.message}`);
  }
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
async function checkIfPrinting(printer) {
  try {
    const { status } = await getStatus(printer);
    return status === 'PRINTING' || status === 'PAUSED';
  } catch (_) {
    return false;
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
