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
  ['/erp/customers', 'erp-customers.png'],
  ['/erp/quotes', 'erp-quotes.png'],
  ['/erp/delivery-notes', 'erp-delivery-notes.png'],
  ['/erp/invoices', 'erp-invoices.png'],
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
      ['To Do', 'amber', 0],
      ['In Progress', 'violet', 1],
      ['Review', 'cyan', 2],
      ['Done', 'lime', 3],
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
      [byTitle['To Do'], 'Recalibrate MK4S_07', 'Bed mesh off after nozzle change', 0],
      [byTitle['To Do'], 'Order black PETG', 'SKU RAW-PETG-BLK, 5 kg', 1],
      [byTitle['In Progress'], 'Benchy Fleet plate 3', 'Waiting on sign-off for MK4S_03', 0],
      [byTitle.Review, 'Gridfinity bins QA', 'Check wall thickness on first plate', 0],
      [byTitle.Done, 'Sync ERP from shopfloor', 'Done after morning sweep', 0],
    ];
    for (const [colId, title, body, order] of samples) {
      if (colId) insCard.run(colId, title, body, order, now, now);
    }
  }

  const checklist = db.prepare(
    "SELECT id FROM notebook_pages WHERE title = 'Shift checklist' AND trashed_at IS NULL"
  ).get();
  if (!checklist) {
    db.prepare(`
      INSERT INTO notebook_pages (title, body, accent, trashed_at, created_at, updated_at)
      VALUES (?, ?, 'lime', NULL, ?, ?)
    `).run(
      'Shift checklist',
      [
        '1. Sweep Idle printers',
        '2. Confirm holds on Fleet (Set Ready / Bad Print)',
        '3. Check Calendar for active closures',
        '4. Sync ERP if there are new parts',
        '5. Log any issues in this notebook',
        '',
        'Notes:',
        '- Voron_02 camera: Moonraker URL ok',
        '- AMS slot 2 = PETG Signal Red',
      ].join('\n'),
      now,
      now,
    );
  }
  // Drop empty auto-created "New note" leftovers so the checklist is the first row.
  db.prepare(`
    DELETE FROM notebook_pages
    WHERE title = 'New note' AND (body IS NULL OR body = '') AND trashed_at IS NULL
  `).run();
}

/** Seed customers + Presupuesto / Albaran / Factura so Ventas gallery shots are not empty. */
function seedSalesDocsDemo(db) {
  // Tables may be missing on a very old seed file until the server has migrated once.
  const has = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'customer'"
  ).get();
  if (!has) return;

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  let customer = db.prepare("SELECT id FROM customer WHERE name = 'Acme Prototipos SL'").get();
  if (!customer) {
    const r = db.prepare(`
      INSERT INTO customer
        (name, tax_id, email, phone, address, city, postal_code, country, notes, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      'Acme Prototipos SL', 'B12345678', 'compras@acme.example', '+34 600 000 000',
      'Calle Industria 12', 'Madrid', '28001', 'ES', 'Cliente demo para capturas README',
      now, now,
    );
    customer = { id: r.lastInsertRowid };
  }

  const docCount = db.prepare('SELECT COUNT(*) AS n FROM sales_doc').get().n;
  if (docCount > 0) return;

  // Ensure counters exist and start after the demo numbers we insert.
  for (const t of ['quote', 'delivery', 'invoice']) {
    const row = db.prepare('SELECT next_seq FROM doc_counter WHERE doc_type = ?').get(t);
    if (!row) {
      db.prepare('INSERT INTO doc_counter (doc_type, next_seq) VALUES (?, 2)').run(t);
    } else if (row.next_seq < 2) {
      db.prepare('UPDATE doc_counter SET next_seq = 2 WHERE doc_type = ?').run(t);
    }
  }

  const insDoc = db.prepare(`
    INSERT INTO sales_doc
      (doc_type, doc_number, customer_id, status, issue_date, due_date, notes,
       subtotal, tax_total, total, source_doc_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const insLine = db.prepare(`
    INSERT INTO sales_doc_line
      (doc_id, item_id, sku, description, qty, unit_price, tax_rate, line_total, job_id, posting_id, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `);

  function addDoc(docType, docNumber, status, lines, notes) {
    const subtotal = lines.reduce((s, l) => s + l.qty * l.unit_price, 0);
    const tax_total = lines.reduce((s, l) => s + l.qty * l.unit_price * (l.tax_rate / 100), 0);
    const total = subtotal + tax_total;
    const r = insDoc.run(
      docType, docNumber, customer.id, status, today, today, notes,
      subtotal, tax_total, total, now, now,
    );
    const docId = r.lastInsertRowid;
    lines.forEach((l, i) => {
      insLine.run(
        docId, l.sku || null, l.description, l.qty, l.unit_price, l.tax_rate,
        l.qty * l.unit_price, now + i,
      );
    });
  }

  addDoc('quote', 'PRE-000001', 'confirmed', [
    { sku: 'FG-BRACKET', description: 'Bracket x10 (Benchy Fleet)', qty: 10, unit_price: 4.5, tax_rate: 21 },
    { sku: null, description: 'Envio peninsular', qty: 1, unit_price: 8, tax_rate: 21 },
  ], 'Presupuesto confirmado demo');

  addDoc('delivery', 'ALB-000001', 'confirmed', [
    { sku: 'FG-BRACKET', description: 'Bracket x10 (Benchy Fleet)', qty: 10, unit_price: 4.5, tax_rate: 21 },
  ], 'Albaran desde posting de shopfloor');

  addDoc('invoice', 'FAC-000001', 'draft', [
    { sku: 'FG-BRACKET', description: 'Bracket x10 (Benchy Fleet)', qty: 10, unit_price: 4.5, tax_rate: 21 },
    { sku: null, description: 'Envio peninsular', qty: 1, unit_price: 8, tax_rate: 21 },
  ], 'Factura borrador lista para confirmar');
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
    try { seedSalesDocsDemo(db); } catch (err) {
      console.warn('[capture] sales-docs seed skipped:', err.message);
    }
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
              .find(b => /Shift checklist/.test(b.innerText));
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
