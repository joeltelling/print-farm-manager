// Admin-only user management. Mounted behind the global requireAuth gate plus
// requireRole('admin') on every route in this file (see server/index.js): an
// operator account should never reach any of these handlers.

const express = require('express');
const router = express.Router();
const auth = require('../auth');

const VALID_ROLES = new Set(['admin', 'operator']);

function countAdmins(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
}

module.exports = (db) => {
  // GET /api/users
  router.get('/', (req, res) => {
    const users = db.prepare('SELECT id, email, name, role, oidc_subject, created_at, last_login_at FROM users ORDER BY created_at').all();
    res.json(users);
  });

  // POST /api/users: admin creates an account for someone else. password is
  // optional: omit it for an OIDC-only account (they sign in via SSO, never
  // set a local password) and the admin communicates the OIDC provider's
  // enrollment out of band.
  router.post('/', (req, res) => {
    const { email, name, password, role } = req.body || {};
    if (!email || !name) {
      return res.status(400).json({ error: 'email and name are required' });
    }
    const resolvedRole = role || 'operator';
    if (!VALID_ROLES.has(resolvedRole)) {
      return res.status(400).json({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    try {
      const now = Date.now();
      const result = db.prepare(`
        INSERT INTO users (email, name, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(email.trim().toLowerCase(), name.trim(), password ? auth.hashPassword(password) : null, resolvedRole, now);
      res.status(201).json(db.prepare(
        'SELECT id, email, name, role, oidc_subject, created_at, last_login_at FROM users WHERE id = ?'
      ).get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `A user with email "${email}" already exists` });
      }
      throw err;
    }
  });

  // PUT /api/users/:id: update name, role, or reset password. COALESCE
  // keeps omitted fields unchanged, matching every other route in this app.
  router.put('/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { name, role, password } = req.body || {};
    if (role !== undefined && !VALID_ROLES.has(role)) {
      return res.status(400).json({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
    }
    // Guard against locking the farm out of its own admin panel: refuse to
    // demote the last remaining admin, including demoting yourself.
    if (role === 'operator' && user.role === 'admin' && countAdmins(db) <= 1) {
      return res.status(409).json({ error: 'Cannot demote the last admin account' });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    db.prepare(`
      UPDATE users
      SET name = COALESCE(?, name),
          role = COALESCE(?, role),
          password_hash = COALESCE(?, password_hash)
      WHERE id = ?
    `).run(name ?? null, role ?? null, password ? auth.hashPassword(password) : null, req.params.id);

    res.json(db.prepare(
      'SELECT id, email, name, role, oidc_subject, created_at, last_login_at FROM users WHERE id = ?'
    ).get(req.params.id));
  });

  // DELETE /api/users/:id
  router.delete('/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (String(req.user.id) === String(req.params.id)) {
      return res.status(409).json({ error: 'Cannot delete your own account while signed in as it' });
    }
    if (user.role === 'admin' && countAdmins(db) <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last admin account' });
    }
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ success: true });
  });

  return router;
};
