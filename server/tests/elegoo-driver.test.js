// Unit tests for server/drivers/elegoo-centauri.js
// The `sdcp` package is mocked — no real printers or WebSocket connections needed.
//
// Each test uses a unique printer ID to avoid sharing the module-level connection
// cache between test cases (the driver keeps a Map of id → SDCPPrinterWS).

jest.mock('sdcp/SDCPPrinterWS', () => jest.fn());

const SDCPPrinterWS = require('sdcp/SDCPPrinterWS');
const elegoo = require('../drivers/elegoo-centauri');

// Shared mock client — reset before each test
let mockClient;

beforeEach(() => {
  mockClient = {
    AutoReconnect: null,
    on: jest.fn(),
    Connect: jest.fn().mockResolvedValue(undefined),
    GetStatus: jest.fn(),
    UploadFile: jest.fn().mockResolvedValue({ Status: 'Complete' }),
    SendCommand: jest.fn().mockResolvedValue({ Data: { Data: { Ack: 0 } } }),
    Stop: jest.fn().mockResolvedValue(undefined),
    Disconnect: jest.fn(),
  };
  SDCPPrinterWS.mockImplementation(() => mockClient);
});

afterEach(() => {
  jest.clearAllMocks();
});

// Unique ID per test so each test gets a fresh connection from the pool
let idSeq = 100;
function nextPrinter() {
  const id = idSeq++;
  return { id, name: `Centauri_${id}`, ip: `10.0.0.${id}`, api_key: '', model: 'centauri-carbon', type: 'elegoo-centauri' };
}

// ─── getStatus — canonical state mapping ──────────────────────────────────────

describe('getStatus — SDCP status code mapping', () => {
  const cases = [
    { code: 0,  expected: 'IDLE',     desc: 'code 0 → IDLE' },
    { code: 1,  expected: 'PRINTING', desc: 'code 1 → PRINTING' },
    { code: 2,  expected: 'PAUSED',   desc: 'code 2 → PAUSED' },
    { code: 3,  expected: 'FINISHED', desc: 'code 3 (stopped) → FINISHED' },
    { code: 4,  expected: 'FINISHED', desc: 'code 4 (complete) → FINISHED' },
    { code: 9,  expected: 'FINISHED', desc: 'code 9 (post-completion: CurrentLayer===TotalLayer, Filename cleared) → FINISHED' },
    { code: 13, expected: 'PRINTING', desc: 'code 13 → PRINTING (active print, layer incrementing)' },
    { code: 16, expected: 'PRINTING', desc: 'code 16 → PRINTING (FDM preparing/preheating startup state)' },
    { code: 21, expected: 'PRINTING', desc: 'code 21 → PRINTING (startup/init state, file loaded)' },
  ];

  for (const { code, expected, desc } of cases) {
    test(desc, async () => {
      mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: code } } });
      const result = await elegoo.getStatus(nextPrinter());
      expect(result.status).toBe(expected);
    });
  }

  test('returns UNKNOWN for unrecognised code (e.g. 5)', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 5 } } });
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.status).toBe('UNKNOWN');
  });

  test('returns UNKNOWN for unrecognised code (e.g. 99 — not ERROR, avoids false holds)', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 99 } } });
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.status).toBe('UNKNOWN');
  });

  test('returns UNKNOWN when PrintInfo is absent', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({});
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.status).toBe('UNKNOWN');
  });
});

// ─── getStatus — progress and timeRemaining ───────────────────────────────────

