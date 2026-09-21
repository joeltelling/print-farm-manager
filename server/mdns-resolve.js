// Resolves .local (mDNS) hostnames to an IPv4 address before a driver connects.
//
// The published Docker image has no OS-level mDNS resolver (no avahi/nss-mdns), so a
// printer configured with a .local name connects fine from a browser on the host but
// times out from inside the container: the OS-level DNS lookup axios/mqtt/net make for
// a .local name simply has nowhere to send that query. This does the mDNS lookup itself,
// over UDP multicast, instead of relying on the OS resolver, so .local names resolve
// the same way whether the app runs on Windows/macOS or in the container.
//
// Any hostname that doesn't end in .local is returned unchanged: this only ever
// activates for the one case the OS resolver can't already handle. A .local name that
// fails to resolve (mDNS blocked on this network, printer offline, no response within
// the timeout) is also returned unchanged, so callers see exactly the same failure mode
// they already handle (a failed connection to a hostname), not a new error shape.
//
// Reference: https://github.com/mafintosh/multicast-dns

const CACHE_TTL_MS = 5 * 60 * 1000; // printer addresses rarely change; avoid a query every poll
const QUERY_TIMEOUT_MS = 3000; // bounded well under the ~8s driver timeout budget

const cache = new Map(); // lowercased hostname → { ip, expiresAt }
const inFlight = new Map(); // lowercased hostname → Promise<string>, dedupes concurrent lookups

// Constructing multicast-dns() opens a real UDP socket. Every driver requires this
// module, so creating that socket eagerly at require() time would mean just loading
// a driver opens a network socket, even for an install with no .local printer and
// even inside a test run that mocks the transport but not this module. Created lazily,
// on the first hostname that actually needs resolving.
let mdns = null;
function getMdns() {
  if (!mdns) mdns = require('multicast-dns')();
  return mdns;
}

function extractHostname(raw) {
  return String(raw).trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

function queryOnce(hostname) {
  const mdns = getMdns();
  return new Promise((resolve, reject) => {
    const onResponse = (response) => {
      const answer = (response.answers || []).find(
        (a) => a.type === 'A' && a.name.toLowerCase() === hostname.toLowerCase()
      );
      if (!answer) return;
      clearTimeout(timer);
      mdns.removeListener('response', onResponse);
      resolve(answer.data);
    };

    const timer = setTimeout(() => {
      mdns.removeListener('response', onResponse);
      reject(new Error(`mDNS query for ${hostname} timed out`));
    }, QUERY_TIMEOUT_MS);

    mdns.on('response', onResponse);
    mdns.query({ questions: [{ name: hostname, type: 'A' }] });
  });
}

// Takes a printer.ip-shaped string (bare hostname, "host:port", or a protocol-prefixed
// value, whatever shape a driver already accepts) and returns the same shape with a
// .local hostname swapped for its resolved IPv4 address. Never throws.
async function resolveHost(raw) {
  const hostname = extractHostname(raw);
  if (!/\.local$/i.test(hostname)) return raw;

  const key = hostname.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return raw.replace(hostname, cached.ip);
  }

  let pending = inFlight.get(key);
  if (!pending) {
    pending = queryOnce(hostname).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }

  try {
    const ip = await pending;
    cache.set(key, { ip, expiresAt: Date.now() + CACHE_TTL_MS });
    return raw.replace(hostname, ip);
  } catch (_) {
    return raw;
  }
}

module.exports = { resolveHost };
