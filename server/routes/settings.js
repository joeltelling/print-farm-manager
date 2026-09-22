const express = require('express');
const router = express.Router();

const ALLOWED_KEYS = new Set(['dispatch_batch_size', 'farm_name', 'auto_sso_redirect']);
// Admin-only settings: everything else in ALLOWED_KEYS can be changed by any
// authenticated user, matching this router's existing behavior. This one
// changes what every logged-out visitor sees on the login page, so it is
// scoped to admin the same way /api/users is (see server/index.js).
const ADMIN_ONLY_KEYS = new Set(['auto_sso_redirect']);

module.exports = (db) => {
  // GET /api/settings — returns all settings as { key: value, ... }
  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    rows.forEach(r => { result[r.key] = r.value; });
    res.json(result);
  });

  // PUT /api/settings/:key — update a single setting value
  router.put('/:key', (req, res) => {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown setting key: ${key}` });
    }
    if (ADMIN_ONLY_KEYS.has(key) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can change this setting' });
    }
    const { value } = req.body;
    if (value === undefined || value === null || String(value).trim() === '') {
      return res.status(400).json({ error: 'value is required' });
    }

    if (key === 'dispatch_batch_size') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 100) {
        return res.status(400).json({ error: 'dispatch_batch_size must be an integer between 1 and 100' });
      }
    }

    if (key === 'farm_name' && String(value).trim().length > 40) {
      return res.status(400).json({ error: 'farm_name must be 40 characters or fewer' });
    }

    if (key === 'auto_sso_redirect' && value !== '0' && value !== '1') {
      return res.status(400).json({ error: 'auto_sso_redirect must be "0" or "1"' });
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    res.json({ key, value: String(value) });
  });

  return router;
};
