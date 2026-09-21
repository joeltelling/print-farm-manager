// Self-service API key management. Any authenticated user manages their own
// keys; an admin may also revoke someone else's (e.g. an ex-employee's key)
// but cannot see or recreate its plaintext, same as nobody can recover a
// forgotten password. A key acts as its owner for every request: full
// access, not scoped: see docs/api.md for the auth model.

const express = require('express');
const router = express.Router();
const auth = require('../auth');

module.exports = (db) => {
  // GET /api/api-keys: the current user's own keys. key_hash is never sent.
  router.get('/', (req, res) => {
    const keys = db.prepare(`
      SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
      FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.user.id);
    res.json(keys);
  });

  // POST /api/api-keys { name }: the only time the plaintext key is ever
  // available; the client must show it once and warn it cannot be shown again.
  router.post('/', (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const { plaintext, prefix, hash } = auth.generateApiKey();
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO api_keys (user_id, name, key_prefix, key_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, name.trim(), prefix, hash, now);

    res.status(201).json({
      id: result.lastInsertRowid,
      name: name.trim(),
      key_prefix: prefix,
      created_at: now,
      key: plaintext, // shown once
    });
  });

  // DELETE /api/api-keys/:id: revoke (soft delete, keeps the row for
  // last_used_at history). Owner or an admin may revoke; nobody else.
  router.delete('/:id', (req, res) => {
    const key = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(req.params.id);
    if (!key) return res.status(404).json({ error: 'API key not found' });
    if (key.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your API key' });
    }
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(Date.now(), key.id);
    res.json({ success: true });
  });

  return router;
};
