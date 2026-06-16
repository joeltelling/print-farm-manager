// Elegoo Centauri Carbon 2 driver — MQTT protocol (port 1883)
//
// Unlike the CC1 (SDCP WebSocket), the CC2 uses MQTT with JSON-RPC-style
// method/params messages. Key differences from CC1:
//
//   - Connects via MQTT on port 1883 (username: "elegoo", password: access code)
//   - Requires a registration handshake before any commands are accepted
//   - Serial number is part of all MQTT topic names (stored in printer.serial_number)
//   - Access code from the printer screen is the MQTT password (stored in printer.api_key)
//   - File upload: the printer pulls the file from an HTTP URL we serve (not pushed over MQTT)
//
// Uses the `mqtt` npm package (already installed for the Bambu driver).
//
// Topic scheme:
//   elegoo/{serial}/api_status                    — unsolicited status pushes from printer
//   elegoo/{serial}/{clientId}/api_response       — responses to commands we send
//   elegoo/{serial}/{clientId}/register_response  — registration handshake response
//   elegoo/{serial}/api_register                  — we publish to register
//   elegoo/{serial}/{clientId}/api_request        — we publish commands here
//   elegoo/{serial}/{clientId}/api_heartbeat      — we publish heartbeats here (every 30s)

const mqtt         = require('mqtt');
const http         = require('http');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const EventEmitter = require('events');

// Map<printerId, ConnectionState>
const connections = new Map();

// Monotonically increasing request ID — matched to pending responses
let _reqId = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Generate a 10-char MQTT client ID: "0cli" + 3 hex timestamp + 3 hex random
function genClientId() {
  const ts   = Date.now().toString(16).slice(-3);
  const rand = Math.floor(Math.random() * 0x1000).toString(16).padStart(3, '0');
  return `0cli${ts}${rand}`;
}

// Return the machine's LAN IPv4 address for constructing the file-download URL.
// Skips loopback and link-local (169.254.x.x). Set SERVER_HOST env var to override.
function getLanIp() {
  if (process.env.SERVER_HOST) return process.env.SERVER_HOST;
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254.')) {
        return info.address;
      }
    }
  }
  return '127.0.0.1';
}

// Map CC2 status to canonical driver status strings.
//
// Confirmed from century-link-ts reverse engineering:
//   machine_status.status  — 1=IDLE, 2=active print (sub_status distinguishes states)
//   machine_status.sub_status:
//     2075 = actively printing    2077 = print completed (FINISHED)
//     2502 = paused               2503 = stopping        2504 = stopped (FINISHED)
//     2505 = paused (variant)
//   print_status.enable    — false when no print job active
function mapPrintStatus(s) {
  const machineStatus = s.machine_status?.status;
  const subStatus     = s.machine_status?.sub_status;
  const psEnable      = s.print_status?.enable;

  if (!psEnable || machineStatus === 1) return 'IDLE';

  if (machineStatus === 2) {
    if (subStatus === 2077 || subStatus === 2503 || subStatus === 2504) return 'FINISHED';
    if (subStatus === 2502 || subStatus === 2505)                        return 'PAUSED';
    return 'PRINTING';
  }

  return 'UNKNOWN';
}

// ─── Connection management ────────────────────────────────────────────────────

function createConnection(printer) {
  const clientId   = genClientId();
  const serial     = printer.serial_number;
  const accessCode = printer.api_key || '123456';

  const emitter = new EventEmitter();
  const conn = {
    client:          null,
    clientId,
    serial,
    pendingRequests: new Map(), // reqId → { resolve, reject, timer }
    registered:      false,
    heartbeat:       null,
    emitter,
    printerName:     printer.name,
  };

  const client = mqtt.connect(`mqtt://${printer.ip}:1883`, {
    clientId,
    username:        'elegoo',
    password:        accessCode,
    connectTimeout:  10_000,
    reconnectPeriod: 5_000,
    clean:           true,
    keepalive:       60,
  });

  conn.client = client;

  // On every (re)connect: re-subscribe and re-register.
  // Registration must happen again after reconnect — the printer doesn't retain
  // client session state across TCP drops.
  client.on('connect', () => {
    console.log(`[elegoo2] ${printer.name} MQTT connected`);
    conn.registered = false;

    const topics = [
      `elegoo/${serial}/api_status`,
      `elegoo/${serial}/${clientId}/api_response`,
      `elegoo/${serial}/${clientId}/register_response`,
    ];

    client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        console.error(`[elegoo2] ${printer.name} subscribe failed: ${err.message}`);
        return;
      }
      client.publish(
        `elegoo/${serial}/api_register`,
        JSON.stringify({ request_id: clientId, client_id: clientId }),
        { qos: 1 }
      );
    });
  });

  client.on('message', (topic, payload) => {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch (_) { return; }

    if (topic === `elegoo/${serial}/${clientId}/register_response`) {
      if (msg.client_id === clientId && msg.error === 'ok') {
        conn.registered = true;
        emitter.emit('registered');
        console.log(`[elegoo2] ${printer.name} registered (clientId=${clientId})`);

        if (conn.heartbeat) clearInterval(conn.heartbeat);
        conn.heartbeat = setInterval(() => {
          if (client.connected) {
            client.publish(
              `elegoo/${serial}/${clientId}/api_heartbeat`,
              JSON.stringify({ id: 0 }),
              { qos: 1 }
            );
          }
        }, 30_000);
      }

    } else if (topic === `elegoo/${serial}/${clientId}/api_response`) {
      const pending = conn.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        conn.pendingRequests.delete(msg.id);
        pending.resolve(msg);
      }

    }
    // api_status pushes are intentionally ignored — we poll with method 1002 on demand
  });

  client.on('disconnect', () => {
    conn.registered = false;
  });

  client.on('error', (err) => {
    if (process.env.DEBUG_ELEGOO2) {
      console.warn(`[elegoo2] ${printer.name} MQTT error: ${err.message}`);
    }
  });

  return conn;
}

