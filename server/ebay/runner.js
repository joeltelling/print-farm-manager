/**
 * Background eBay sync loop: orders pull + inventory push.
 * Same start/stop pattern as poller.js / timelapse.js.
 */
const notifications = require('../notifications');
const { hasCredentials } = require('./credentials');
const { syncOrders } = require('./orders');
const { pushInventory } = require('./inventory');
const { getSyncState, setSyncState } = require('./client');

// Must exceed typical Fulfillment propagation delay; 5 minutes keeps sandbox
// load light while still catching new paid orders for operators within a shift.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

let _timer = null;
let _db = null;
let _running = false;
let _consecutiveFailures = 0;

async function _tick() {
  if (_running || !_db) return;
  if (process.env.DEMO_MODE === 'true') return;
  if (!hasCredentials(_db)) return;

  _running = true;
  try {
    const ordersResult = await syncOrders(_db);
    if (!ordersResult.ok) {
      _consecutiveFailures += 1;
      console.log('[ebay] order sync failed:', ordersResult.error);
    } else {
      console.log(
        `[ebay] orders synced: fetched=${ordersResult.fetched} auto=${ordersResult.auto_posted} queued=${ordersResult.queued}`
      );
    }

    const pushResult = await pushInventory(_db);
    if (!pushResult.ok) {
      _consecutiveFailures += 1;
      console.log('[ebay] inventory push had failures:', pushResult.fail_count);
    } else if (pushResult.ok_count > 0) {
      console.log(`[ebay] inventory pushed: ${pushResult.ok_count} listing(s)`);
      _consecutiveFailures = 0;
    } else if (ordersResult.ok) {
      _consecutiveFailures = 0;
    }

    if (_consecutiveFailures >= 3) {
      const lastErr = getSyncState(_db, 'last_orders_error')
        || getSyncState(_db, 'last_inventory_error')
        || 'eBay sync failing repeatedly';
      notifications.add(`eBay sync failing: ${lastErr}`);
      _consecutiveFailures = 0;
      setSyncState(_db, 'last_failure_notified_at', String(Date.now()));
    }
  } catch (err) {
    _consecutiveFailures += 1;
    console.log('[ebay] tick error:', err.message);
  } finally {
    _running = false;
  }
}

function start(db) {
  _db = db;
  if (_timer) return;
  if (process.env.DEMO_MODE === 'true') {
    console.log('[ebay] DEMO_MODE: background sync disabled');
    return;
  }
  if (!hasCredentials(db)) {
    console.log('[ebay] No credentials configured; background sync idle until credentials are saved');
  }
  console.log(`[ebay] Starting sync loop (interval: ${SYNC_INTERVAL_MS}ms)`);
  // Delay first tick slightly so server boot is not blocked by OAuth
  setTimeout(() => { _tick(); }, 15 * 1000);
  _timer = setInterval(() => { _tick(); }, SYNC_INTERVAL_MS);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _db = null;
  _running = false;
}

module.exports = {
  SYNC_INTERVAL_MS,
  start,
  stop,
  _tick,
};
