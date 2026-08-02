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

function getDriver(type) {
  const load = LOADERS[type];
  if (!load) throw new Error(`No driver registered for printer type: "${type}"`);
  return load();
}

// Closes and forgets any persistent connection (Bambu MQTT, Elegoo Centauri
// websocket) held for this printer. Stateless request/response drivers
// (Prusa, Klipper, OctoPrint) have no dropConnection export, so this is a
// no-op for them. Best-effort: an unregistered or unknown printer type must
// never block the decommission or delete flow that calls this.
function dropConnection(printer) {
  try {
    getDriver(printer.type).dropConnection?.(printer.id);
  } catch (_) {}
}

module.exports = { getDriver, dropConnection };
