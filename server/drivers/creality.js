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
const path = require('path');
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
// Keyed by printer.id, but a cached connection is only reused while its host still
// matches the printer's current `ip` — editing a Creality printer's address (the
// detail/edit form) must not leave polling and reconnect attempts pointed at the
// old address until the server restarts.
function getOrCreateConnection(printer) {
  const host = hostOf(printer);
  const existing = connections.get(printer.id);
  if (existing) {
    if (existing.host === host) return existing;
    teardownConnection(existing);
    connections.delete(printer.id);
  }

  const conn = { host, ws: null, latest: null, connected: false, heartbeat: null, reconnectTimer: null, closed: false, finishReported: false, sawBusy: false };
  connections.set(printer.id, conn);
  connect(printer, conn);
  return conn;
}

// Stops a connection's reconnect loop and closes its socket. Marking it `closed`
// first ensures the socket's own `close` handler doesn't schedule a reconnect for
// what is now a stale, discarded connection object.
function teardownConnection(conn) {
  conn.closed = true;
  clearInterval(conn.heartbeat);
  clearTimeout(conn.reconnectTimer);
  if (conn.ws) {
    try { conn.ws.removeAllListeners(); conn.ws.close(); } catch (_) {}
  }
}

// Closes and forgets a printer's cached connection. Called from the printer lifecycle
// routes when a printer is deleted, decommissioned, or moved to another connector type,
// so its socket, heartbeat, and reconnect loop do not outlive the printer they served.
function disposeConnection(printerId) {
  const conn = connections.get(printerId);
  if (!conn) return;
  teardownConnection(conn);
  connections.delete(printerId);
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
    // The busy observation dies with the socket: after a reconnect, a latched terminal
    // `state` is the previous print's outcome, not a fresh event (see mapStatus).
    conn.sawBusy = false;
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
// Field semantics, confirmed by capturing a full print lifecycle on real K1 firmware:
//   deviceState — the LIVE device status: 0 = idle, non-zero = busy (printing, heating,
//                 leveling, self-test). This is the reliable "is it running" signal.
//   state       — a print phase / last-outcome code, NOT the live status. It reads 0 or 1
//                 while a print runs, then LATCHES at 2 (completed) or 4 (stopped) and
//                 stays there while the device sits idle, until the next print. 5 = paused.
//   printProgress / printFileName / printJobTime — LAST-PRINT RESIDUALS: the K1 leaves them
//                 populated (progress=100, filename set) after a print ends. Never infer
//                 completion from them, or the driver latches FINISHED forever.
//   printId     — observed empty ("") even mid-print on this firmware; not a usable signal.
//
// Because `state` latches its terminal outcome while idle, reporting FINISHED/STOPPED
// straight from it would never return the printer to IDLE. Instead we emit the terminal
// outcome exactly ONCE, on the busy→idle edge, then report IDLE — crediting fires on the
// single transition (poller reacts to transitions) and the printer returns to service.
// `conn.finishReported` carries that one-shot latch and is reset whenever the device is
// busy again (a new or continuing print).
//
// A terminal outcome is also only trusted when THIS connection watched the print run:
// `conn.sawBusy` records that a busy deviceState (or a pause) was observed since the
// socket (re)connected, and is cleared when the socket closes. Without it, the first
// idle snapshot after a (re)connect would replay the previous print's latched 2/4 as a
// fresh FINISHED/STOPPED, and the scheduler would credit a job this driver never saw
// print. With no observed busy state the driver reports IDLE and leaves the missed-
// finish case to the poller's PRINTING-to-IDLE hold, which asks the operator instead
// of inferring.
function mapStatus(s, conn, printerName) {
  if (!s) return 'UNKNOWN';

  const state  = num(s.state);
  const device = num(s.deviceState);
  const errcode = (s.err && typeof s.err === 'object') ? num(s.err.errcode) : 0;

  // Paused is reported by `state` regardless of deviceState. A pause also proves a
  // print is in flight on this connection's watch, so its eventual terminal outcome
  // is genuine (covers connecting while paused, then the operator stopping the print).
  if (state === 5) { conn.sawBusy = true; return 'PAUSED'; }

  // Busy: actively printing / heating / leveling / self-testing.
  // Checked BEFORE the errcode so a non-fatal hardware warning (e.g. mainboard fan)
  // during a running print does not override PRINTING. The error code is logged
  // for diagnostics; the scheduler only sees ERROR when the printer is idle.
  if (device != null && device !== 0) {
    if (errcode) console.warn(`[creality] ${printerName} non-fatal error code ${errcode} while busy — staying PRINTING`);
    conn.finishReported = false;
    conn.sawBusy = true;
    return 'PRINTING';
  }

  // deviceState hasn't arrived in the cache yet — e.g. the first frame after (re)connect
  // carries only a latched `state` (2/4) before a later frame merges deviceState in, or a
  // stray partial frame merged in before either field was ever populated. Do not infer idle
  // from its mere absence: a busy printer whose deviceState frame just hasn't landed yet
  // would otherwise be reported FINISHED/STOPPED (and credited) while still mid-print, and
  // an unrecognized frame would clear a hold and offer the printer up for dispatch. Report
  // UNKNOWN so the printer is held until deviceState is confirmed one way or the other.
  if (device == null) return 'UNKNOWN';

  // From here, deviceState === 0 is confirmed idle.
  // Device is idle. If an error code is present, it stopped the print — report ERROR.
  if (errcode) return 'ERROR';

  // Device is idle. Surface the just-ended print's outcome once, then IDLE, but only
  // if this connection actually observed the print run (sawBusy): a latched terminal
  // `state` seen by a fresh connection is the LAST print's outcome, not a new event.
  if (conn.sawBusy && !conn.finishReported) {
    if (state === 2) { conn.finishReported = true; return 'FINISHED'; }
    if (state === 4) { conn.finishReported = true; return 'STOPPED'; }
  }
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
    const status = mapStatus(s, conn, printer.name);

    if (process.env.DEBUG_CREALITY) {
      console.log(`[creality] ${printer.name} raw: state=${s.state} deviceState=${s.deviceState} ` +
        `printId="${s.printId ?? ''}" progress=${s.printProgress} leftTime=${s.printLeftTime} ` +
        `selfTest=${s.withSelfTest} errcode=${s.err?.errcode} → ${status}`);
    }

    const active = status === 'PRINTING' || status === 'PAUSED';
    const progress = active ? num(s.printProgress ?? s.dProgress) : null;
    const timeRemaining = active ? num(s.printLeftTime) : null;

    // printFileName is reported as a full on-printer path on the K-series
    // (e.g. "/usr/data/printer_data/gcodes/benchy.gcode") and may carry the
    // multer-prepended timestamp prefix — reduce to a clean display name.
    const rawFile = active ? (s.printFileName || null) : null;
    const currentFile = rawFile ? path.basename(rawFile).replace(/^\d+_/, '') : null;

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

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, disposeConnection };
