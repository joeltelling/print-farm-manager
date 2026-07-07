// Driver registry — maps printer.type → driver module.
// Each driver implements: getStatus, uploadAndPrint, cancelJob, checkIfPrinting.
// Add a new entry here when a new printer brand is supported.
//
// Drivers are loaded lazily (on first getDriver call for that type) so that
// optional native dependencies (e.g. sdcp → mqtt-server) are only required
// when a printer of that brand is actually present.

const LOADERS = {
  'prusa':            () => require('./prusa'),
  'elegoo-centauri':  () => require('./elegoo-centauri'),
  'elegoo-centauri2': () => require('./elegoo-centauri2'),
  'bambu':            () => require('./bambu'),
  'klipper':          () => require('./klipper'),
  'octoprint':        () => require('./octoprint'),
};

// Memoize loaded driver modules so we can reach the ones that hold live
// connections (Bambu/Elegoo) for teardown. require() already caches by path,
// so this only tracks *which* drivers have been loaded this process.
const instances = {};

function getDriver(type) {
  if (instances[type]) return instances[type];
  const load = LOADERS[type];
  if (!load) throw new Error(`No driver registered for printer type: "${type}"`);
  instances[type] = load();
  return instances[type];
}

// Drop a single printer's persistent connection (if its driver keeps one and is
// loaded). Safe no-op for stateless drivers (Prusa/Klipper/OctoPrint) and for
// drivers never loaded this process. Called when a printer is deleted or
// decommissioned so its socket + reconnect loop don't live on forever.
function dropConnection(printer) {
  const drv = instances[printer.type];
  try { drv?.dropConnection?.(printer.id); } catch (_) {}
}

// Close every live connection across all loaded drivers — called on graceful
// shutdown so reconnect timers don't keep the process alive.
function closeAllConnections() {
  for (const [type, drv] of Object.entries(instances)) {
    try { drv.closeAll?.(); } catch (err) {
      console.error(`[drivers] closeAll failed for "${type}": ${err.message}`);
    }
  }
}

module.exports = { getDriver, dropConnection, closeAllConnections };
