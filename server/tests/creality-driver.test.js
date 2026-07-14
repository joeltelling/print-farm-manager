// Unit tests for server/drivers/creality.js
// The WebSocket (`ws`) and HTTP (`axios`) layers are mocked - no real printers needed.
//
// Field semantics (confirmed against real K1 firmware telemetry):
//   deviceState - live status: 0 = idle, non-zero = busy (printing/heating/self-test)
//   state       - print phase / last-outcome latch: 2 = completed, 4 = stopped, 5 = paused
//                 (NOT the live status; it latches 2/4 while the device sits idle)
//   printProgress / printFileName - last-print residuals; never used to infer completion

jest.mock('ws', () => {
  const EventEmitter = require('events');
  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; this.emit('close'); }
  }
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.instances = [];
  return FakeWebSocket;
});
jest.mock('axios');

const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const creality = require('../drivers/creality');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const filesToClean = [];

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});
afterAll(() => {
  for (const p of filesToClean) { try { fs.unlinkSync(p); } catch (_) {} }
});

// Fake timers keep the driver's heartbeat interval / reconnect timer from lingering
// (they never need to fire for these tests) so Jest exits cleanly.
beforeEach(() => {
  jest.useFakeTimers();
  WebSocket.instances.length = 0;
  jest.clearAllMocks();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

let nextId = 1;
function makePrinter(extra = {}) {
  return { id: nextId++, name: 'K1_01', ip: '192.168.1.77', model: 'k1', type: 'creality', api_key: '', ...extra };
}

// Create the connection, mark the socket open, and push one telemetry frame,
// then return the socket so further frames can be pushed with ws.emit('message', …).
async function drive(printer, telemetry) {
  await creality.getStatus(printer); // creates the connection + fake socket (returns OFFLINE)
  const ws = WebSocket.instances[WebSocket.instances.length - 1];
  ws.readyState = WebSocket.OPEN;
  ws.emit('open');
  if (telemetry) ws.emit('message', Buffer.from(JSON.stringify(telemetry)));
  return ws;
}

function createTestFile(filename) {
  const filePath = path.join(GCODE_DIR, filename);
  fs.writeFileSync(filePath, '; fake gcode');
  filesToClean.push(filePath);
  return filePath;
}

// ─── getStatus: state mapping ───────────────────────────────────────────────────

describe('getStatus state mapping', () => {
  test('OFFLINE before any telemetry has arrived', async () => {
    const printer = makePrinter();
    const result = await creality.getStatus(printer);
    expect(result).toEqual({ status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null });
  });

  test('IDLE when deviceState 0 and no terminal outcome', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 0, state: 0 });
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  test('PRINTING when deviceState is busy, with progress/time/file', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 1, state: 0, printProgress: 42, printLeftTime: 600, printFileName: '1712345678901_benchy.gcode' });
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('PRINTING');
    expect(r.progress).toBe(42);
    expect(r.timeRemaining).toBe(600);
    expect(r.currentFile).toBe('benchy.gcode'); // timestamp prefix stripped
  });

  test('currentFile is reduced to a clean basename when the printer reports a full path', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 1, state: 0, printProgress: 2, printFileName: '/usr/data/printer_data/gcodes/Voron_Cube_PLA_24m.gcode' });
    expect((await creality.getStatus(printer)).currentFile).toBe('Voron_Cube_PLA_24m.gcode');
  });

  // Regression: this is the exact frame my earlier (state-based) mapping mis-read as IDLE
  // mid-print - deviceState=1 means busy even though state=0 and selfTest=100.
  test('PRINTING when deviceState=1 even if state=0 and self-test finished (heating window)', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 1, state: 0, printProgress: 0, withSelfTest: 100 });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
  });

  test('PAUSED when state is 5', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 5, deviceState: 1, printProgress: 30, printFileName: 'part.gcode' });
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('PAUSED');
    expect(r.progress).toBe(30);
  });

  test('FINISHED once on the busy→idle edge (state 2), then IDLE', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 1, state: 0, printProgress: 90, printFileName: 'part.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 0, state: 2, printProgress: 100 })));
    const first = await creality.getStatus(printer);
    expect(first.status).toBe('FINISHED');
    expect(first.progress).toBeNull();
    // Subsequent polls of the same latched state must report IDLE so the printer returns to service.
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  test('STOPPED once (state 4), then IDLE', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 1, state: 0, printProgress: 40, printFileName: 'part.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 0, state: 4 })));
    expect((await creality.getStatus(printer)).status).toBe('STOPPED');
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  test('re-reports FINISHED for a new print after returning to idle', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 1, state: 0 }); // first print runs
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 0, state: 2 }))); // and completes
    expect((await creality.getStatus(printer)).status).toBe('FINISHED');
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 1, state: 0 }))); // next print runs
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 0, state: 2 }))); // and completes
    expect((await creality.getStatus(printer)).status).toBe('FINISHED');
  });

  // Regression: after a print the K1 keeps printProgress=100 and printFileName as stale
  // residuals while deviceState returns to 0 and state is not a terminal code. That must
  // read as IDLE - not a latched FINISHED - so the printer never gets stuck on "finished".
  test('IDLE when deviceState 0 with residual progress=100 but no terminal state', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 0, state: 0, printProgress: 100, printFileName: 'part.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  // Regression: a non-fatal hardware warning (e.g. mainboard fan) during an active print
  // must NOT override PRINTING - the error code is a warning, the print is still running.
  test('PRINTING when deviceState is busy and err.errcode is nonzero (non-fatal warning)', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 1, state: 0, printProgress: 42, printFileName: 'part.gcode', err: { errcode: 521 } });
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('PRINTING');
    expect(r.progress).toBe(42);
  });

  test('ERROR when deviceState is idle and err.errcode is nonzero (fatal fault)', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 0, state: 0, err: { errcode: 521 } });
    expect((await creality.getStatus(printer)).status).toBe('ERROR');
  });

  // Regression (PR review): a stray partial frame that merges into the cache before
  // deviceState/state are ever populated (e.g. arrives before the connect-time
  // reqPrintObjects response) must not fall through to IDLE - that would clear a hold
  // and offer a printer with no known status up for dispatch. It must report UNKNOWN so
  // the printer is held until real telemetry arrives.
  test('UNKNOWN when neither state nor deviceState is present in the cache', async () => {
    const printer = makePrinter();
    await drive(printer, { fan: 50 }); // unrelated field only - no state/deviceState yet
    expect((await creality.getStatus(printer)).status).toBe('UNKNOWN');
  });

  // Regression (PR review): a first frame carrying only a latched `state` (2/4), with
  // deviceState not merged in yet, must not be reported FINISHED/STOPPED - that would
  // credit the job before the driver has confirmed the device is actually idle (a
  // genuinely-busy printer whose deviceState frame just hasn't landed yet would otherwise
  // look complete mid-print). It must report UNKNOWN until deviceState is confirmed either
  // way. Once idle is confirmed, the latched code is the PREVIOUS print's outcome (this
  // connection never observed the print run), so the driver reports IDLE, not FINISHED.
  test('UNKNOWN when a terminal state (2) arrives before deviceState is known, then IDLE once idle is confirmed', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { state: 2 }); // no deviceState in this frame yet
    expect((await creality.getStatus(printer)).status).toBe('UNKNOWN');
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 0 }))); // now confirmed idle
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  test('UNKNOWN (not FINISHED) when a terminal state (2) arrives before deviceState, while the printer is actually still busy', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { state: 2 }); // stale/latched state, deviceState unknown
    expect((await creality.getStatus(printer)).status).toBe('UNKNOWN');
    // Busy arrives, but the cached `state` is still the old latch: without print-phase
    // evidence this stays UNKNOWN (held), not PRINTING.
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 1 })));
    expect((await creality.getStatus(printer)).status).toBe('UNKNOWN');
    // The print-phase state lands: now it is a confirmed print.
    ws.emit('message', Buffer.from(JSON.stringify({ state: 1 })));
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
  });

  // Regression (PR review): deviceState is nonzero for heating, leveling, and self-test
  // too, and the scheduler treats PRINTING as proof a dispatched job started (upload
  // confirmation, checkIfPrinting recovery, OFFLINE-hold release). Generic busy without
  // a print-phase `state` must therefore report UNKNOWN (safe hold), never PRINTING.
  test('UNKNOWN (not PRINTING) when the device is busy with no print-phase state', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 1 }); // busy, `state` never populated
    expect((await creality.getStatus(printer)).status).toBe('UNKNOWN');
    expect(await creality.checkIfPrinting(printer)).toBe(false); // recovery cannot latch onto it
  });

  // Regression (PR review): `state` is a latched last-outcome code, so a fresh connection
  // whose first complete snapshot is { deviceState: 0, state: 2/4 } is looking at the
  // previous print's outcome, not a new event. Emitting FINISHED here lets a reconnect
  // credit a database job the driver never watched print. The driver must report IDLE and
  // leave the missed-finish case to the poller's PRINTING-to-IDLE hold (operator sign-off).
  test('IDLE (not FINISHED) when a fresh connection first sees an idle device with a latched terminal state', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 0, state: 2, printProgress: 100, printFileName: 'old.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  test('does not replay a terminal outcome after a reconnect (print observation resets with the socket)', async () => {
    const printer = makePrinter();
    const ws1 = await drive(printer, { deviceState: 1, state: 0, printProgress: 60, printFileName: 'part.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');

    ws1.close(); // connection drops mid-print
    expect((await creality.getStatus(printer)).status).toBe('OFFLINE');

    jest.advanceTimersByTime(5000); // reconnect timer fires and opens a new socket
    const ws2 = WebSocket.instances[WebSocket.instances.length - 1];
    expect(ws2).not.toBe(ws1);
    ws2.readyState = WebSocket.OPEN;
    ws2.emit('open');
    // The print ended while disconnected: the new socket's first snapshot carries the
    // latched outcome. This connection never saw the print run, so no FINISHED; the
    // poller's missed-finish hold owns crediting in this case.
    ws2.emit('message', Buffer.from(JSON.stringify({ deviceState: 0, state: 2, printProgress: 100 })));
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  // Regression (PR review): busy alone is not evidence of a print. deviceState is
  // nonzero for heating, leveling, and self-test too, and frames are partial, so a
  // fresh connection can cache an old latched `state: 2` and then see a non-print
  // busy cycle. When that activity ends, the stale latch must not surface as a new
  // FINISHED (the poller would credit any active job).
  test('IDLE (not FINISHED) when a non-print busy cycle ends with a stale terminal latch cached', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { state: 2 }); // old latched outcome arrives first
    expect((await creality.getStatus(printer)).status).toBe('UNKNOWN');
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 1 }))); // self-test/leveling: busy, no print-phase state
    expect((await creality.getStatus(printer)).status).toBe('UNKNOWN'); // held, not PRINTING
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 0 }))); // activity ends
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  test('a self-test after a reported FINISHED does not re-report the same outcome', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 1, state: 0 }); // real print observed
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 0, state: 2 }))); // completes
    expect((await creality.getStatus(printer)).status).toBe('FINISHED');
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
    // Operator runs a self-test: busy again, but `state` keeps the old latch (2).
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 1 })));
    expect((await creality.getStatus(printer)).status).toBe('UNKNOWN'); // busy but no print-phase state
    ws.emit('message', Buffer.from(JSON.stringify({ deviceState: 0 }))); // self-test ends
    expect((await creality.getStatus(printer)).status).toBe('IDLE'); // no second FINISHED, no double credit
  });

  test('merges partial telemetry frames across pushes', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 1, state: 0, printFileName: 'part.gcode' });
    ws.emit('message', Buffer.from(JSON.stringify({ printProgress: 55 })));
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('PRINTING');
    expect(r.progress).toBe(55);
    expect(r.currentFile).toBe('part.gcode');
  });

  test('OFFLINE again after the socket closes (cache cleared)', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 1, state: 0, printProgress: 10, printFileName: 'part.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
    ws.close();
    expect((await creality.getStatus(printer)).status).toBe('OFFLINE');
  });
});

