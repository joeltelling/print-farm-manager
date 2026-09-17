#!/usr/bin/env node
// One-shot README screenshot helper. Mints a short-lived session in seed-data.db,
// drives headless Chromium via CDP, writes PNGs to docs/images/, then deletes the
// session. Not part of the runtime app; run manually when refreshing the gallery.
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createSession } = require('../server/auth');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
const DB = path.join(ROOT, 'server', 'data', 'seed-data.db');
const PAGES = [
  ['/', 'dashboard.png'],
  ['/fleet', 'fleet.png'],
  ['/projects', 'projects.png'],
  ['/jobs', 'jobs.png'],
  ['/calendar', 'calendar.png'],
  ['/timelapses', 'timelapses.png'],
  ['/printers', 'printers.png'],
  ['/workspace', 'workspace-board.png'],
  ['/workspace/bloc', 'workspace-notebook.png'],
  ['/erp', 'erp-dashboard.png'],
  ['/erp/inventory', 'erp-inventory.png'],
  ['/erp/sales', 'erp-sales.png'],
  ['/erp/ebay', 'erp-ebay.png'],
  ['/erp/postings', 'erp-postings.png'],
  ['/settings', 'settings.png'],
];

/** Seed board cards + a notebook page so gallery shots are not empty. */
function seedWorkspaceDemo(db) {
  const now = Date.now();
  const colCount = db.prepare('SELECT COUNT(*) AS n FROM workspace_columns').get().n;
  if (colCount === 0) {
    const ins = db.prepare(`
      INSERT INTO workspace_columns (title, accent, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    [
      ['Pendiente', 'amber', 0],
      ['En curso', 'violet', 1],
      ['A revisar', 'cyan', 2],
      ['Hecho', 'lime', 3],
    ].forEach(([title, accent, order]) => ins.run(title, accent, order, now, now));
  }

  const cols = db.prepare('SELECT id, title FROM workspace_columns ORDER BY sort_order').all();
  const byTitle = Object.fromEntries(cols.map(c => [c.title, c.id]));
  const cardCount = db.prepare('SELECT COUNT(*) AS n FROM workspace_cards').get().n;
  // Gallery wants a populated board. Top up when the seed DB is sparse.
  if (cardCount < 4) {
    db.prepare('DELETE FROM workspace_cards').run();
    const insCard = db.prepare(`
      INSERT INTO workspace_cards (column_id, title, body, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const samples = [
      [byTitle.Pendiente, 'Recalibrar MK4S_07', 'Bed mesh off after nozzle change', 0],
      [byTitle.Pendiente, 'Pedir PETG negro', 'SKU RAW-PETG-BLK, 5 kg', 1],
      [byTitle['En curso'], 'Benchy Fleet plate 3', 'Waiting on sign-off for MK4S_03', 0],
      [byTitle['A revisar'], 'Gridfinity bins QA', 'Check wall thickness on first plate', 0],
      [byTitle.Hecho, 'Sync ERP from shopfloor', 'Done after morning sweep', 0],
    ];
    for (const [colId, title, body, order] of samples) {
      if (colId) insCard.run(colId, title, body, order, now, now);
    }
  }

  const checklist = db.prepare(
    "SELECT id FROM notebook_pages WHERE title = 'Checklist de turno' AND trashed_at IS NULL"
  ).get();
  if (!checklist) {
    db.prepare(`
      INSERT INTO notebook_pages (title, body, accent, trashed_at, created_at, updated_at)
      VALUES (?, ?, 'lime', NULL, ?, ?)
    `).run(
      'Checklist de turno',
      [
        '1. Sweep Idle printers',
        '2. Confirmar holds en Fleet (Set Ready / Bad Print)',
        '3. Revisar Calendar por cierres activos',
        '4. Sync ERP si hay piezas nuevas',
        '5. Anotar incidencias en este bloc',
        '',
        'Notas:',
        '- Voron_02 camara: URL Moonraker ok',
        '- AMS slot 2 = PETG Signal Red',
      ].join('\n'),
      now,
      now,
    );
  }
  // Drop empty auto-created "Nota nueva" leftovers so the checklist is the first row.
  db.prepare(`
    DELETE FROM notebook_pages
    WHERE title = 'Nota nueva' AND (body IS NULL OR body = '') AND trashed_at IS NULL
  `).run();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJson(url, retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const body = await new Promise((resolve, reject) => {
        http.get(url, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d));
        }).on('error', reject);
      });
      return JSON.parse(body);
    } catch {
      await sleep(200);
    }
  }
  throw new Error('CDP not ready: ' + url);
}

