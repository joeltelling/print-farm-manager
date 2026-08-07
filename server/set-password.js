#!/usr/bin/env node
// CLI: create or reset a Print Farm Manager admin password.
//
//   node server/set-password.js <username> [password]
//   npm run set-password -- <username>
//
// If <password> is omitted it is read from the PFM_PASSWORD env var, or prompted
// for (hidden). Creates the user as an active admin if new, or resets the
// password if the user exists, and clears any one-time must_change_password
// flag. Runs directly against the database, so it works headless and even when
// locked out of the web UI. See docs/auth.md.

const readline = require('readline');
const db = require('./db');
const auth = require('./auth');

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => {}; // suppress echo of the typed password
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function main() {
  const username = process.argv[2];
  let password = process.argv[3] || process.env.PFM_PASSWORD;
  if (!username) {
    console.error('Usage: node server/set-password.js <username> [password]');
    process.exit(1);
  }
  if (!password) password = await promptHidden(`New password for "${username}": `);
  if (!password || String(password).length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const { hash, salt } = auth.hashPassword(password);
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, is_active = 1, must_change_password = 0 WHERE id = ?')
      .run(hash, salt, existing.id);
    console.log(`Updated password for "${username}" (role: ${existing.role}).`);
  } else {
    db.prepare(
      `INSERT INTO users (username, password_hash, password_salt, role, is_active, created_at, must_change_password)
       VALUES (?, ?, ?, 'admin', 1, ?, 0)`
    ).run(username, hash, salt, Date.now());
    console.log(`Created admin "${username}".`);
  }
  console.log('Done. Enable authentication in Settings if it is not already on.');
  process.exit(0);
}

main();