describe('getStatus — progress and timeRemaining', () => {
  test('calculates progress from CurrentTicks/TotalTicks when PRINTING', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({
      Status: { PrintInfo: { Status: 1, CurrentTicks: 250, TotalTicks: 1000, RemainTime: 600 } },
    });
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.status).toBe('PRINTING');
    expect(result.progress).toBe(25);
    expect(result.timeRemaining).toBe(600);
  });

  test('calculates progress when PAUSED', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({
      Status: { PrintInfo: { Status: 2, CurrentTicks: 500, TotalTicks: 1000, RemainTime: 300 } },
    });
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.status).toBe('PAUSED');
    expect(result.progress).toBe(50);
  });

  test('progress is null when IDLE', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 0 } } });
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('progress is null when FINISHED', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 4 } } });
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('progress is null when TotalTicks is zero (division guard)', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({
      Status: { PrintInfo: { Status: 1, CurrentTicks: 0, TotalTicks: 0 } },
    });
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.progress).toBeNull();
  });
});

// ─── getStatus — OFFLINE handling ─────────────────────────────────────────────

describe('getStatus — OFFLINE handling', () => {
  test('returns OFFLINE when Connect throws (unreachable printer)', async () => {
    mockClient.Connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await elegoo.getStatus(nextPrinter());
    expect(result.status).toBe('OFFLINE');
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('returns OFFLINE when GetStatus throws after connection established', async () => {
    const printer = nextPrinter();
    // First call establishes a connection successfully
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 1 } } });
    await elegoo.getStatus(printer);

    // Second call: GetStatus fails (WebSocket dropped mid-poll)
    mockClient.GetStatus.mockRejectedValueOnce(new Error('WebSocket closed'));
    const result = await elegoo.getStatus(printer);
    expect(result.status).toBe('OFFLINE');
  });
});

// ─── uploadAndPrint ───────────────────────────────────────────────────────────

describe('uploadAndPrint', () => {
  test('calls UploadFile with the local file path', async () => {
    const printer = nextPrinter();
    await elegoo.uploadAndPrint(printer, '/tmp/test.gcode', 'test.gcode');
    expect(mockClient.UploadFile).toHaveBeenCalledWith(
      '/tmp/test.gcode',
      expect.objectContaining({ ProgressCallback: expect.any(Function) })
    );
  });

  test('sends SendCommand with full Cmd 128 payload using basename of gcodeFullPath', async () => {
    const printer = nextPrinter();
    mockClient.SendCommand.mockResolvedValueOnce({ Data: { Data: { Ack: 0 } } });
    await elegoo.uploadAndPrint(printer, '/tmp/1746000000000_part.gcode', 'part.gcode');
    expect(mockClient.SendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Data: expect.objectContaining({
          Cmd: 128,
          Data: expect.objectContaining({
            Filename: '1746000000000_part.gcode',
            StartLayer: 0,
            Calibration_switch: 0,
            PrintPlatformType: 1,
            Tlp_Switch: 0,
            slot_map: [],
          }),
        }),
      })
    );
  });

  test('calls UploadFile before SendCommand', async () => {
    const printer = nextPrinter();
    const order = [];
    mockClient.UploadFile.mockImplementationOnce(async () => { order.push('upload'); });
    mockClient.SendCommand.mockImplementationOnce(async () => { order.push('start'); return { Data: { Data: { Ack: 0 } } }; });

    await elegoo.uploadAndPrint(printer, '/tmp/seq.gcode', 'seq.gcode');
    expect(order).toEqual(['upload', 'start']);
  });

  test('throws with Ack error description when printer rejects start', async () => {
    const printer = nextPrinter();
    mockClient.SendCommand.mockResolvedValueOnce({ Data: { Data: { Ack: 2 } } });
    await expect(elegoo.uploadAndPrint(printer, '/tmp/part.gcode', 'part.gcode'))
      .rejects.toThrow('file not found on printer');
  });

  test('throws when UploadFile rejects', async () => {
    const printer = nextPrinter();
    mockClient.UploadFile.mockRejectedValueOnce(new Error('Upload failed'));
    await expect(elegoo.uploadAndPrint(printer, '/tmp/bad.gcode', 'bad.gcode'))
      .rejects.toThrow('Upload failed');
    // SendCommand should not be called if upload failed
    expect(mockClient.SendCommand).not.toHaveBeenCalled();
  });
});

