'use strict';

// Launcher embedded in "Print Farm Manager.exe" via Node's Single Executable
// Application (SEA) feature. It uses ONLY Node built-in modules so it needs
// nothing on disk except the bundle it ships in.
//
// A SEA executable always runs this script and cannot act as a plain `node`,
// so it starts the server by spawning the separate `node/node.exe` that ships
// alongside it.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// process.execPath is the .exe itself; its directory is the bundle root.
const root = path.dirname(process.execPath);
const nodeExe = path.join(root, 'node', 'node.exe');
const appDir = path.join(root, 'app');
const entry = path.join(appDir, 'server', 'index.js');
const port = process.env.PORT || '3000';
const url = `http://localhost:${port}`;

function fail(msg) {
  process.stderr.write(`\n[Print Farm Manager] ${msg}\n\n`);
  process.stderr.write('This bundle looks incomplete. Re-extract it from the original zip.\n');
  process.stderr.write('\nPress Enter to close...');
  try { fs.readSync(0, Buffer.alloc(1), 0, 1, null); } catch (_) { /* no stdin */ }
  process.exit(1);
}

if (!fs.existsSync(nodeExe)) fail(`Node runtime not found at ${nodeExe}`);
if (!fs.existsSync(entry)) fail(`Application not found at ${entry}`);

process.stdout.write('\n  Print Farm Manager\n');
process.stdout.write(`  Starting server — the dashboard will open at ${url}\n`);
process.stdout.write('  Keep this window open while the farm manager is running.\n\n');

const child = spawn(nodeExe, [entry], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
});

// Open the default browser once, after a short delay so the server has bound.
// rundll32 FileProtocolHandler is the shell-free way to open a URL on Windows.
const opener = setTimeout(() => {
  try {
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (_) {
    process.stdout.write(`  Open your browser to ${url}\n`);
  }
}, 2500);

child.on('error', (err) => fail(`Failed to start the server: ${err.message}`));
child.on('exit', (code) => {
  clearTimeout(opener);
  process.exit(code == null ? 0 : code);
});

// Forward Ctrl+C to the server so it shuts down cleanly.
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
