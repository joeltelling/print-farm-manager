// Unit tests for server/drivers/bambu.js
// mqtt and basic-ftp are mocked — no real network connections needed.
//
// Each test uses a unique printer ID to avoid sharing the module-level
// connection cache (Map of id → conn) between test cases.

jest.mock('mqtt');
jest.mock('basic-ftp');

const mqtt = require('mqtt');
const ftp  = require('basic-ftp');
const bambu = require('../drivers/bambu');

// ─── Mock setup ───────────────────────────────────────────────────────────────

let mockPublish;
let mockSubscribe;
let mockMqttClient;
let messageHandler; // captured from client.on('message', handler)

let mockFtpClient;

beforeEach(() => {
  messageHandler = null;

  mockPublish   = jest.fn();
  mockSubscribe = jest.fn();

  mockMqttClient = {
    // Fire 'connect' synchronously so conn.connected = true immediately.
    // Capture 'message' handler for AMS state injection in tests.
    on: jest.fn((event, handler) => {
      if (event === 'connect') handler();
      if (event === 'message') messageHandler = handler;
    }),
    publish:   mockPublish,
    subscribe: mockSubscribe,
    end:       jest.fn(),
  };
  mqtt.connect.mockReturnValue(mockMqttClient);

  mockFtpClient = {
    ftp:        { verbose: false },
    access:     jest.fn().mockResolvedValue(undefined),
    uploadFrom: jest.fn().mockResolvedValue(undefined),
    close:      jest.fn(),
  };
  ftp.Client.mockImplementation(() => mockFtpClient);
});

afterEach(() => jest.clearAllMocks());

// ─── Helpers ──────────────────────────────────────────────────────────────────

let idSeq = 300;
function nextPrinter() {
  const id = idSeq++;
  return { id, name: `Bambu_${id}`, ip: '192.168.1.50', api_key: 'TESTCODE',
           serial_number: `SN${id}`, model: 'x1c', type: 'bambu' };
}

// Establish a connection for the printer (populates the internal Map)
// then inject a status push to set conn.latestPrint.
// Connection setup now resolves the printer's hostname (server/mdns-resolve.js)
// before calling mqtt.connect, so it is no longer synchronous: getStatus must be
// awaited before the mocked mqtt client's 'message' handler is guaranteed to exist.
async function pushStatus(printer, printData) {
  await bambu.getStatus(printer); // creates connection, registers message handler
  expect(messageHandler).not.toBeNull();
  messageHandler(null, Buffer.from(JSON.stringify({ print: printData })));
}

// Parse the MQTT payload from the first publish call that matches a command.
function findPayload(command) {
  const call = mockPublish.mock.calls.find(c => {
    try { return JSON.parse(c[1]).print?.command === command; } catch { return false; }
  });
  return call ? JSON.parse(call[1]).print : null;
}

// ─── getAmsSlots ──────────────────────────────────────────────────────────────

describe('getAmsSlots', () => {
  test('returns null when printer has no connection yet', () => {
    expect(bambu.getAmsSlots(nextPrinter())).toBeNull();
  });

  test('returns null when connected but no status received yet', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer); // creates connection; latestPrint is still null
    expect(bambu.getAmsSlots(printer)).toBeNull();
  });

  test('returns loaded AMS trays, skipping empty slots', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, {
      ams: {
        ams: [{
          id: '0',
          tray: [
            { id: '0' },                                             // empty — no tray_type
            { id: '1', tray_type: 'PLA', tray_color: 'FFFFFFFF' }, // loaded
          ],
        }],
      },
      vt_tray: { tray_type: 'PETG', tray_color: 'FF0000FF' },
    });

    const slots = bambu.getAmsSlots(printer);
    // AMS unit 0, tray 1 → compound slot (0*4)+1 = 1
    expect(slots).toContainEqual({ slot: 1, type: 'PLA', color: 'FFFFFFFF' });
    // Empty tray (id 0) must be excluded
    expect(slots.find(s => s.slot === 0 && s.type)).toBeUndefined();
  });

  test('always includes external spool as slot -1', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, {
      ams:     { ams: [] },
      vt_tray: { tray_type: 'ABS', tray_color: '000000FF' },
    });
    expect(bambu.getAmsSlots(printer)).toContainEqual(
      { slot: -1, type: 'ABS', color: '000000FF' }
    );
  });

  test('includes external spool even when no filament is loaded', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, { ams: { ams: [] }, vt_tray: {} });
    const ext = bambu.getAmsSlots(printer).find(s => s.slot === -1);
    expect(ext).toBeDefined();
    expect(ext.type).toBe('');
  });

  test('computes compound slot IDs for multi-unit AMS', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, {
      ams: {
        ams: [
          { id: '0', tray: [{ id: '0', tray_type: 'PLA',  tray_color: 'FFFF00FF' }] },
          { id: '1', tray: [{ id: '2', tray_type: 'ABS',  tray_color: '000000FF' }] },
        ],
      },
      vt_tray: {},
    });
    const slots = bambu.getAmsSlots(printer);
    expect(slots).toContainEqual({ slot: 0, type: 'PLA', color: 'FFFF00FF' }); // (0*4)+0
    expect(slots).toContainEqual({ slot: 6, type: 'ABS', color: '000000FF' }); // (1*4)+2
  });
});

// ─── getStatus — FAILED disambiguation ───────────────────────────────────────
// Bambu reports user-cancelled prints as gcode_state FAILED, same as genuine
// failures. print_error tells them apart: 50348044 = cancelled by user (resets
// to 0 a few seconds later while gcode_state stays FAILED); any other nonzero
// value = real firmware-detected failure.