// ─── cancelJob ────────────────────────────────────────────────────────────────

describe('cancelJob', () => {
  test('calls Stop on the printer client', async () => {
    const printer = nextPrinter();
    // Establish connection first via getStatus
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 1 } } });
    await elegoo.getStatus(printer);

    await elegoo.cancelJob(printer);
    expect(mockClient.Stop).toHaveBeenCalledTimes(1);
  });

  test('does not throw when Stop fails', async () => {
    const printer = nextPrinter();
    mockClient.Stop.mockRejectedValueOnce(new Error('Stop failed'));
    await expect(elegoo.cancelJob(printer)).resolves.not.toThrow();
  });
});

// ─── checkIfPrinting ──────────────────────────────────────────────────────────

describe('checkIfPrinting', () => {
  test('returns true when PRINTING', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 1 } } });
    expect(await elegoo.checkIfPrinting(nextPrinter())).toBe(true);
  });

  test('returns true when PAUSED', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 2 } } });
    expect(await elegoo.checkIfPrinting(nextPrinter())).toBe(true);
  });

  test('returns false when IDLE', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 0 } } });
    expect(await elegoo.checkIfPrinting(nextPrinter())).toBe(false);
  });

  test('returns false when FINISHED', async () => {
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 4 } } });
    expect(await elegoo.checkIfPrinting(nextPrinter())).toBe(false);
  });

  test('returns false when OFFLINE (Connect throws)', async () => {
    mockClient.Connect.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await elegoo.checkIfPrinting(nextPrinter())).toBe(false);
  });
});

// ─── dropConnection / closeAll (SDCP teardown) ────────────────────────────────

describe('dropConnection / closeAll', () => {
  test('turns OFF autoreconnect before disconnecting, then removes the client from the pool', async () => {
    const printer = nextPrinter();
    // Establish a pooled connection (getConnection sets AutoReconnect = 5000).
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 1 } } });
    await elegoo.getStatus(printer);
    expect(mockClient.AutoReconnect).toBe(5000);

    elegoo.dropConnection(printer.id);

    // AutoReconnect must be exactly `false` (a number would set a retry interval and
    // the SDCPPrinterWS close handler would revive the socket we just dropped).
    expect(mockClient.AutoReconnect).toBe(false);
    expect(mockClient.Disconnect).toHaveBeenCalledTimes(1);

    // Proof the pool entry was removed: the next poll reconstructs a fresh client.
    SDCPPrinterWS.mockClear();
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 0 } } });
    await elegoo.getStatus(printer);
    expect(SDCPPrinterWS).toHaveBeenCalledTimes(1);
  });

  test('is a safe no-op for an unknown / never-connected printer id', () => {
    expect(() => elegoo.dropConnection(987654)).not.toThrow();
  });

  test('closeAll disables autoreconnect and disconnects a pooled client', async () => {
    const printer = nextPrinter();
    mockClient.GetStatus.mockResolvedValueOnce({ Status: { PrintInfo: { Status: 1 } } });
    await elegoo.getStatus(printer);

    elegoo.closeAll();
    expect(mockClient.AutoReconnect).toBe(false);
    expect(mockClient.Disconnect).toHaveBeenCalled();
  });
});

// ─── Driver registry ──────────────────────────────────────────────────────────

describe('driver registry (drivers/index.js)', () => {
  const { getDriver } = require('../drivers');

  test('getDriver("elegoo-centauri") returns the elegoo driver', () => {
    const driver = getDriver('elegoo-centauri');
    expect(typeof driver.getStatus).toBe('function');
    expect(typeof driver.uploadAndPrint).toBe('function');
    expect(typeof driver.checkIfPrinting).toBe('function');
    expect(typeof driver.cancelJob).toBe('function');
  });

  test('getDriver("prusa") still works alongside elegoo-centauri', () => {
    const driver = getDriver('prusa');
    expect(typeof driver.getStatus).toBe('function');
  });
});