// ─── Application-level heartbeat ────────────────────────────────────────────────
// Regression (PR review): the firmware sends {"ModeCode":"heart_beat"} and expects the
// literal string "ok" back (not JSON). Firmware using this exchange closes the socket
// when unanswered, leaving active jobs flapping OFFLINE on every reconnect.
// Protocol source: ha_creality_ws ws_client.py.

describe('heartbeat acknowledgement', () => {
  test('replies with the literal "ok" to a heart_beat frame', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 1, state: 0 });
    ws.emit('message', Buffer.from(JSON.stringify({ ModeCode: 'heart_beat', msg: 0 })));
    expect(ws.sent).toContain('ok'); // raw string, not JSON.stringify('ok')
  });

  test('a heart_beat frame is not merged into cached telemetry', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 1, state: 0, printProgress: 42, printFileName: 'part.gcode' });
    ws.emit('message', Buffer.from(JSON.stringify({ ModeCode: 'heart_beat', msg: 0 })));
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('PRINTING'); // status unchanged by the heartbeat frame
    expect(r.progress).toBe(42);
  });
});

// ─── Connection lifecycle ──────────────────────────────────────────────────────
// Regression (PR review): connections were cached solely by printer.id, so editing a
// Creality printer's IP through the supported edit form left polling and reconnect
// attempts pointed at the old address until the server restarted.

