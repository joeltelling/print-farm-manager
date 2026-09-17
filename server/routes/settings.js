const express = require('express');
const router = express.Router();

const ALLOWED_KEYS = new Set([
  'dispatch_batch_size',
  'farm_name',
  'camera_mode',
  'timelapse_enabled',
  'timelapse_interval_seconds',
  'timelapse_fps',
  'timelapse_retention_days',
]);

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

    if (key === 'camera_mode') {
      const mode = String(value).trim();
      if (mode !== 'stream' && mode !== 'snapshot') {
        return res.status(400).json({ error: 'camera_mode must be stream or snapshot' });
      }
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    res.json({ key, value: String(value) });
  });

  return router;
};
