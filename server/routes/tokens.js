const express = require('express');
const auth = require('../auth');

// API tokens. Admin only: the auth middleware restricts /api/tokens to the
// admin role. The secret is shown exactly once at creation and stored only as
// a sha256 hash. Machine clients (for example the CYD wall box) authenticate
// with `Authorization: Bearer <token>`. See docs/auth.md.
module.exports = (db) => {
  const router = express.Router();

  function publicToken(t) {
    let printerIds = null;
    if (t.printer_ids) { try { printerIds = JSON.parse(t.printer_ids); } catch (_) {} }
    return {
      id: t.id,
      name: t.name,
      token_prefix: t.token_prefix,
      role: t.role,
      printer_ids: printerIds,
      user_id: t.user_id ?? null,       // set = personal token (acts as a user)
      owner: t.owner_username || null,  // the user a personal token belongs to
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      revoked: t.revoked,
    };
  }

  // GET /api/tokens: metadata only, never the secret. Includes personal tokens
  // (with their owner) so an admin can audit and revoke them.
  router.get('/', (_req, res) => {
    const rows = db.prepare(`
      SELECT t.*, u.username AS owner_username
      FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC
    `).all();
    res.json(rows.map(publicToken));
  });

  // POST /api/tokens: returns the plaintext token exactly once
  router.post('/', (req, res) => {
    const { name, role, printer_ids } = req.body || {};
    if (!name || !role) return res.status(400).json({ error: 'name and role are required' });
    if (!auth.ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${auth.ROLES.join(', ')}` });
    }
    // Optional per-printer binding, only meaningful for device tokens (the CYD's printers).
    let printerIdsJson = null;
    if (role === 'device' && Array.isArray(printer_ids) && printer_ids.length) {
      const ids = printer_ids.map(Number).filter(Number.isInteger);
      if (ids.length !== printer_ids.length) {
        return res.status(400).json({ error: 'printer_ids must be an array of integers' });
      }
      printerIdsJson = JSON.stringify(ids);
    }
    const raw = auth.generateSecret('pfm_');
    const info = db.prepare(
      'INSERT INTO api_tokens (name, token_hash, token_prefix, role, printer_ids, created_at, revoked, created_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(String(name).trim(), auth.hashToken(raw), raw.slice(0, 12), role, printerIdsJson, Date.now(), req.auth?.userId ?? null);
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info.lastInsertRowid);
    // `token` is returned only here and never again.
    res.status(201).json({ ...publicToken(row), token: raw });
  });

  // DELETE /api/tokens/:id: revoke (removes the token)
  router.delete('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Token not found' });
    db.prepare('DELETE FROM api_tokens WHERE id = ?').run(row.id);
    res.json({ success: true });
  });

  return router;
};
