const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// Boots the REAL server (server/index.js) as a child process on a temporary database and a
// stub client build, then makes real HTTP requests. Route tests mount each router on a
// throwaway Express app, so nothing else exercises index.js itself: startup, the static and
// SPA-fallback handling, the security headers, the inline operator endpoints, or how the app
// behaves after an Express upgrade. This is the second deliberate exception to "tests never
// use the real server" in CLAUDE.md, made safe by running it as a child with its own PFM_*
// directories (server/paths.js) so it can never touch real data, and DEMO_MODE so it never
// polls a printer.
const REPO_ROOT = path.join(__dirname, '..', '..');
const STARTUP_TIMEOUT_MS = 30000;

let child;
let baseUrl;
let logs = '';
let scratch;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntilUp() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}):\n${logs}`);
    try { const r = await fetch(`${baseUrl}/api/settings`); if (r.ok) return; } catch (_) { /* not listening yet */ }
    await sleep(150);
  }
  throw new Error(`server did not become ready within ${STARTUP_TIMEOUT_MS} ms:\n${logs}`);
}

const get = (p, init) => fetch(baseUrl + p, init);
const send = (method, p, body) => fetch(baseUrl + p, body === undefined ? { method } : {
  method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(process.env.PFM_TEST_ROOT || os.tmpdir(), 'smoke-'));
  const dist = path.join(scratch, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>pfm-smoke-index</title><div id="root"></div>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log("pfm-smoke-asset");');

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DEMO_MODE: 'true',
    PFM_DATA_DIR: path.join(scratch, 'data'), PFM_GCODE_DIR: path.join(scratch, 'gcode'), PFM_CLIENT_DIST: dist };
  for (const k of Object.keys(env)) if (k.startsWith('JEST_')) delete env[k]; // the child is a normal server, not a test
  child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.js')], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  await waitUntilUp();
}, STARTUP_TIMEOUT_MS + 5000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, sleep(5000)]);
  }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe('server startup', () => {
  it('starts cleanly with no fatal errors and reports it is listening', () => {
    expect(logs).toMatch(/Express running on/);
    expect(logs).not.toMatch(/\[FATAL\]|Cannot find module|ERR_/);
  });

  it('created its database and backup in its own data directory, not the real one', () => {
    expect(fs.existsSync(path.join(scratch, 'data', 'farm.db'))).toBe(true);
  });
});

describe('static client and SPA fallback', () => {
  it('serves index.html at /', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('pfm-smoke-index');
  });

  it.each(['/fleet', '/printers/2', '/jobs?status=failed'])('serves index.html for the client route %s (deep link)', async (route) => {
    const res = await get(route);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('pfm-smoke-index');
  });

  it('serves built assets as their real type', async () => {
    const res = await get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toContain('pfm-smoke-asset');
  });

  it('does not answer an unknown /api route with the client page', async () => {
    const res = await get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('pfm-smoke-index');
  });
});

describe('security headers', () => {
  it('sends the hardening headers and hides X-Powered-By', async () => {
    const res = await get('/');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('API on a fresh database', () => {
  it('returns the default settings and empty collections', async () => {
    const settings = await (await get('/api/settings')).json();
    expect(settings.dispatch_batch_size).toBe('10');
    expect(await (await get('/api/printers')).json()).toEqual([]);
    expect(await (await get('/api/projects')).json()).toEqual([]);
    expect(await (await get('/api/jobs')).json()).toEqual([]);
    expect(await (await get('/api/notifications')).json()).toEqual([]);
  });

  it('returns JSON 404s for missing rows', async () => {
    const res = await get('/api/printers/9999');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Printer not found' });
  });
});

describe('request bodies (the Express 4 to 5 difference, through the real app)', () => {
  it.each([
    ['POST', '/api/printers/set-ready-batch', 'ids array required'],
    ['POST', '/api/models', 'model_id, label, and connector are required'],
    ['POST', '/api/projects', 'name is required'],
  ])('%s %s with no body answers its documented 400, not a 500', async (method, route, message) => {
    const res = await send(method, route);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(message);
  });

  it('answers 400 for an empty JSON object and for malformed JSON', async () => {
    expect((await send('POST', '/api/projects', {})).status).toBe(400);
    expect((await send('POST', '/api/projects', '{bad')).status).toBe(400);
  });
});

describe('inline operator endpoints registered in index.js', () => {
  it('walks a printer through create, bulk set-ready, and 404s on missing ids', async () => {
    expect((await send('POST', '/api/models', { model_id: 'mk4s', label: 'MK4S', connector: 'prusa' })).status).toBe(201);
    const created = await send('POST', '/api/printers', { name: 'smoke-01', ip: '10.255.255.1', api_key: 'k', type: 'prusa', model: 'mk4s' });
    expect(created.status).toBe(201);
    const printer = await created.json();

    const list = await (await get('/api/printers')).json();
    expect(list.map((p) => p.name)).toEqual(['smoke-01']);

    const batch = await send('POST', '/api/printers/set-ready-batch', { ids: [printer.id] });
    expect(batch.status).toBe(200);
    expect(await batch.json()).toEqual({ ok: true, count: 1 });

    expect((await send('POST', '/api/printers/9999/set-ready', {})).status).toBe(404);
    expect((await send('POST', '/api/printers/9999/recommission', {})).status).toBe(404);
    expect((await send('DELETE', '/api/notifications/9999')).status).toBe(404);
  });

  it('accepts a manual dispatch sweep', async () => {
    const res = await send('POST', '/api/scheduler/dispatch', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
