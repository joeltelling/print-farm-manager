const express = require('express');
const router = express.Router();

module.exports = (db) => {
  router.get('/', (req, res) => {
    const { project_id } = req.query;
    const parts = project_id
      ? db.prepare('SELECT * FROM parts WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC').all(project_id)
      : db.prepare('SELECT * FROM parts ORDER BY sort_order ASC, created_at ASC').all();
    res.json(parts);
  });

  router.get('/:id', (req, res) => {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Part not found' });
    res.json(part);
  });

  router.post('/', (req, res) => {
    const { project_id, name, target_qty } = req.body;
    if (!project_id || !name || !target_qty) {
      return res.status(400).json({ error: 'project_id, name, and target_qty are required' });
    }
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO parts (project_id, name, target_qty, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(project_id, name, parseInt(target_qty, 10), now, now);
    res.status(201).json(db.prepare('SELECT * FROM parts WHERE id = ?').get(result.lastInsertRowid));
  });

  router.put('/:id', (req, res) => {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Part not found' });

    const { name, target_qty, completed_qty, status } = req.body;

    // Auto-calculate status when completed_qty is explicitly provided
    let resolvedStatus = part.status;
    if (completed_qty !== undefined) {
      const effectiveTarget = target_qty !== undefined ? parseInt(target_qty, 10) : part.target_qty;
      resolvedStatus = parseInt(completed_qty, 10) >= effectiveTarget ? 'closed' : 'open';
    } else if (status !== undefined) {
      resolvedStatus = status;
    }

    db.prepare(`
      UPDATE parts
      SET name          = COALESCE(?, name),
          target_qty    = COALESCE(?, target_qty),
          completed_qty = COALESCE(?, completed_qty),
          status        = ?,
          updated_at    = ?
      WHERE id = ?
    `).run(
      name,
      target_qty !== undefined ? parseInt(target_qty, 10) : null,
      completed_qty !== undefined ? parseInt(completed_qty, 10) : null,
      resolvedStatus,
      Date.now(),
      req.params.id
    );

    res.json(db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id));
  });

  // PUT /api/parts/reorder — set sort_order for a list of part IDs
  // Body: { ids: [3, 1, 2] } — ordered array; index becomes sort_order
  router.put('/reorder', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const update = db.prepare('UPDATE parts SET sort_order = ?, updated_at = ? WHERE id = ?');
    const now = Date.now();
    db.transaction(() => {
      ids.forEach((id, index) => update.run(index, now, id));
    })();
    res.json({ success: true });
  });

  router.delete('/:id', (req, res) => {
    const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id);
    if (!part) return res.status(404).json({ error: 'Part not found' });
    db.prepare('DELETE FROM parts WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  return router;
};
