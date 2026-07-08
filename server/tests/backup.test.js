// Guards the graceful-shutdown fix: backup.whenIdle() must not resolve while an
// online backup (db.backup) is in flight, so shutdown never closes the DB or exits
// mid-copy and leaves a corrupt snapshot.

const backup = require('../backup');

describe('backup.whenIdle', () => {
  test('waits for an in-flight backup before resolving', async () => {
    let release;
    // Controllable db.backup: stays pending until we release it.
    const fakeDb = { backup: () => new Promise((r) => { release = r; }) };

    const running = backup.runBackup(fakeDb); // in flight — intentionally not awaited
    let idle = false;
    const idleP = backup.whenIdle().then(() => { idle = true; });

    // Let microtasks flush; whenIdle must still be pending while db.backup is.
    await new Promise((r) => setImmediate(r));
    expect(idle).toBe(false);

    release();          // db.backup resolves
    await running;      // runBackup finishes, clears the active handle
    await idleP;
    expect(idle).toBe(true);
  });

  test('resolves immediately when no backup is running', async () => {
    await expect(backup.whenIdle()).resolves.toBeUndefined();
  });

  test('does not start a second backup while one is in flight (prevents overlap)', async () => {
    let release;
    let calls = 0;
    const fakeDb = { backup: () => { calls++; return new Promise((r) => { release = r; }); } };

    const first = backup.runBackup(fakeDb); // in flight — db.backup called once
    await backup.runBackup(fakeDb);         // must skip immediately, not call db.backup again
    expect(calls).toBe(1);

    release();
    await first;
    // whenIdle is now accurate because _active was never overwritten by an overlapping run.
    await expect(backup.whenIdle()).resolves.toBeUndefined();
  });
});