function connectWs(wsUrl) {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const pending = new Map();
    let nextId = 1;

    function encode(payload) {
      const data = Buffer.from(payload);
      const mask = crypto.randomBytes(4);
      let header;
      if (data.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | data.length;
      } else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
      }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      return Buffer.concat([header, mask, masked]);
    }

    function send(method, params = {}) {
      const id = nextId++;
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timeout ' + method)), 45000);
        pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej });
        sock.write(encode(JSON.stringify({ id, method, params })));
      });
    }

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        upgraded = true;
        buf = buf.slice(idx + 4);
        resolve({ send, sock });
      }
      while (true) {
        if (buf.length < 2) break;
        const lenByte = buf[1] & 0x7f;
        let header = 2;
        let len = lenByte;
        if (lenByte === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          header = 4;
        } else if (lenByte === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          header = 10;
        }
        if (buf.length < header + len) break;
        const payload = buf.slice(header, header + len);
        buf = buf.slice(header + len);
        try {
          const msg = JSON.parse(payload.toString());
          if (msg.id && pending.has(msg.id)) {
            const { res } = pending.get(msg.id);
            pending.delete(msg.id);
            res(msg);
          }
        } catch (_) {}
      }
    });
    sock.on('error', reject);
  });
}

async function waitForApp(pageWs) {
  for (let i = 0; i < 40; i++) {
    const ev = await pageWs.send('Runtime.evaluate', {
      expression: `(() => {
        try { sessionStorage.setItem('coma.boot.done', '1'); } catch (_) {}
        const main = document.getElementById('main') || document.getElementById('main-inner');
        const login = document.body && document.body.innerText.includes('Sign in');
        const splash = document.body && document.body.innerText.includes('CoreManufacturing')
          && !main;
        return { hasMain: !!main, login: !!login, splash: !!splash,
          text: (document.body && document.body.innerText || '').slice(0, 80) };
      })()`,
      returnByValue: true,
    });
    const v = ev.result?.result?.value;
    if (v && v.hasMain) return v;
    await sleep(400);
  }
  throw new Error('app shell did not become ready');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync('/tmp/coma-readme-shots', { recursive: true, force: true });

  const db = new Database(DB);
  try {
    seedWorkspaceDemo(db);
  } catch (err) {
    console.warn('[capture] workspace seed skipped:', err.message);
  }
  const token = createSession(db);

  const chrome = spawn('chromium-browser', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1400,900', '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/coma-readme-shots', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let failed = false;
  try {
    await getJson('http://127.0.0.1:9222/json/version');
    const list = await getJson('http://127.0.0.1:9222/json/list');
    const page = list.find(p => p.type === 'page');
    if (!page) throw new Error('no page target');
    const pageWs = await connectWs(page.webSocketDebuggerUrl);

    await pageWs.send('Emulation.setDeviceMetricsOverride', {
      width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await pageWs.send('Network.enable');
    await pageWs.send('Network.setCookie', {
      name: 'coma_session', value: token, url: 'http://127.0.0.1:5173/', path: '/', httpOnly: true,
    });
    await pageWs.send('Network.setCookie', {
      name: 'coma_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true,
    });
    await pageWs.send('Page.enable');

    // Prime sessionStorage so BootSplash is skipped on subsequent navigations.
    await pageWs.send('Page.navigate', { url: 'http://127.0.0.1:5173/' });
    await waitForApp(pageWs);

    for (const [route, file] of PAGES) {
      process.stdout.write(`capturing ${route} -> ${file} ... `);
      await pageWs.send('Page.navigate', { url: `http://127.0.0.1:5173${route}` });
      await waitForApp(pageWs);
      if (route === '/workspace/bloc') {
        await sleep(400);
        await pageWs.send('Runtime.evaluate', {
          expression: `(() => {
            const btn = [...document.querySelectorAll('button')]
              .find(b => /Checklist de turno/.test(b.innerText));
            if (btn) btn.click();
            return !!btn;
          })()`,
          returnByValue: true,
        });
        await sleep(600);
      }
      await sleep(800);
      const shot = await pageWs.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.result.data, 'base64');
      fs.writeFileSync(path.join(OUT, file), buf);
      console.log(`${(buf.length / 1024).toFixed(0)} KB`);
    }

    // Login screen: drop cookies and capture AuthGate.
    await pageWs.send('Network.deleteCookies', { name: 'coma_session', url: 'http://127.0.0.1:5173/' });
    await pageWs.send('Network.deleteCookies', { name: 'coma_session', domain: '127.0.0.1' });
    process.stdout.write('capturing login -> login.png ... ');
    await pageWs.send('Page.navigate', { url: 'http://127.0.0.1:5173/?logout=1' });
    await sleep(2000);
    // Force reload without cookie
    await pageWs.send('Page.navigate', { url: 'http://127.0.0.1:5173/' });
    for (let i = 0; i < 20; i++) {
      const ev = await pageWs.send('Runtime.evaluate', {
        expression: `document.body && /Sign in|Create your account|Sign in to/.test(document.body.innerText)`,
        returnByValue: true,
      });
      if (ev.result?.result?.value) break;
      await sleep(300);
    }
    await sleep(500);
    const loginShot = await pageWs.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'login.png'), Buffer.from(loginShot.result.data, 'base64'));
    console.log('ok');

    pageWs.sock.end();
  } catch (err) {
    failed = true;
    console.error(err);
  } finally {
    try { db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token); } catch (_) {}
    db.close();
    chrome.kill('SIGKILL');
  }
  process.exit(failed ? 1 : 0);
}

main();
