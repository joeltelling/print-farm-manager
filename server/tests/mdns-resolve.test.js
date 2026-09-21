// Unit tests for server/mdns-resolve.js
// multicast-dns is mocked: no real UDP socket, no real network needed.

const EventEmitter = require('events');

let mockMdns;
let currentQuery; // the questions array from the last mdns.query() call

jest.mock('multicast-dns', () => {
  return jest.fn(() => mockMdns);
});

beforeEach(() => {
  jest.resetModules();
  mockMdns = new EventEmitter();
  mockMdns.query = jest.fn((q) => { currentQuery = q.questions; });
  currentQuery = null;
});

function respond(name, ip) {
  mockMdns.emit('response', {
    answers: [{ name, type: 'A', class: 'IN', ttl: 120, data: ip }],
  });
}

// ─── Passthrough for non-.local values ────────────────────────────────────────

describe('resolveHost: passthrough', () => {
  test('returns a plain IP unchanged without ever constructing multicast-dns', async () => {
    const mdnsFactory = require('multicast-dns');
    const { resolveHost } = require('../mdns-resolve');
    const result = await resolveHost('192.168.1.50');
    expect(result).toBe('192.168.1.50');
    expect(mdnsFactory).not.toHaveBeenCalled();
  });

  test('returns a plain DNS hostname unchanged', async () => {
    const { resolveHost } = require('../mdns-resolve');
    const result = await resolveHost('octoprint.lan:5000');
    expect(result).toBe('octoprint.lan:5000');
  });
});

// ─── .local resolution ─────────────────────────────────────────────────────────

describe('resolveHost: .local resolution', () => {
  test('queries mDNS for an A record and substitutes the resolved IP', async () => {
    const { resolveHost } = require('../mdns-resolve');
    const promise = resolveHost('octoprint.local');
    respond('octoprint.local', '192.168.1.77');
    expect(await promise).toBe('192.168.1.77');
    expect(currentQuery).toEqual([{ name: 'octoprint.local', type: 'A' }]);
  });

  test('preserves a port suffix when substituting the resolved IP', async () => {
    const { resolveHost } = require('../mdns-resolve');
    const promise = resolveHost('octoprint.local:5000');
    respond('octoprint.local', '192.168.1.77');
    expect(await promise).toBe('192.168.1.77:5000');
  });

  test('ignores a response for a different hostname', async () => {
    const { resolveHost } = require('../mdns-resolve');
    const promise = resolveHost('voron.local');
    respond('someone-elses-printer.local', '10.0.0.1');
    respond('voron.local', '10.0.0.2');
    expect(await promise).toBe('10.0.0.2');
  });

  test('caches a resolved hostname so a second lookup does not query mDNS again', async () => {
    const { resolveHost } = require('../mdns-resolve');
    const first = resolveHost('octoprint.local');
    respond('octoprint.local', '192.168.1.77');
    await first;

    mockMdns.query.mockClear();
    const result = await resolveHost('octoprint.local');
    expect(result).toBe('192.168.1.77');
    expect(mockMdns.query).not.toHaveBeenCalled();
  });

  test('is case-insensitive matching the response name against the query', async () => {
    const { resolveHost } = require('../mdns-resolve');
    const promise = resolveHost('OctoPrint.Local');
    respond('octoprint.local', '192.168.1.77');
    expect(await promise).toBe('192.168.1.77');
  });

  test('falls back to the original value when the query times out', async () => {
    jest.useFakeTimers();
    const { resolveHost } = require('../mdns-resolve');
    const promise = resolveHost('unreachable.local');
    jest.advanceTimersByTime(3100);
    await expect(promise).resolves.toBe('unreachable.local');
    jest.useRealTimers();
  });

  test('two concurrent lookups for the same hostname share one mDNS query', async () => {
    const { resolveHost } = require('../mdns-resolve');
    const a = resolveHost('shared.local');
    const b = resolveHost('shared.local');
    respond('shared.local', '10.0.0.5');
    expect(await a).toBe('10.0.0.5');
    expect(await b).toBe('10.0.0.5');
    expect(mockMdns.query).toHaveBeenCalledTimes(1);
  });
});