describe('connection lifecycle', () => {
  test("reconnects to the new address when a printer's IP changes (edit form)", async () => {
    const printer = makePrinter({ ip: '192.168.1.77' });
    const ws1 = await drive(printer, { deviceState: 1, state: 0, printProgress: 10, printFileName: 'a.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');

    const updated = { ...printer, ip: '192.168.1.200' };
    const ws2 = await drive(updated, { deviceState: 0, state: 0 });

    expect(ws2).not.toBe(ws1);
    expect(ws1.readyState).toBe(3); // stale socket for the old address was torn down
    expect((await creality.getStatus(updated)).status).toBe('IDLE');

    // Traffic on the discarded socket must not affect the printer's reported status.
    ws1.emit('message', Buffer.from(JSON.stringify({ deviceState: 1, state: 0 })));
    expect((await creality.getStatus(updated)).status).toBe('IDLE');
  });

  test('reuses the existing connection when the IP is unchanged', async () => {
    const printer = makePrinter();
    await drive(printer, { deviceState: 1, state: 0 });
    const before = WebSocket.instances.length;
    await creality.getStatus({ ...printer }); // same ip, different object reference (fresh DB row)
    expect(WebSocket.instances.length).toBe(before); // no new socket created
  });

  // Regression (PR review): connections were retained in the module-level map forever.
  // Deleting, decommissioning, or re-typing a printer never closed its socket, so the
  // heartbeat and reconnect loop kept running until the server restarted. The printer
  // lifecycle routes now call disposeConnection() (see printers-driver-teardown.test.js).
  test('disposeConnection closes the socket and stops the reconnect loop', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { deviceState: 0, state: 0 });
    expect((await creality.getStatus(printer)).status).toBe('IDLE');

    creality.disposeConnection(printer.id);
    expect(ws.readyState).toBe(3); // socket closed

    const before = WebSocket.instances.length;
    jest.advanceTimersByTime(60000); // no reconnect attempt fires for the disposed connection
    expect(WebSocket.instances.length).toBe(before);

    // The map entry is gone: the next poll builds a brand-new connection.
    await creality.getStatus(printer);
    expect(WebSocket.instances.length).toBe(before + 1);
  });

  test('disposeConnection is a no-op for a printer with no cached connection', () => {
    expect(() => creality.disposeConnection(999999)).not.toThrow();
  });

  // Regression (PR review): backup restore bulk-replaces the printers table without
  // going through the per-printer lifecycle routes, so it disposes every cached
  // connection at once (see server/routes/backup.js).
  test('disposeAllConnections closes every cached socket and forgets them all', async () => {
    const p1 = makePrinter({ ip: '192.168.1.81' });
    const p2 = makePrinter({ ip: '192.168.1.82', name: 'K1_02' });
    const ws1 = await drive(p1, { deviceState: 0, state: 0 });
    const ws2 = await drive(p2, { deviceState: 0, state: 0 });

    creality.disposeAllConnections();
    expect(ws1.readyState).toBe(3);
    expect(ws2.readyState).toBe(3);

    const before = WebSocket.instances.length;
    jest.advanceTimersByTime(60000); // no reconnect attempts fire for disposed connections
    expect(WebSocket.instances.length).toBe(before);

    // Both map entries are gone: the next poll of each builds a brand-new connection.
    await creality.getStatus(p1);
    await creality.getStatus(p2);
    expect(WebSocket.instances.length).toBe(before + 2);
  });
});