describe('getStatus — FAILED: user cancel vs real failure', () => {
  test('FAILED with cancel code 50348044 maps to STOPPED', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, { gcode_state: 'FAILED', print_error: 50348044 });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with print_error 0 (settled cancel) maps to STOPPED', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, { gcode_state: 'FAILED', print_error: 0 });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with no print_error field maps to STOPPED', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, { gcode_state: 'FAILED' });
    expect((await bambu.getStatus(printer)).status).toBe('STOPPED');
  });

  test('FAILED with a different nonzero print_error maps to ERROR', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, { gcode_state: 'FAILED', print_error: 117473285 });
    expect((await bambu.getStatus(printer)).status).toBe('ERROR');
  });

  test('RUNNING with a nonzero print_error stays PRINTING', async () => {
    const printer = nextPrinter();
    await pushStatus(printer, { gcode_state: 'RUNNING', print_error: 50348044, mc_percent: 40 });
    expect((await bambu.getStatus(printer)).status).toBe('PRINTING');
  });
});

// ─── uploadAndPrint — .3mf ────────────────────────────────────────────────────

describe('uploadAndPrint — .3mf (project_file)', () => {
  test('uses project_file MQTT command', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(findPayload('project_file')).not.toBeNull();
  });

  test('URL is ftp:///filename (per OpenBambuAPI spec)', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(findPayload('project_file').url).toBe('ftp:///1234_part.3mf');
  });

  test('AMS slot 0: use_ams true, ams_mapping [0]', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(true);
    expect(p.ams_mapping).toEqual([0]);
  });

  test('AMS slot 3: ams_mapping is [3]', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 3 });

    expect(findPayload('project_file').ams_mapping).toEqual([3]);
  });

  test('external spool (amsSlot: -1): use_ams false, ams_mapping empty array', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: -1 });

    const p = findPayload('project_file');
    expect(p.use_ams).toBe(false);
    expect(p.ams_mapping).toEqual([]);
  });

  test('null amsSlot defaults to use_ams false (external spool)', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: null });

    expect(findPayload('project_file').use_ams).toBe(false);
  });

  test('omitting options entirely defaults to use_ams false', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);
    mockPublish.mockClear();

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf');

    expect(findPayload('project_file').use_ams).toBe(false);
  });

  test('uploads to FTP root (no ensureDir for .3mf)', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);

    await bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf', { amsSlot: 0 });

    expect(mockFtpClient.uploadFrom).toHaveBeenCalledWith('/tmp/1234_part.3mf', '1234_part.3mf');
  });

  test('throws when MQTT is not connected', async () => {
    const printer = nextPrinter();
    // Override: suppress 'connect' so conn.connected stays false
    mockMqttClient.on = jest.fn((event, handler) => {
      if (event === 'message') messageHandler = handler;
    });
    await bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf')
    ).rejects.toThrow(/MQTT not connected/);
  });

  test('throws when serial_number is missing', async () => {
    const printer = { ...nextPrinter(), serial_number: '' };
    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.3mf', 'part.3mf')
    ).rejects.toThrow(/no serial number/);
  });
});

// ─── uploadAndPrint — non-.3mf rejection ─────────────────────────────────────
// Bambu printers only accept .3mf files (project_file command). Plain .gcode
// and .bgcode uploads are rejected before any FTP/MQTT activity.

describe('uploadAndPrint — non-.3mf rejection', () => {
  test('throws for .gcode with descriptive message', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow(/requires a \.3mf file/);
  });

  test('throws for .bgcode with descriptive message', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.bgcode', 'part.bgcode')
    ).rejects.toThrow(/requires a \.3mf file/);
  });

  test('does not attempt FTP upload when file is rejected', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow();

    expect(mockFtpClient.uploadFrom).not.toHaveBeenCalled();
  });

  test('does not publish MQTT when file is rejected', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer);
    mockPublish.mockClear();

    await expect(
      bambu.uploadAndPrint(printer, '/tmp/1234_part.gcode', 'part.gcode')
    ).rejects.toThrow();

    expect(mockPublish).not.toHaveBeenCalled();
  });
});

// ─── Test connection ──────────────────────────────────────────────────────────
// Uses its own throwaway mqtt client (reconnectPeriod: 0), separate from the
// module's cached connections Map, so it does not need nextPrinter()'s unique-id
// trick, but a fresh printer keeps it isolated from any earlier test's cache entry.

describe('testConnection', () => {
  test('reports ok on a successful connect and ends the throwaway client', async () => {
    const printer = nextPrinter();
    const result = await bambu.testConnection(printer);
    expect(result).toEqual({ ok: true, message: 'Connected' });
    expect(mockMqttClient.end).toHaveBeenCalledWith(true);
  });

  test('reports the connect error', async () => {
    mockMqttClient.on = jest.fn((event, handler) => {
      if (event === 'error') handler(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    });
    const printer = nextPrinter();
    const result = await bambu.testConnection(printer);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refused/i);
  });

  test('does not touch the cached connection used by getStatus', async () => {
    const printer = nextPrinter();
    await bambu.getStatus(printer); // populates the real connections cache
    mockPublish.mockClear();

    await bambu.testConnection(printer);

    // testConnection's own client publishes nothing (it only connects); the
    // cached connection's 'connect' handler is what calls publish(pushall).
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
