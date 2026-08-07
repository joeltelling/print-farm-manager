const express = require('express');
const auth = require('../auth');

// Self-service personal API keys. A personal token has its user_id set, so it
// authenticates AS the signed-in user (inheriting their live role). External
// integrations like the wall planner use one so the projects they create are
// attributed to that person. Mounted at /api/auth/tokens before the RBAC guard;
// every handler requires a session. See docs/auth.md.
module.exports = (db) => {
  const router = express.Router();

  function sessionUser(req) {
    const id = auth.resolveIdentity(db, req);
    if (!id || !id.userId || id.type !== 'session') return null;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id.userId);
  }

  function publicToken(t) {
    return { id: t.id, name: t.name, token_prefix: t.token_prefix, created_at: t.created_at, last_used_at: t.last_used_at };
  }

  // GET /api/auth/tokens: the caller's own personal tokens (never the secret).
  router.get('/', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const rows = db.prepare('SELECT * FROM api_tokens WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC').all(user.id);
    res.json(rows.map(publicToken));
  });

  // POST /api/auth/tokens: mint a personal token, returning the secret exactly once.
  router.post('/', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const raw = auth.generateSecret('pfm_');
    // role stored is informational; resolveIdentity uses the user's live role via user_id.
    const info = db.prepare(
      'INSERT INTO api_tokens (name, token_hash, token_prefix, role, user_id, created_at, revoked, created_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(String(name).trim(), auth.hashToken(raw), raw.slice(0, 12), user.role, user.id, Date.now(), user.id);
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ ...publicToken(row), token: raw });
  });

  // DELETE /api/auth/tokens/:id: revoke one of the caller's own tokens.
  router.delete('/:id', (req, res) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Sign in first' });
    const info = db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(req.params.id, user.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Token not found' });
    res.json({ ok: true });
  });

  return router;
};