// ─── uploadAndPrint ─────────────────────────────────────────────────────────────

describe('uploadAndPrint', () => {
  test('uploads via multipart POST then triggers opGcodeFile, resolving once printing is confirmed', async () => {
    const printer = makePrinter({ id: 500 });
    const ws = await drive(printer, { deviceState: 1, state: 0, printProgress: 5, printFileName: 'x.gcode' });
    axios.post.mockResolvedValueOnce({});

    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');

    const fullPath = createTestFile(`creality_upload_${Date.now()}.gcode`);
    const promise = creality.uploadAndPrint(printer, fullPath, 'x.gcode');
    await jest.advanceTimersByTimeAsync(1500); // drive the confirm loop's setTimeout
    await promise;

    const [url, , config] = axios.post.mock.calls[0];
    expect(url).toBe('http://192.168.1.77/upload/x.gcode');
    expect(config.headers['Authorization']).toBeUndefined(); // no api_key configured
    expect(appendSpy.mock.calls.some(([name]) => name === 'file')).toBe(true);

    const sentCommands = ws.sent.map(s => JSON.parse(s));
    expect(sentCommands).toContainEqual({
      method: 'set',
      params: { opGcodeFile: 'printprt:/usr/data/printer_data/gcodes/x.gcode' },
    });
    appendSpy.mockRestore();
  });

  test('sends Authorization: Bearer when an api_key is configured', async () => {
    const printer = makePrinter({ id: 501, api_key: 'secret' });
    await drive(printer, { deviceState: 1, state: 0, printProgress: 5, printFileName: 'x.gcode' });
    axios.post.mockResolvedValueOnce({});

    const fullPath = createTestFile(`creality_auth_${Date.now()}.gcode`);
    const promise = creality.uploadAndPrint(printer, fullPath, 'x.gcode');
    await jest.advanceTimersByTimeAsync(1500);
    await promise;

    expect(axios.post.mock.calls[0][2].headers['Authorization']).toBe('Bearer secret');
  });

  test('throws UPLOAD_CONFLICT on a 409 response', async () => {
    const printer = makePrinter({ id: 502 });
    axios.post.mockRejectedValueOnce({ response: { status: 409 } });
    const fullPath = createTestFile(`creality_conflict_${Date.now()}.gcode`);
    await expect(creality.uploadAndPrint(printer, fullPath, 'x.gcode'))
      .rejects.toMatchObject({ code: 'UPLOAD_CONFLICT' });
  });

  test('rethrows non-409 upload errors unchanged', async () => {
    const printer = makePrinter({ id: 503 });
    axios.post.mockRejectedValueOnce(new Error('Request failed with status code 500'));
    const fullPath = createTestFile(`creality_fail_${Date.now()}.gcode`);
    await expect(creality.uploadAndPrint(printer, fullPath, 'x.gcode'))
      .rejects.toThrow('500');
  });

  // Regression (PR review): confirmation must be command-correlated. A printer busy
  // with a DIFFERENT file (or generic activity like a self-test) must not confirm the
  // job this command just dispatched; the scheduler would record an unstarted job as
  // printing and its later busy-to-idle transition becomes a creditable missed finish.
  test('does not confirm the print while the printer reports a different file', async () => {
    const printer = makePrinter({ id: 504 });
    await drive(printer, { deviceState: 1, state: 0, printProgress: 50, printFileName: 'other.gcode' });
    axios.post.mockResolvedValueOnce({});

    const fullPath = createTestFile(`creality_wrongfile_${Date.now()}.gcode`);
    const promise = creality.uploadAndPrint(printer, fullPath, 'x.gcode');
    const assertion = expect(promise).rejects.toThrow('did not confirm printing');
    await jest.advanceTimersByTimeAsync(21000); // let the 20s confirm window expire
    await assertion;
  });

  // Regression (PR review): Creality firmware stores uploads with spaces replaced by
  // underscores (CrealityPrint safe_filename()). One sanitized remote name must be used
  // for the URL, the multipart filename, the start command, and the confirmation, or a
  // "Bracket v2.gcode" dispatch commands and waits on a file the printer actually
  // stored as "Bracket_v2.gcode" and times out on every attempt.
  test('sanitizes spaces to underscores consistently across upload, start, and confirmation', async () => {
    const printer = makePrinter({ id: 506 });
    const ws = await drive(printer, { deviceState: 1, state: 0, printProgress: 1, printFileName: 'Bracket_v2.gcode' });
    axios.post.mockResolvedValueOnce({});

    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');

    const fullPath = createTestFile(`creality_spaces_${Date.now()}.gcode`);
    const promise = creality.uploadAndPrint(printer, fullPath, 'Bracket v2.gcode');
    await jest.advanceTimersByTimeAsync(1500);
    await promise; // resolves: confirmation matches the sanitized name the printer reports

    expect(axios.post.mock.calls[0][0]).toBe('http://192.168.1.77/upload/Bracket_v2.gcode');
    const fileCall = appendSpy.mock.calls.find(([name]) => name === 'file');
    expect(fileCall[2].filename).toBe('Bracket_v2.gcode');
    const sentCommands = ws.sent.map(s => JSON.parse(s));
    expect(sentCommands).toContainEqual({
      method: 'set',
      params: { opGcodeFile: 'printprt:/usr/data/printer_data/gcodes/Bracket_v2.gcode' },
    });
    appendSpy.mockRestore();
  });

  test('does not confirm the print from a non-print busy cycle (no print-phase state)', async () => {
    const printer = makePrinter({ id: 505 });
    // Busy with a latched terminal state: a self-test/heating cycle, not a print.
    await drive(printer, { deviceState: 1, state: 2, printFileName: 'x.gcode' });
    axios.post.mockResolvedValueOnce({});

    const fullPath = createTestFile(`creality_selftest_${Date.now()}.gcode`);
    const promise = creality.uploadAndPrint(printer, fullPath, 'x.gcode');
    const assertion = expect(promise).rejects.toThrow('did not confirm printing');
    await jest.advanceTimersByTimeAsync(21000);
    await assertion;
  });
});

