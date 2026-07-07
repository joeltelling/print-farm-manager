// Verifies the driver registry (server/drivers/index.js): getDriver memoization
// and unknown-type error, plus the connection-teardown dispatch added for Tier 1
// (dropConnection on printer removal, closeAllConnections on shutdown).

// Mock the Bambu driver so we can observe teardown dispatch without real MQTT.
jest.mock('../drivers/bambu', () => ({
  getStatus: jest.fn(),
  uploadAndPrint: jest.fn(),
  cancelJob: jest.fn(),
  checkIfPrinting: jest.fn(),
  dropConnection: jest.fn(),
  closeAll: jest.fn(),
}));

const bambu = require('../drivers/bambu');
const drivers = require('../drivers');

describe('driver registry', () => {
  beforeEach(() => jest.clearAllMocks());

  test('getDriver returns the driver module and memoizes it', () => {
    const a = drivers.getDriver('bambu');
    const b = drivers.getDriver('bambu');
    expect(a).toBe(bambu);
    expect(b).toBe(a);
  });

  test('getDriver throws for an unknown type', () => {
    expect(() => drivers.getDriver('nope')).toThrow(/No driver registered/);
  });

  test('dropConnection dispatches to the loaded driver with the printer id', () => {
    drivers.getDriver('bambu'); // ensure loaded
    drivers.dropConnection({ id: 42, type: 'bambu' });
    expect(bambu.dropConnection).toHaveBeenCalledWith(42);
  });

  test('dropConnection is a safe no-op for a stateless / never-loaded driver', () => {
    // 'prusa' has no dropConnection export and isn't loaded here — must not throw.
    expect(() => drivers.dropConnection({ id: 1, type: 'prusa' })).not.toThrow();
    expect(bambu.dropConnection).not.toHaveBeenCalled();
  });

  test('closeAllConnections calls closeAll on every loaded driver', () => {
    drivers.getDriver('bambu');
    drivers.closeAllConnections();
    expect(bambu.closeAll).toHaveBeenCalledTimes(1);
  });
});
