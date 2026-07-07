// Elegoo Centauri Carbon 2 driver — MQTT protocol (port 1883)
//
// Unlike the CC1 (SDCP WebSocket), the CC2 uses MQTT with JSON-RPC-style
// method/params messages. Key differences from CC1:
//
//   - Connects via MQTT on port 1883 (username: "elegoo", password: access code)
//   - Requires a registration handshake before any commands are accepted
//   - Serial number is part of all MQTT topic names (stored in printer.serial_number)
//   - Access code from the printer screen is the MQTT password (stored in printer.api_key)
//   - File upload: chunked HTTP PUT to the printer's /upload endpoint (not pushed over MQTT)
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

// Upload a G-code file to the CC2 via chunked HTTP PUT, then start the print via MQTT.
//
// Protocol confirmed from elegoo-link C++ source (ElegooFdmCC2HttpTransfer):
//   - 1 MB chunks, each a separate PUT to /upload with Content-Range header
//   - ALL chunks share ONE keep-alive TCP connection (critical — separate connections → 408)
//   - Each response is JSON { error_code: 0 } on success, non-zero on failure
//   - X-Token = access code (printer.api_key)
async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const fileBuffer = fs.readFileSync(gcodeFullPath);
  const totalBytes = fileBuffer.length;
  const md5        = crypto.createHash('md5').update(fileBuffer).digest('hex');
  const accessCode = printer.api_key || '';
  const CHUNK_SIZE = 1024 * 1024; // 1 MB — official Elegoo max chunk size

  console.log(`[elegoo2] ${printer.name}: uploading "${filename}" (${(totalBytes / 1048576).toFixed(1)} MB) via chunked PUT to http://${printer.ip}/upload`);

  // Keep-alive agent: all chunk requests reuse the same TCP connection.
  // The CC2's embedded HTTP server requires this — it times out (408) on new connections mid-transfer.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  try {
    for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
      const end   = Math.min(offset + CHUNK_SIZE, totalBytes) - 1;
      const chunk = fileBuffer.slice(offset, end + 1);

      const headers = {
        'Content-Type':   'application/octet-stream',
        'Content-Length': String(chunk.length),
        'Content-Range':  `bytes ${offset}-${end}/${totalBytes}`,
        'X-File-Name':    filename,
        'X-File-MD5':     md5,
      };
      if (accessCode) headers['X-Token'] = accessCode;

      const body = await new Promise((resolve, reject) => {
        let settled = false;
        const done = (err, data) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          err ? reject(err) : resolve(data);
        };
        const deadline = setTimeout(() => {
          req.destroy();
          done(new Error('Upload chunk timed out after 3 minutes'));
        }, 180_000);

        const req = http.request(
          { hostname: printer.ip, port: 80, path: '/upload', method: 'PUT', headers, agent },
          (res) => {
            const parts = [];
            res.on('data', d => parts.push(d));
            res.on('end', () => {
              const text = Buffer.concat(parts).toString();
              res.statusCode >= 400
                ? done(new Error(`HTTP ${res.statusCode}: ${text}`))
                : done(null, text);
            });
            res.on('error', done);
          }
        );
        req.on('error', done);
        req.write(chunk);
        req.end();
      });

      // Validate JSON response: printer returns { error_code: 0 } on success
      try {
        const parsed = JSON.parse(body);
        if (parsed.error_code !== 0) {
          throw new Error(`Chunk at offset ${offset} rejected: error_code=${parsed.error_code}`);
        }
      } catch (e) {
        if (e.message.includes('error_code')) throw e;
        // Non-JSON but HTTP 2xx — log and continue
        if (body) console.warn(`[elegoo2] ${printer.name}: non-JSON chunk response: ${body}`);
      }

      const pct = Math.round((end + 1) / totalBytes * 100);
      if (pct % 25 === 0 || end + 1 === totalBytes) {
        console.log(`[elegoo2] ${printer.name}: upload ${pct}% (${((end + 1) / 1048576).toFixed(0)} MB / ${(totalBytes / 1048576).toFixed(1)} MB)`);
      }

      if (end + 1 < totalBytes) await new Promise(r => setTimeout(r, 1));
    }
  } finally {
    agent.destroy();
  }

  console.log(`[elegoo2] ${printer.name}: upload complete — starting print`);

  const conn      = await getConn(printer);
  const startResp = await sendCommand(conn, 1020, {
    storage_media: 'local',
    filename,
    config: {
      delay_video:    false, // time-lapse
      printer_check:  false, // auto bed leveling
      print_layout:   'A',   // heated bed type: A = standard, B = alternate
      bedlevel_force: false,
      slot_map:       [],
    },
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

// Tear down every live MQTT connection — called on graceful shutdown.
function closeAll() {
  for (const id of [...connections.keys()]) dropConnection(id);
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, dropConnection, closeAll };