// ─── cancelJob ──────────────────────────────────────────────────────────────────

describe('cancelJob', () => {
  test('sends the stop command over the socket', async () => {
    const printer = makePrinter({ id: 600 });
    const ws = await drive(printer, { deviceState: 1, state: 0, printProgress: 10, printFileName: 'x.gcode' });
    await creality.cancelJob(printer);
    const sentCommands = ws.sent.map(s => JSON.parse(s));
    expect(sentCommands).toContainEqual({ method: 'set', params: { stop: 1 } });
  });

  test('does not throw when the printer is not connected', async () => {
    const printer = makePrinter({ id: 601 });
    await creality.getStatus(printer); // connection created but socket never opened
    const p = creality.cancelJob(printer);
    await jest.advanceTimersByTimeAsync(8500); // let waitForData time out
    await expect(p).resolves.toBeUndefined();
  });
});

// ─── checkIfPrinting ────────────────────────────────────────────────────────────

describe('checkIfPrinting', () => {
  test('true when printing', async () => {
    const printer = makePrinter({ id: 700 });
    await drive(printer, { deviceState: 1, state: 0, printProgress: 10, printFileName: 'x.gcode' });
    expect(await creality.checkIfPrinting(printer)).toBe(true);
  });

  test('true when paused', async () => {
    const printer = makePrinter({ id: 701 });
    await drive(printer, { state: 5, deviceState: 1, printProgress: 10, printFileName: 'x.gcode' });
    expect(await creality.checkIfPrinting(printer)).toBe(true);
  });

  test('false when idle', async () => {
    const printer = makePrinter({ id: 702 });
    await drive(printer, { deviceState: 0, state: 0 });
    expect(await creality.checkIfPrinting(printer)).toBe(false);
  });

  // Regression (PR review): the scheduler's failed-upload recovery passes the reserved
  // filename. A printer busy with a DIFFERENT print must not confirm the reservation,
  // or the never-started job's eventual "completion" credits the wrong part.
  test('with a filename: true only when the active print is that file', async () => {
    const printer = makePrinter({ id: 703 });
    await drive(printer, { deviceState: 1, state: 0, printProgress: 10, printFileName: 'x.gcode' });
    expect(await creality.checkIfPrinting(printer, 'x.gcode')).toBe(true);
    expect(await creality.checkIfPrinting(printer, 'other.gcode')).toBe(false);
  });

  test('with a filename: compares against the sanitized stored name (spaces become underscores)', async () => {
    const printer = makePrinter({ id: 704 });
    await drive(printer, { deviceState: 1, state: 0, printFileName: '/usr/data/printer_data/gcodes/Bracket_v2.gcode' });
    expect(await creality.checkIfPrinting(printer, 'Bracket v2.gcode')).toBe(true);
  });
});

// ─── Driver registry ──────────────────────────────────────────────────────────

describe('driver registry', () => {
  const { getDriver } = require('../drivers');
  test('getDriver("creality") returns the creality driver', () => {
    const driver = getDriver('creality');
    expect(typeof driver.getStatus).toBe('function');
    expect(typeof driver.uploadAndPrint).toBe('function');
    expect(typeof driver.cancelJob).toBe('function');
    expect(typeof driver.checkIfPrinting).toBe('function');
  });
});
