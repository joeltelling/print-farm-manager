const express = require('express');

module.exports = (db) => {
  const router = express.Router();

  // GET /api/groups: list every registered printer group.
  // This is the persisted registry (printer_groups), not a live derivation
  // from printers. A group stays listed even if no printer currently
  // carries it, so a G-code or project restriction that names it never
  // silently becomes invisible.
  router.get('/', (_req, res) => {
    const groups = db.prepare('SELECT * FROM printer_groups ORDER BY name').all();
    res.json(groups);
  });

  // POST /api/groups: register a new group
  router.post('/', (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    try {
      db.prepare('INSERT INTO printer_groups (name, created_at) VALUES (?, ?)')
        .run(name, Date.now());
      res.status(201).json(db.prepare('SELECT * FROM printer_groups WHERE name = ?').get(name));
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `Group "${name}" already exists` });
      }
      throw err;
    }
  });

  // DELETE /api/groups/:name: remove a group
  // Blocked if the name is still referenced anywhere: an active printer's
  // group_name, a gcode's allowed_groups, or a project's allowed_groups.
  // This is what stops the original bug from recurring via deletion: a
  // group a restriction still depends on can't be removed just because no
  // printer currently carries it.
  router.delete('/:name', (req, res) => {
    const { name } = req.params;
    const usage = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM printers WHERE group_name = ? AND is_active = 1) AS printers,
        (SELECT COUNT(*) FROM gcodes WHERE allowed_groups IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(gcodes.allowed_groups) WHERE value = ?)) AS gcodes,
        (SELECT COUNT(*) FROM projects WHERE allowed_groups IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(projects.allowed_groups) WHERE value = ?)) AS projects
    `).get(name, name, name);

    if (usage.printers > 0 || usage.gcodes > 0 || usage.projects > 0) {
      const parts = [];
      if (usage.printers > 0) parts.push(`${usage.printers} active printer(s)`);
      if (usage.gcodes > 0)   parts.push(`${usage.gcodes} G-code restriction(s)`);
      if (usage.projects > 0) parts.push(`${usage.projects} project restriction(s)`);
      return res.status(409).json({
        error: `Cannot delete: group "${name}" is used by ${parts.join(', ')}`,
      });
    }

    const result = db.prepare('DELETE FROM printer_groups WHERE name = ?').run(name);
    if (result.changes === 0) return res.status(404).json({ error: 'Group not found' });
    res.json({ ok: true });
  });

  return router;
};
