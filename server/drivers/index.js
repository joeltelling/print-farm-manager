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

// Drivers that have actually been loaded this process. Used by dropConnection
// so it never forces a lazy driver to load just to tell it "forget printer N".
const loaded = new Map();

function getDriver(type) {
  const load = LOADERS[type];
  if (!load) throw new Error(`No driver registered for printer type: "${type}"`);
  if (!loaded.has(type)) loaded.set(type, load());
  return loaded.get(type);
}

// Tell a driver to discard any cached connection state for one printer.
// Persistent-connection drivers (bambu, elegoo-centauri, elegoo-centauri2) keep a
// module-level Map of printer.id to a live client that reconnects on its own with
// the credentials it was created with. Callers must invoke this whenever a printer's
// connection settings change (ip, api_key, serial_number, type) or the row leaves
// active duty (delete, decommission), or the stale client shadows the new settings
// until the next server restart.
// Safe to call for any type: request/response drivers simply have no dropConnection.
function dropConnection(type, printerId) {
  const driver = loaded.get(type);
  if (driver && typeof driver.dropConnection === 'function') {
    driver.dropConnection(printerId);
  }
}

module.exports = { getDriver, dropConnection };
