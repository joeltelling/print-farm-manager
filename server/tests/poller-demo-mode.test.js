const Database = require('better-sqlite3');
const { isLocalSimulatorHost } = require('../poller');

describe('DEMO_MODE local simulator host filter', () => {
  test('recognizes loopback hosts used by Virtual Klipper Printer', () => {
    expect(isLocalSimulatorHost('127.0.0.1')).toBe(true);
    expect(isLocalSimulatorHost('localhost')).toBe(true);
    expect(isLocalSimulatorHost('http://127.0.0.1/')).toBe(true);
    expect(isLocalSimulatorHost('127.0.0.1:7125')).toBe(true);
    expect(isLocalSimulatorHost('192.168.1.101')).toBe(false);
    expect(isLocalSimulatorHost('')).toBe(false);
  });

  test('DEMO_MODE tick polls only klipper printers', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE printers (
        id INTEGER PRIMARY KEY,
        name TEXT,
        ip TEXT,
        type TEXT,
        status TEXT,
        is_active INTEGER,
        is_held INTEGER DEFAULT 0
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        printer_id INTEGER,
        status TEXT,
        started_at INTEGER
      );
    `);
    // Both on loopback (seed points every printer at the simulator), but only
    // the Klipper row should be polled while DEMO_MODE freezes the rest.
    db.prepare(
      "INSERT INTO printers (id, name, ip, type, status, is_active) VALUES (1, 'Fake', '127.0.0.1', 'prusa', 'PRINTING', 1)"
    ).run();
    db.prepare(
      "INSERT INTO printers (id, name, ip, type, status, is_active) VALUES (2, 'Sim', '127.0.0.1', 'klipper', 'IDLE', 1)"
    ).run();

    process.env.DEMO_MODE = 'true';
    jest.resetModules();
    jest.doMock('../drivers', () => ({
      getDriver: () => ({
        getStatus: jest.fn(async (printer) => {
          if (printer.type !== 'klipper') throw new Error('should not poll non-klipper printers in DEMO_MODE');
          return { status: 'IDLE', progress: null, timeRemaining: null };
        }),
      }),
    }));
    const PrinterPoller = require('../poller');
    const poller = new PrinterPoller(db);
    await poller._tick();

    const fake = db.prepare('SELECT status FROM printers WHERE id = 1').get();
    const sim = db.prepare('SELECT status FROM printers WHERE id = 2').get();
    expect(fake.status).toBe('PRINTING');
    expect(sim.status).toBe('IDLE');

    delete process.env.DEMO_MODE;
    jest.resetModules();
    jest.dontMock('../drivers');
    db.close();
  });
});
