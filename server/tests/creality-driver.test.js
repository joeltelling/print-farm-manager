// Unit tests for server/drivers/creality.js
// The WebSocket (`ws`) and HTTP (`axios`) layers are mocked — no real printers needed.

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
// then return the printer so a follow-up getStatus() reads it from cache.
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
    const result = await creality.getStatus(printer); // connection created, socket not open
    expect(result).toEqual({ status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null });
  });

  test('IDLE when state 0 with no file loaded', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 0 });
    expect((await creality.getStatus(printer)).status).toBe('IDLE');
  });

  test('PRINTING when state 1, with progress/time/file', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 1, printProgress: 42, printLeftTime: 600, printFileName: '1712345678901_benchy.gcode' });
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('PRINTING');
    expect(r.progress).toBe(42);
    expect(r.timeRemaining).toBe(600);
    expect(r.currentFile).toBe('benchy.gcode'); // timestamp prefix stripped
  });

  test('PRINTING (heating/processing) when state 0 but a file is loaded and progress < 100', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 0, printFileName: 'part.gcode', printProgress: 3 });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
  });

  test('PRINTING during self-test/calibration', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 0, withSelfTest: 12 });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
  });

  test('PAUSED when state 5', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 5, printProgress: 30, printFileName: 'part.gcode' });
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('PAUSED');
    expect(r.progress).toBe(30); // progress/time still reported while paused
  });

  test('STOPPED when state 4 (user pressed Stop)', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 4, printProgress: 40, printFileName: 'part.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FINISHED when returned to idle with file loaded and progress 100', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 0, printProgress: 100, printFileName: 'part.gcode' });
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('FINISHED');
    expect(r.progress).toBeNull(); // progress only reported while PRINTING/PAUSED
  });

  test('ERROR when err.errcode is nonzero (takes priority over state)', async () => {
    const printer = makePrinter();
    await drive(printer, { state: 1, err: { errcode: 521 } });
    expect((await creality.getStatus(printer)).status).toBe('ERROR');
  });

  test('merges partial telemetry frames across pushes', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { state: 1, printFileName: 'part.gcode' });
    ws.emit('message', Buffer.from(JSON.stringify({ printProgress: 55 }))); // later partial frame
    const r = await creality.getStatus(printer);
    expect(r.status).toBe('PRINTING');
    expect(r.progress).toBe(55);
    expect(r.currentFile).toBe('part.gcode'); // retained from the earlier frame
  });

  test('OFFLINE again after the socket closes (cache cleared)', async () => {
    const printer = makePrinter();
    const ws = await drive(printer, { state: 1, printProgress: 10, printFileName: 'part.gcode' });
    expect((await creality.getStatus(printer)).status).toBe('PRINTING');
    ws.close();
    expect((await creality.getStatus(printer)).status).toBe('OFFLINE');
  });
});

// ─── uploadAndPrint ─────────────────────────────────────────────────────────────

describe('uploadAndPrint', () => {
  test('uploads via multipart POST then triggers opGcodeFile, resolving once printing is confirmed', async () => {
    const printer = makePrinter({ id: 500 });
    const ws = await drive(printer, { state: 1, printProgress: 5, printFileName: 'x.gcode' });
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
    await drive(printer, { state: 1, printProgress: 5, printFileName: 'x.gcode' });
    axios.post.mockResolvedValueOnce({});

    const fullPath = createTestFile(`creality_auth_${Date.now()}.gcode`);
    const promise = creality.uploadAndPrint(printer, fullPath, 'x.gcode');
    await jest.advanceTimersByTimeAsync(1500);
    await promise;

    const config = axios.post.mock.calls[0][2];
    expect(config.headers['Authorization']).toBe('Bearer secret');
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
});

// ─── cancelJob ──────────────────────────────────────────────────────────────────

describe('cancelJob', () => {
  test('sends the stop command over the socket', async () => {
    const printer = makePrinter({ id: 600 });
    const ws = await drive(printer, { state: 1, printProgress: 10, printFileName: 'x.gcode' });
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
    await drive(printer, { state: 1, printProgress: 10, printFileName: 'x.gcode' });
    expect(await creality.checkIfPrinting(printer)).toBe(true);
  });

  test('true when paused', async () => {
    const printer = makePrinter({ id: 701 });
    await drive(printer, { state: 5, printProgress: 10, printFileName: 'x.gcode' });
    expect(await creality.checkIfPrinting(printer)).toBe(true);
  });

  test('false when idle', async () => {
    const printer = makePrinter({ id: 702 });
    await drive(printer, { state: 0 });
    expect(await creality.checkIfPrinting(printer)).toBe(false);
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
