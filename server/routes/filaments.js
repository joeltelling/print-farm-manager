const express = require('express');

module.exports = (db) => {
  const router = express.Router();

  // ── Filament Types ────────────────────────────────────────────────────────

  router.get('/types', (_req, res) => {
    res.json(db.prepare('SELECT * FROM filament_types ORDER BY name').all());
  });

  router.post('/types', (req, res) => {
    const name = req.body?.name?.trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      const result = db.prepare('INSERT INTO filament_types (name) VALUES (?)').run(name);
      res.status(201).json(db.prepare('SELECT * FROM filament_types WHERE id = ?').get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists` });
      throw err;
    }
  });

  // Blocked if any colors belong to this type
  router.delete('/types/:id', (req, res) => {
    const colorCount = db.prepare('SELECT COUNT(*) as count FROM filament_color_types WHERE type_id = ?').get(req.params.id);
    if (colorCount.count > 0) {
      return res.status(409).json({ error: `Cannot delete: ${colorCount.count} color(s) belong to this type. Remove them from this type first.` });
    }
    const result = db.prepare('DELETE FROM filament_types WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ── Filament Colors ───────────────────────────────────────────────────────
  //
  // A color (e.g. "Black") can apply to more than one type via the many-to-many
  // filament_color_types join table, so it no longer has to be re-entered once per
  // material. GET /colors keeps returning one flattened row per (color, type) pair,
  // unchanged from before this existed: every existing "colors available for
  // material X" picker throughout the client filters on that shape and needed no
  // changes. GET /colors/grouped is the one new shape, one row per color with a
  // `types` array, used only by the Settings admin management table where a color's
  // type list is actually edited.

  // Returns one row per (color, type) pair, with the type name included: the
  // long-standing shape every filament_color-driven picker in the client expects.
  router.get('/colors', (_req, res) => {
    res.json(db.prepare(`
      SELECT fc.id, fc.name, fc.hex_color, ft.id AS type_id, ft.name AS type_name
      FROM filament_colors fc
      JOIN filament_color_types fct ON fct.color_id = fc.id
      JOIN filament_types ft ON ft.id = fct.type_id
      ORDER BY ft.name, fc.name
    `).all());
  });

  // Returns one row per color, with every associated type as a nested array.
  // Used by the Settings admin table so an operator can see and edit a color's
  // full type list in one place instead of one flattened row per type.
  router.get('/colors/grouped', (_req, res) => {
    const colors = db.prepare('SELECT * FROM filament_colors ORDER BY name').all();
    const typesByColor = db.prepare(`
      SELECT fct.color_id, ft.id, ft.name
      FROM filament_color_types fct
      JOIN filament_types ft ON ft.id = fct.type_id
      ORDER BY ft.name
    `).all();
    res.json(colors.map(c => ({
      ...c,
      types: typesByColor.filter(t => t.color_id === c.id).map(({ id, name }) => ({ id, name })),
    })));
  });

  // Creates a new color with its initial set of types. To add/remove types on an
  // existing color instead, use PUT /colors/:id.
  router.post('/colors', (req, res) => {
    const name = req.body?.name?.trim();
    const type_ids = Array.isArray(req.body?.type_ids) ? req.body.type_ids.map(id => parseInt(id, 10)) : [];
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (type_ids.length === 0) return res.status(400).json({ error: 'At least one type_id is required' });

    const placeholders = type_ids.map(() => '?').join(',');
    const foundCount = db.prepare(`SELECT COUNT(*) AS count FROM filament_types WHERE id IN (${placeholders})`).get(...type_ids).count;
    if (foundCount !== type_ids.length) return res.status(400).json({ error: 'One or more filament types not found' });

    const hex = req.body?.hex_color?.trim() || null;
    try {
      const createColor = db.transaction(() => {
        const result = db.prepare('INSERT INTO filament_colors (name, hex_color) VALUES (?, ?)').run(name, hex);
        const insertType = db.prepare('INSERT INTO filament_color_types (color_id, type_id) VALUES (?, ?)');
        for (const type_id of type_ids) insertType.run(result.lastInsertRowid, type_id);
        return result.lastInsertRowid;
      });
      const colorId = createColor();
      const types = db.prepare(`
        SELECT ft.id, ft.name FROM filament_color_types fct JOIN filament_types ft ON ft.id = fct.type_id
        WHERE fct.color_id = ? ORDER BY ft.name
      `).all(colorId);
      res.status(201).json({ ...db.prepare('SELECT * FROM filament_colors WHERE id = ?').get(colorId), types });
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists, edit it instead to change its types` });
      throw err;
    }
  });

  // Partial update: name/hex_color (COALESCE, omitted fields unchanged), and if
  // type_ids is provided, replaces the color's full type list (the same
  // replace-the-whole-set convention gcodes.allowed_groups already uses).
  router.put('/colors/:id', (req, res) => {
    const color = db.prepare('SELECT * FROM filament_colors WHERE id = ?').get(req.params.id);
    if (!color) return res.status(404).json({ error: 'Not found' });

    const { name, hex_color } = req.body || {};
    let type_ids;
    if ('type_ids' in (req.body || {})) {
      type_ids = Array.isArray(req.body.type_ids) ? req.body.type_ids.map(id => parseInt(id, 10)) : [];
      if (type_ids.length === 0) return res.status(400).json({ error: 'A color must have at least one type' });
      const placeholders = type_ids.map(() => '?').join(',');
      const foundCount = db.prepare(`SELECT COUNT(*) AS count FROM filament_types WHERE id IN (${placeholders})`).get(...type_ids).count;
      if (foundCount !== type_ids.length) return res.status(400).json({ error: 'One or more filament types not found' });
    }

    try {
      const applyUpdate = db.transaction(() => {
        db.prepare(`
          UPDATE filament_colors SET name = COALESCE(?, name), hex_color = ? WHERE id = ?
        `).run(name?.trim() || null, hex_color !== undefined ? (hex_color?.trim() || null) : color.hex_color, color.id);

        if (type_ids) {
          db.prepare('DELETE FROM filament_color_types WHERE color_id = ?').run(color.id);
          const insertType = db.prepare('INSERT INTO filament_color_types (color_id, type_id) VALUES (?, ?)');
          for (const type_id of type_ids) insertType.run(color.id, type_id);
        }
      });
      applyUpdate();

      const types = db.prepare(`
        SELECT ft.id, ft.name FROM filament_color_types fct JOIN filament_types ft ON ft.id = fct.type_id
        WHERE fct.color_id = ? ORDER BY ft.name
      `).all(color.id);
      res.json({ ...db.prepare('SELECT * FROM filament_colors WHERE id = ?').get(color.id), types });
    } catch (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: `"${name}" already exists` });
      throw err;
    }
  });

  router.delete('/colors/:id', (req, res) => {
    const deleteColor = db.transaction((id) => {
      db.prepare('DELETE FROM filament_color_types WHERE color_id = ?').run(id);
      return db.prepare('DELETE FROM filament_colors WHERE id = ?').run(id);
    });
    const result = deleteColor(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  return router;
};