// Wait up to timeoutMs for the registration handshake to complete.
function waitRegistered(conn, timeoutMs = 8_000) {
  if (conn.registered) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Registration timeout')), timeoutMs);
    conn.emitter.once('registered', () => { clearTimeout(timer); resolve(); });
  });
}

// Get (or create) a connected, registered MQTT session for this printer.
async function getConn(printer) {
  if (!connections.has(printer.id)) {
    connections.set(printer.id, createConnection(printer));
  }
  const conn = connections.get(printer.id);

  if (!conn.client.connected) {
    // Auto-reconnect is in flight — wait briefly
    await new Promise(r => setTimeout(r, 2_000));
    if (!conn.client.connected) throw new Error(`${printer.name} MQTT not connected`);
  }

  if (!conn.registered) {
    await waitRegistered(conn);
  }

  return conn;
}

function dropConnection(printerId) {
  const conn = connections.get(printerId);
  if (conn) {
    clearInterval(conn.heartbeat);
    try { conn.client.end(true); } catch (_) {}
    connections.delete(printerId);
  }
}

// Send a command and await the matching response.
async function sendCommand(conn, method, params = {}, timeoutMs = 10_000) {
  const id = ++_reqId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for method ${method} response`));
    }, timeoutMs);

    conn.pendingRequests.set(id, { resolve, reject, timer });

    conn.client.publish(
      `elegoo/${conn.serial}/${conn.clientId}/api_request`,
      JSON.stringify({ id, method, params }),
      { qos: 1 },
      (err) => {
        if (err) {
          clearTimeout(timer);
          conn.pendingRequests.delete(id);
          reject(err);
        }
      }
    );
  });
}

// ─── Public driver interface ──────────────────────────────────────────────────

// Returns { status, progress, timeRemaining, currentFile }
async function getStatus(printer) {
  try {
    const conn = await getConn(printer);
    const resp = await sendCommand(conn, 1002, {});
    const s = resp.result ?? {};

    const canonical = mapPrintStatus(s);
    const isActive  = canonical === 'PRINTING' || canonical === 'PAUSED';

    if (canonical === 'UNKNOWN') {
      console.log(`[elegoo2] ${printer.name} unknown status — machine_status.status=${s.machine_status?.status} sub_status=${s.machine_status?.sub_status}, enable=${s.print_status?.enable}`);
    }

    return {
      status:        canonical,
      progress:      isActive ? (s.machine_status?.progress ?? null) : null,
      timeRemaining: isActive ? (s.print_status?.remaining_time_sec ?? null) : null,
      currentFile:   isActive ? (s.print_status?.filename ?? null) : null,
    };
  } catch (_) {
    dropConnection(printer.id);
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }
}

// Upload a G-code file to the CC2 via a single HTTP PUT, then start the print via MQTT.
//
// The CC2 expects the entire file in one PUT to /upload with:
//   Content-Type:   application/octet-stream
//   Content-Length: (full file size)
//   X-File-MD5:     (MD5 of the entire file)
//   X-File-Name:    (destination filename on the printer)
//   X-Token:        (access code, if set)
//
// A 5-minute socket timeout covers large files over LAN.
async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const fileBuffer = fs.readFileSync(gcodeFullPath);
  const totalBytes = fileBuffer.length;
  const md5        = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const accessCode = printer.api_key || '';

  console.log(`[elegoo2] ${printer.name}: uploading "${filename}" (${(totalBytes / 1048576).toFixed(1)} MB) to http://${printer.ip}/upload`);

  const headers = {
    'Content-Type':   'application/octet-stream',
    'Content-Length': String(totalBytes),
    'X-File-MD5':     md5,
    'X-File-Name':    filename,
  };
  if (accessCode) headers['X-Token'] = accessCode;

  await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: printer.ip, port: 80, path: '/upload', method: 'PUT', headers, timeout: 300_000 },
      (res) => {
        res.resume();
        if (res.statusCode >= 400) {
          reject(new Error(`Upload failed: HTTP ${res.statusCode}`));
        } else {
          resolve();
        }
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Upload timed out')); });
    req.write(fileBuffer);
    req.end();
  });

  console.log(`[elegoo2] ${printer.name}: upload complete — starting print`);

  const conn      = await getConn(printer);
  const startResp = await sendCommand(conn, 1020, {
    filename,
    storage_location:  'local',
    auto_bed_leveling: false,
    heated_bed_type:   0,
    enable_time_lapse: false,
    force_bed_level:   false,
    slot_map:          [],
  });

  if (startResp.result?.error_code !== 0) {
    throw new Error(`START_PRINT failed on ${printer.name}: error_code=${startResp.result?.error_code}`);
  }

  console.log(`[elegoo2] Print started on ${printer.name}`);
}

async function cancelJob(printer) {
  try {
    const conn = await getConn(printer);
    await sendCommand(conn, 1022, {}); // STOP_PRINT
    console.log(`[elegoo2] Job cancelled on ${printer.name}`);
  } catch (err) {
    console.warn(`[elegoo2] Cancel failed for ${printer.name}: ${err.message}`);
  }
}

async function checkIfPrinting(printer) {
  try {
    const { status } = await getStatus(printer);
    return status === 'PRINTING' || status === 'PAUSED';
  } catch (_) {
    return false;
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
