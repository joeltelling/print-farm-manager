// Unit tests for server/drivers/octoprint.js
// All network calls are mocked — no real printers needed.

jest.mock('axios');
const axios = require('axios');

const path = require('path');
const fs = require('fs');
const octoprint = require('../drivers/octoprint');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const fakePrinter = { id: 1, name: 'OctoPi_01', ip: '192.168.1.240:5000', model: 'mk3s', type: 'octoprint', api_key: 'test-key' };

const filesToClean = [];

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});

afterAll(() => {
  for (const p of filesToClean) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});

afterEach(() => {
  jest.clearAllMocks();
});

function createTestFile(filename) {
  const filePath = path.join(GCODE_DIR, filename);
  fs.writeFileSync(filePath, '; fake gcode');
  filesToClean.push(filePath);
  return filePath;
}

function printerResponse(flags) {
  return { data: { state: { flags: { operational: true, printing: false, paused: false, pausing: false, cancelling: false, error: false, closedOrError: false, ready: true, ...flags } } } };
}

function jobResponse({ completion = null, printTimeLeft = null, filename = null } = {}) {
  return {
    data: {
      progress: { completion, printTimeLeft },
      job: { file: { name: filename } },
    },
  };
}

function mockPair(printerFlags, jobOpts) {
  axios.get.mockImplementation((url) => {
    if (url.includes('/api/printer')) return Promise.resolve(printerResponse(printerFlags));
    if (url.includes('/api/job')) return Promise.resolve(jobResponse(jobOpts));
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  test('returns IDLE when operational with no job loaded', async () => {
    mockPair({}, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('IDLE');
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('returns PRINTING with progress, time remaining, and current file', async () => {
    mockPair({ printing: true }, { completion: 42, printTimeLeft: 600, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
    expect(result.progress).toBe(42);
    expect(result.timeRemaining).toBe(600);
    expect(result.currentFile).toBe('part.gcode');
  });

  test('returns PRINTING while cancelling (transitional state)', async () => {
    mockPair({ cancelling: true }, { completion: 80, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
  });

  test('returns PAUSED', async () => {
    mockPair({ paused: true }, { completion: 30, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PAUSED');
  });

  test('returns FINISHED when not printing, job file present, completion is 100', async () => {
    mockPair({}, { completion: 100, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('FINISHED');
    expect(result.progress).toBeNull();
  });

  test('returns IDLE (not FINISHED) when completion is 100 but no job file loaded', async () => {
    mockPair({}, { completion: 100, filename: null });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('IDLE');
  });

  test('returns ERROR when error flag is set', async () => {
    mockPair({ error: true }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('ERROR');
  });

  test('returns ERROR when closedOrError flag is set', async () => {
    mockPair({ operational: false, closedOrError: true }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('ERROR');
  });

  test('returns UNKNOWN when not operational and no error flag', async () => {
    mockPair({ operational: false }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('UNKNOWN');
  });

  test('returns OFFLINE on network error', async () => {
    axios.get.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('OFFLINE');
    expect(result.progress).toBeNull();
  });

  test('queries /api/printer and /api/job with X-Api-Key header', async () => {
    mockPair({}, {});
    await octoprint.getStatus(fakePrinter);
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/printer',
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/job',
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
  });
});

// ─── uploadAndPrint ───────────────────────────────────────────────────────────

describe('uploadAndPrint', () => {
  test('POSTs to /api/files/local with select and print form fields', async () => {
    const filename = `octoprint_upload_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockResolvedValueOnce({});

    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');

    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);

    const [url, , config] = axios.post.mock.calls[0];
    expect(url).toBe('http://192.168.1.240:5000/api/files/local');
    expect(config.headers['X-Api-Key']).toBe('test-key');

    const appendedFields = appendSpy.mock.calls.map(([name, value]) => ({ name, value }));
    expect(appendedFields).toContainEqual({ name: 'select', value: 'true' });
    expect(appendedFields).toContainEqual({ name: 'print', value: 'true' });

    appendSpy.mockRestore();
  });

  test('throws UPLOAD_CONFLICT on 409 response', async () => {
    const filename = `octoprint_conflict_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockRejectedValueOnce({ response: { status: 409 } });

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toMatchObject({ code: 'UPLOAD_CONFLICT' });
  });

  test('rethrows non-409 errors unchanged', async () => {
    const filename = `octoprint_fail_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockRejectedValueOnce(new Error('Request failed with status code 500'));

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toThrow('500');
  });
});

// ─── cancelJob ─────────────────────────────────────────────────────────────────

describe('cancelJob', () => {
  test('POSTs cancel command to /api/job', async () => {
    axios.post.mockResolvedValueOnce({});
    await octoprint.cancelJob(fakePrinter);
    expect(axios.post).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/job',
      { command: 'cancel' },
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
  });

  test('swallows errors', async () => {
    axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(octoprint.cancelJob(fakePrinter)).resolves.toBeUndefined();
  });
});

// ─── checkIfPrinting ─────────────────────────────────────────────────────────

describe('checkIfPrinting', () => {
  test('returns true when printing', async () => {
    axios.get.mockResolvedValueOnce(printerResponse({ printing: true }));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns true when paused', async () => {
    axios.get.mockResolvedValueOnce(printerResponse({ paused: true }));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns false when idle', async () => {
    axios.get.mockResolvedValueOnce(printerResponse({}));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(false);
  });

  test('returns false when printer is unreachable', async () => {
    axios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(false);
  });
});

// ─── getCameraUrl ──────────────────────────────────────────────────────────────

describe('getCameraUrl', () => {
  test('returns resolved stream/snapshot URLs from settings.webcam', async () => {
    axios.get.mockResolvedValueOnce({
      data: { webcam: { streamUrl: '/webcam/?action=stream', snapshotUrl: '/webcam/?action=snapshot' } },
    });
    const result = await octoprint.getCameraUrl(fakePrinter);
    expect(result).toEqual({
      streamUrl: 'http://192.168.1.240:5000/webcam/?action=stream',
      snapshotUrl: 'http://192.168.1.240:5000/webcam/?action=snapshot',
    });
  });

  test('passes through an already-absolute stream URL unchanged', async () => {
    axios.get.mockResolvedValueOnce({
      data: { webcam: { streamUrl: 'http://otherhost:8080/stream', snapshotUrl: null } },
    });
    const result = await octoprint.getCameraUrl(fakePrinter);
    expect(result.streamUrl).toBe('http://otherhost:8080/stream');
    expect(result.snapshotUrl).toBeNull();
  });

  test('returns null when no webcam is configured', async () => {
    axios.get.mockResolvedValueOnce({ data: { webcam: {} } });
    expect(await octoprint.getCameraUrl(fakePrinter)).toBeNull();
  });

  test('returns null on network error', async () => {
    axios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await octoprint.getCameraUrl(fakePrinter)).toBeNull();
  });

  test('queries /api/settings with X-Api-Key header', async () => {
    axios.get.mockResolvedValueOnce({ data: { webcam: {} } });
    await octoprint.getCameraUrl(fakePrinter);
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/settings',
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
  });
});

// ─── Driver registry ──────────────────────────────────────────────────────────

describe('driver registry', () => {
  const { getDriver } = require('../drivers');

  test('getDriver("octoprint") returns the octoprint driver', () => {
    const driver = getDriver('octoprint');
    expect(typeof driver.getStatus).toBe('function');
    expect(typeof driver.uploadAndPrint).toBe('function');
    expect(typeof driver.cancelJob).toBe('function');
    expect(typeof driver.checkIfPrinting).toBe('function');
    expect(typeof driver.getCameraUrl).toBe('function');
  });
});
