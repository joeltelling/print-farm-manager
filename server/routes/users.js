const express = require('express');
const auth = require('../auth');

// User accounts. Admin only: the auth middleware restricts /api/users to the
// admin role. Passwords are never returned and are stored only as scrypt
// hashes. See docs/auth.md.
module.exports = (db) => {
  const router = express.Router();

  // 'device' is a token-only role (see /api/tokens); real accounts are one of these.
  const MANAGEABLE_ROLES = ['viewer', 'operator', 'admin'];

  function publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      is_active: u.is_active,
      created_at: u.created_at,
      last_login_at: u.last_login_at,
    };
  }

  // Number of OTHER active admins (excluding the given id). Guards last-admin removal.
  function otherActiveAdmins(excludeId) {
    return db.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?"
    ).get(excludeId ?? -1).c;
  }

  // GET /api/users
  router.get('/', (_req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY username').all();
    res.json(rows.map(publicUser));
  });

  // POST /api/users
  router.post('/', (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username || !password || !role) {
      return res.status(400).json({ error: 'username, password, and role are required' });
    }
    if (!MANAGEABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${MANAGEABLE_ROLES.join(', ')}` });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(String(username).trim())) {
      return res.status(409).json({ error: 'username already exists' });
    }

    const { hash, salt } = auth.hashPassword(password);
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, password_salt, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(String(username).trim(), hash, salt, role, Date.now());
    res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
  });

  // PUT /api/users/:id: partial update: role, is_active, password
  router.put('/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { role, is_active, password } = req.body || {};
    if (role !== undefined && !MANAGEABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${MANAGEABLE_ROLES.join(', ')}` });
    }
    if (password !== undefined && String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    // Never strand an install with no admin: block demoting/deactivating the last one.
    const demoting = (role !== undefined && role !== 'admin') || (is_active !== undefined && !Number(is_active));
    if (user.role === 'admin' && demoting && otherActiveAdmins(user.id) === 0) {
      return res.status(409).json({ error: 'Cannot remove the last active admin' });
    }

    const newRole = role ?? user.role;
    const newActive = is_active !== undefined ? (Number(is_active) ? 1 : 0) : user.is_active;
    let { password_hash: hash, password_salt: salt } = user;
    if (password !== undefined) ({ hash, salt } = auth.hashPassword(password));

    db.prepare('UPDATE users SET role = ?, is_active = ?, password_hash = ?, password_salt = ? WHERE id = ?')
      .run(newRole, newActive, hash, salt, user.id);
    // Deactivating or changing a user ends their existing sessions.
    if (!newActive || password !== undefined) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    }
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)));
  });

  // DELETE /api/users/:id
  router.delete('/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin' && otherActiveAdmins(user.id) === 0) {
      return res.status(409).json({ error: 'Cannot delete the last active admin' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();
    res.json({ success: true });
  });

  return router;
};
