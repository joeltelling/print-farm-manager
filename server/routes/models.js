const express = require('express');

// Connectors are code-level — each requires a driver implementation.
// This list is the authoritative set of valid connector values.
const VALID_CONNECTORS = ['prusa', 'elegoo-centauri', 'elegoo-centauri2', 'bambu', 'klipper', 'octoprint', 'creality'];

module.exports = (db) => {
  const router = express.Router();

  // GET /api/models — list all configured printer models
  router.get('/', (_req, res) => {
    const models = db.prepare(
      'SELECT * FROM printer_models ORDER BY connector, model_id'
    ).all();
    res.json(models);
  });

  // POST /api/models — add a new printer model
  router.post('/', (req, res) => {
    const { model_id, label, connector } = req.body;
    if (!model_id || !label || !connector) {
      return res.status(400).json({ error: 'model_id, label, and connector are required' });
    }
    if (!VALID_CONNECTORS.includes(connector)) {
      return res.status(400).json({ error: `connector must be one of: ${VALID_CONNECTORS.join(', ')}` });
    }
    // Normalize: lowercase, spaces → hyphens
    const id = model_id.trim().toLowerCase().replace(/\s+/g, '-');
    try {
      db.prepare('INSERT INTO printer_models (model_id, label, connector) VALUES (?, ?, ?)')
        .run(id, label.trim(), connector);
      res.status(201).json(db.prepare('SELECT * FROM printer_models WHERE model_id = ?').get(id));
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Model "${id}" already exists` });
      }
      throw err;
    }
  });

  // DELETE /api/models/:model_id — remove a model
  // Blocked if any active printers currently use this model.
  router.delete('/:model_id', (req, res) => {
    const { model_id } = req.params;
    const inUse = db.prepare(
      'SELECT COUNT(*) as count FROM printers WHERE model = ? AND is_active = 1'
    ).get(model_id);
    if (inUse.count > 0) {
      return res.status(409).json({
        error: `Cannot delete — ${inUse.count} active printer(s) use this model`,
      });
    }
    const result = db.prepare('DELETE FROM printer_models WHERE model_id = ?').run(model_id);
    if (result.changes === 0) return res.status(404).json({ error: 'Model not found' });
    res.json({ ok: true });
  });

  return router;
};
