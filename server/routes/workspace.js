const express = require('express');

const ACCENTS = new Set(['lime', 'violet', 'cyan', 'amber', 'red', 'indigo']);

const DEFAULT_COLUMNS = [
  { title: 'To Do', accent: 'amber', sort_order: 0 },
  { title: 'In Progress', accent: 'violet', sort_order: 1 },
  { title: 'Review', accent: 'cyan', sort_order: 2 },
  { title: 'Done', accent: 'lime', sort_order: 3 },
];

function seedDefaultColumns(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM workspace_columns').get().n;
  if (count > 0) return;
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO workspace_columns (title, accent, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const run = db.transaction(() => {
    for (const col of DEFAULT_COLUMNS) {
      insert.run(col.title, col.accent, col.sort_order, now, now);
    }
  });
  run();
}

function loadBoard(db) {
  seedDefaultColumns(db);
  const columns = db.prepare(`
    SELECT * FROM workspace_columns ORDER BY sort_order ASC, id ASC
  `).all();
  const cards = db.prepare(`
    SELECT * FROM workspace_cards ORDER BY sort_order ASC, id ASC
  `).all();
  const byCol = new Map(columns.map(c => [c.id, []]));
  for (const card of cards) {
    const list = byCol.get(card.column_id);
    if (list) list.push(card);
  }
  return columns.map(col => ({
    ...col,
    cards: byCol.get(col.id) || [],
  }));
}

function getColumn(db, id) {
  return db.prepare('SELECT * FROM workspace_columns WHERE id = ?').get(id);
}

function getCard(db, id) {
  return db.prepare('SELECT * FROM workspace_cards WHERE id = ?').get(id);
}

module.exports = (db) => {
  const router = express.Router();

  // GET /api/workspace - full board (columns with nested cards). Seeds defaults if empty.
  router.get('/', (req, res) => {
    res.json({ columns: loadBoard(db) });
  });

  // POST /api/workspace/columns
  router.post('/columns', (req, res) => {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ error: 'title is required' });

    const accent = req.body.accent || 'violet';
    if (!ACCENTS.has(accent)) {
      return res.status(400).json({ error: 'accent must be one of: ' + [...ACCENTS].join(', ') });
    }

    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM workspace_columns').get().m;
    const now = Date.now();
    const r = db.prepare(`
      INSERT INTO workspace_columns (title, accent, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(title, accent, maxOrder + 1, now, now);

    res.status(201).json(getColumn(db, r.lastInsertRowid));
  });

  // PUT /api/workspace/columns/reorder - static before :id
  router.put('/columns/reorder', (req, res) => {
    const order = req.body.order;
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'order must be a non-empty array of column ids' });
    }

    const ids = order.map(Number);
    if (ids.some(id => !Number.isInteger(id) || id < 1)) {
      return res.status(400).json({ error: 'order must contain positive integer ids' });
    }

    const existing = db.prepare('SELECT id FROM workspace_columns').all().map(r => r.id);
    if (ids.length !== existing.length || new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'order must list every column id exactly once' });
    }
    for (const id of ids) {
      if (!existing.includes(id)) {
        return res.status(400).json({ error: `unknown column id ${id}` });
      }
    }

    const now = Date.now();
    const upd = db.prepare('UPDATE workspace_columns SET sort_order = ?, updated_at = ? WHERE id = ?');
    const run = db.transaction(() => {
      ids.forEach((id, i) => upd.run(i, now, id));
    });
    run();

    res.json({ columns: loadBoard(db) });
  });

  // PUT /api/workspace/columns/:id
  router.put('/columns/:id', (req, res) => {
    const id = Number(req.params.id);
    const col = getColumn(db, id);
    if (!col) return res.status(404).json({ error: 'Column not found' });

    let title = col.title;
    if (req.body.title !== undefined) {
      title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
      if (!title) return res.status(400).json({ error: 'title is required' });
    }

    let accent = col.accent;
    if (req.body.accent !== undefined) {
      if (!ACCENTS.has(req.body.accent)) {
        return res.status(400).json({ error: 'accent must be one of: ' + [...ACCENTS].join(', ') });
      }
      accent = req.body.accent;
    }

    const now = Date.now();
    db.prepare(`
      UPDATE workspace_columns
      SET title = ?, accent = ?, updated_at = ?
      WHERE id = ?
    `).run(title, accent, now, id);

    res.json(getColumn(db, id));
  });

  // DELETE /api/workspace/columns/:id - cascades cards via FK
  router.delete('/columns/:id', (req, res) => {
    const id = Number(req.params.id);
    const col = getColumn(db, id);
    if (!col) return res.status(404).json({ error: 'Column not found' });

    db.prepare('DELETE FROM workspace_columns WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // POST /api/workspace/cards
  router.post('/cards', (req, res) => {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ error: 'title is required' });

    const columnId = Number(req.body.column_id);
    if (!Number.isInteger(columnId) || columnId < 1) {
      return res.status(400).json({ error: 'column_id is required' });
    }
    if (!getColumn(db, columnId)) {
      return res.status(404).json({ error: 'Column not found' });
    }

    const body = typeof req.body.body === 'string' ? req.body.body : '';
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM workspace_cards WHERE column_id = ?'
    ).get(columnId).m;
    const now = Date.now();
    const r = db.prepare(`
      INSERT INTO workspace_cards (column_id, title, body, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(columnId, title, body, maxOrder + 1, now, now);

    res.status(201).json(getCard(db, r.lastInsertRowid));
  });

  // PUT /api/workspace/cards/reorder - move across columns + reorder in one transaction
  router.put('/cards/reorder', (req, res) => {
    const items = req.body.cards;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'cards must be a non-empty array of {id, column_id, sort_order}' });
    }

    const parsed = [];
    for (const item of items) {
      const id = Number(item.id);
      const columnId = Number(item.column_id);
      const sortOrder = Number(item.sort_order);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'each card needs a positive integer id' });
      }
      if (!Number.isInteger(columnId) || columnId < 1) {
        return res.status(400).json({ error: 'each card needs a positive integer column_id' });
      }
      if (!Number.isInteger(sortOrder) || sortOrder < 0) {
        return res.status(400).json({ error: 'each card needs a non-negative integer sort_order' });
      }
      parsed.push({ id, columnId, sortOrder });
    }

    const ids = parsed.map(p => p.id);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: 'duplicate card ids in reorder payload' });
    }

    for (const p of parsed) {
      if (!getCard(db, p.id)) {
        return res.status(404).json({ error: `Card ${p.id} not found` });
      }
      if (!getColumn(db, p.columnId)) {
        return res.status(404).json({ error: `Column ${p.columnId} not found` });
      }
    }

    const now = Date.now();
    const upd = db.prepare(`
      UPDATE workspace_cards
      SET column_id = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `);
    const run = db.transaction(() => {
      for (const p of parsed) {
        upd.run(p.columnId, p.sortOrder, now, p.id);
      }
    });
    run();

    res.json({ columns: loadBoard(db) });
  });

  // PUT /api/workspace/cards/:id
  router.put('/cards/:id', (req, res) => {
    const id = Number(req.params.id);
    const card = getCard(db, id);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    let title = card.title;
    if (req.body.title !== undefined) {
      title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
      if (!title) return res.status(400).json({ error: 'title is required' });
    }

    let body = card.body;
    if (req.body.body !== undefined) {
      body = typeof req.body.body === 'string' ? req.body.body : '';
    }

    let columnId = card.column_id;
    if (req.body.column_id !== undefined) {
      columnId = Number(req.body.column_id);
      if (!Number.isInteger(columnId) || columnId < 1) {
        return res.status(400).json({ error: 'column_id must be a positive integer' });
      }
      if (!getColumn(db, columnId)) {
        return res.status(404).json({ error: 'Column not found' });
      }
    }

    const now = Date.now();
    db.prepare(`
      UPDATE workspace_cards
      SET column_id = ?, title = ?, body = ?, updated_at = ?
      WHERE id = ?
    `).run(columnId, title, body, now, id);

    res.json(getCard(db, id));
  });

  // DELETE /api/workspace/cards/:id
  router.delete('/cards/:id', (req, res) => {
    const id = Number(req.params.id);
    const card = getCard(db, id);
    if (!card) return res.status(404).json({ error: 'Card not found' });

    db.prepare('DELETE FROM workspace_cards WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return router;
};
