// Unit tests for server/drivers/elegoo-centauri2.js's testConnection() only.
// The rest of this driver (getStatus, uploadAndPrint, cancelJob, checkIfPrinting)
// has no dedicated test file yet; that gap predates this change and is out of
// scope here. mqtt is mocked: no real printers or MQTT connections needed.

jest.mock('mqtt');

const mqtt = require('mqtt');
const cc2 = require('../drivers/elegoo-centauri2');

let mockClient;

beforeEach(() => {
  mockClient = {
    on: jest.fn((event, handler) => {
      if (event === 'connect') handler();
    }),
    end:       jest.fn(),
    subscribe: jest.fn(),
    publish:   jest.fn(),
  };
  mqtt.connect.mockReturnValue(mockClient);
});

afterEach(() => jest.clearAllMocks());

let idSeq = 500;
function nextPrinter() {
  const id = idSeq++;
  return { id, name: `CC2_${id}`, ip: `10.0.1.${id % 254}`, api_key: 'ACCESSCODE',
           serial_number: `CC2SN${id}`, model: 'centauri-carbon-2', type: 'elegoo-centauri2' };
}

describe('testConnection', () => {
  test('reports ok on a successful connect and ends the throwaway client', async () => {
    const result = await cc2.testConnection(nextPrinter());
    expect(result).toEqual({ ok: true, message: 'Connected' });
    expect(mockClient.end).toHaveBeenCalledWith(true);
  });

  test('reports the connect error', async () => {
    mockClient.on = jest.fn((event, handler) => {
      if (event === 'error') handler(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    });
    const result = await cc2.testConnection(nextPrinter());
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refused/i);
  });

  test('connects with reconnectPeriod: 0 so a throwaway test client never retries', async () => {
    await cc2.testConnection(nextPrinter());
    const opts = mqtt.connect.mock.calls[0][1];
    expect(opts.reconnectPeriod).toBe(0);
  });
});

describe('driver registry (drivers/index.js)', () => {
  const { getDriver } = require('../drivers');

  test('getDriver("elegoo-centauri2") returns the CC2 driver', () => {
    const driver = getDriver('elegoo-centauri2');
    expect(typeof driver.getStatus).toBe('function');
    expect(typeof driver.uploadAndPrint).toBe('function');
    expect(typeof driver.cancelJob).toBe('function');
    expect(typeof driver.checkIfPrinting).toBe('function');
    expect(typeof driver.testConnection).toBe('function');
  });
});
