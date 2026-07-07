#!/usr/bin/env node
'use strict';

// Builds the Windows portable bundle described in docs/packaging.md.
//   npm run build:portable   ->   dist/portable/PrintFarmManager/
//
// Must run on Windows x64 with Node 22.x. No C++ compiler required — the
// bundled better-sqlite3 (>= 12) ships a prebuilt Node 22 win-x64 binary.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = __dirname;

const NODE_VERSION = process.version;            // e.g. "v22.17.0" — pin bundle to build host
const NODE_PKG = `node-${NODE_VERSION}-win-x64`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_PKG}.zip`;

const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, '.cache');
const STAGING = path.join(DIST, '.staging');
const OUT = path.join(DIST, 'portable', 'PrintFarmManager');
const APP = path.join(OUT, 'app');

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

let step = 0;
function log(msg) { console.log(`\n[build ${++step}] ${msg}`); }
function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}
function npm(args, opts = {}) {
  // npm is a .cmd shim on Windows — invoke through the shell so it resolves.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit', shell: process.platform === 'win32', ...opts,
  });
}
function ps(command) {
  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]);
}

// --- 0. Guards ---------------------------------------------------------------
if (process.platform !== 'win32') {
  console.error('build:portable produces a Windows bundle and must run on Windows.');
  process.exit(1);
}
if (!NODE_VERSION.startsWith('v22.')) {
  console.error(
    `\nThis build must run on Node 22.x (found ${NODE_VERSION}).\n` +
    'The bundled runtime is pinned to the build host\'s Node version so the native\n' +
    'better-sqlite3 binary matches its ABI. Switch to Node 22 and re-run.\n'
  );
  process.exit(1);
}

console.log(`Building Print Farm Manager portable bundle`);
console.log(`  bundled Node runtime: ${NODE_VERSION} (win-x64)`);
console.log(`  output: ${OUT}`);

// --- 1. Clean output ---------------------------------------------------------
log('Cleaning output folder');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

// --- 2. Portable Node runtime ------------------------------------------------
const nodeZip = path.join(CACHE, `${NODE_PKG}.zip`);
const nodeExtract = path.join(CACHE, NODE_PKG);
if (!fs.existsSync(path.join(nodeExtract, 'node.exe'))) {
  log(`Downloading Node runtime — ${NODE_URL}`);
  ps(`Invoke-WebRequest -Uri '${NODE_URL}' -OutFile '${nodeZip}'`);
  log('Extracting Node runtime');
  fs.rmSync(nodeExtract, { recursive: true, force: true });
  ps(`Expand-Archive -Path '${nodeZip}' -DestinationPath '${CACHE}' -Force`);
} else {
  log('Node runtime already cached');
}
fs.mkdirSync(path.join(OUT, 'node'), { recursive: true });
fs.copyFileSync(path.join(nodeExtract, 'node.exe'), path.join(OUT, 'node', 'node.exe'));
const nodeLicense = path.join(nodeExtract, 'LICENSE');
if (fs.existsSync(nodeLicense)) {
  fs.copyFileSync(nodeLicense, path.join(OUT, 'node', 'LICENSE'));
}

// --- 3. Build the React client ----------------------------------------------
log('Building React client');
npm(['run', 'build'], { cwd: ROOT });

// --- 4. Staging production install (patched, prebuilt native binary) ---------
// Mirror the Dockerfile: full install so patch-package's postinstall applies the
// sdcp patch, then prune dev deps — the patched files stay, jest/postject/etc. go.
log('Installing production dependencies (staging)');
fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(STAGING, 'package.json'));
fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(STAGING, 'package-lock.json'));
fs.cpSync(path.join(ROOT, 'patches'), path.join(STAGING, 'patches'), { recursive: true });
npm(['ci'], { cwd: STAGING });
npm(['prune', '--omit=dev'], { cwd: STAGING });

// --- 5. Assemble app/ --------------------------------------------------------
log('Assembling app/');
const serverSrc = path.join(ROOT, 'server');
const exclude = new Set(['data', 'gcode', 'tests', 'seed-demo.js']);
fs.cpSync(serverSrc, path.join(APP, 'server'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(serverSrc, src);
    if (rel === '') return true;
    const top = rel.split(path.sep)[0];
    return !exclude.has(top);
  },
});
fs.mkdirSync(path.join(APP, 'client'), { recursive: true });
fs.cpSync(path.join(ROOT, 'client', 'dist'), path.join(APP, 'client', 'dist'), { recursive: true });
fs.cpSync(path.join(STAGING, 'node_modules'), path.join(APP, 'node_modules'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(APP, 'package.json'));

// --- 6. Build the launcher exe (Node SEA) ------------------------------------
log('Building launcher exe (Node SEA)');
const blob = path.join(SCRIPTS, 'sea-prep.blob');
fs.rmSync(blob, { force: true });
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: SCRIPTS });
const exePath = path.join(OUT, 'Print Farm Manager.exe');
fs.copyFileSync(path.join(OUT, 'node', 'node.exe'), exePath);
// Invoke postject's CLI directly with node (array args, no shell) so the space
// in the exe filename survives — routing through an npm/shell wrapper splits it.
const postjectCli = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
run(process.execPath, [postjectCli, exePath, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE]);
fs.rmSync(blob, { force: true });

// --- 7. Fallback launcher, README, cleanup -----------------------------------
log('Writing fallback launcher and README');
fs.writeFileSync(path.join(OUT, 'Start Print Farm Manager.bat'),
  '@echo off\r\n' +
  'title Print Farm Manager\r\n' +
  'cd /d "%~dp0app"\r\n' +
  'start "" /b cmd /c "timeout /t 3 >nul & start \"\" http://localhost:3000"\r\n' +
  '"%~dp0node\\node.exe" server\\index.js\r\n' +
  'echo.\r\n' +
  'echo Server stopped. Press any key to close.\r\n' +
  'pause >nul\r\n'
);
fs.writeFileSync(path.join(OUT, 'README.txt'),
  [
    'Print Farm Manager — Portable',
    '=============================',
    '',
    'TO START',
    '  Double-click "Print Farm Manager.exe".',
    '  A console window opens and your browser goes to http://localhost:3000.',
    '  Keep the console window open while the farm manager is running.',
    '  (If Windows SmartScreen warns on first run: More info -> Run anyway.)',
    '',
    'TO STOP',
    '  Close the console window, or press Ctrl+C in it.',
    '',
    'FROM OTHER MACHINES',
    '  Open http://<this-machine-ip>:3000 in any browser on the same network.',
    '',
    'YOUR DATA',
    '  The database and uploaded G-code files live in:',
    '    app\\server\\data      (farm.db and automatic backups)',
    '    app\\server\\gcode     (uploaded G-code files)',
    '  Back these up. To UPDATE to a newer bundle, copy these two folders into',
    '  the new bundle (or replace everything except them).',
    '',
    'TROUBLESHOOTING',
    '  If the exe will not start, run "Start Print Farm Manager.bat" instead —',
    '  it does the same thing and leaves any error message on screen.',
    '',
  ].join('\r\n')
);

fs.rmSync(STAGING, { recursive: true, force: true });

console.log(`\n[build ✓] Bundle ready: ${OUT}`);
console.log('Zip that folder to distribute. See docs/packaging.md.\n');
