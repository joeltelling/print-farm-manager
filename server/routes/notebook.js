const express = require('express');

const ACCENTS = new Set(['lime', 'violet', 'cyan', 'amber', 'red', 'indigo']);

function getPage(db, id) {
  return db.prepare('SELECT * FROM notebook_pages WHERE id = ?').get(id);
}

module.exports = (db) => {
  const router = express.Router();

  // GET /api/notebook/pages?trashed=0|1&q=
  router.get('/pages', (req, res) => {
    const trashed = req.query.trashed === '1' || req.query.trashed === 'true';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    let sql;
    const params = [];
    if (trashed) {
      sql = 'SELECT * FROM notebook_pages WHERE trashed_at IS NOT NULL';
    } else {
      sql = 'SELECT * FROM notebook_pages WHERE trashed_at IS NULL';
    }

    if (q) {
      sql += ' AND (title LIKE ? OR body LIKE ?)';
      const like = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      params.push(like, like);
    }

    sql += trashed
      ? ' ORDER BY trashed_at DESC, id DESC'
      : ' ORDER BY updated_at DESC, id DESC';

    res.json({ pages: db.prepare(sql).all(...params) });
  });

  // POST /api/notebook/pages
  router.post('/pages', (req, res) => {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title) return res.status(400).json({ error: 'title is required' });

    const body = typeof req.body.body === 'string' ? req.body.body : '';
    const accent = req.body.accent || 'lime';
    if (!ACCENTS.has(accent)) {
      return res.status(400).json({ error: 'accent must be one of: ' + [...ACCENTS].join(', ') });
    }

    const now = Date.now();
    const r = db.prepare(`
      INSERT INTO notebook_pages (title, body, accent, trashed_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(title, body, accent, now, now);

    res.status(201).json(getPage(db, r.lastInsertRowid));
  });

  // POST /api/notebook/pages/:id/trash - static-ish path before bare :id delete
  router.post('/pages/:id/trash', (req, res) => {
    const id = Number(req.params.id);
    const page = getPage(db, id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    if (page.trashed_at != null) {
      return res.status(409).json({ error: 'Page is already in trash' });
    }

    const now = Date.now();
    db.prepare(`
      UPDATE notebook_pages SET trashed_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, id);

    res.json(getPage(db, id));
  });

  // POST /api/notebook/pages/:id/restore
  router.post('/pages/:id/restore', (req, res) => {
    const id = Number(req.params.id);
    const page = getPage(db, id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    if (page.trashed_at == null) {
      return res.status(409).json({ error: 'Page is not in trash' });
    }

    const now = Date.now();
    db.prepare(`
      UPDATE notebook_pages SET trashed_at = NULL, updated_at = ? WHERE id = ?
    `).run(now, id);

    res.json(getPage(db, id));
  });

  // PUT /api/notebook/pages/:id
  router.put('/pages/:id', (req, res) => {
    const id = Number(req.params.id);
    const page = getPage(db, id);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    let title = page.title;
    if (req.body.title !== undefined) {
      title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
      if (!title) return res.status(400).json({ error: 'title is required' });
    }

    let body = page.body;
    if (req.body.body !== undefined) {
      body = typeof req.body.body === 'string' ? req.body.body : '';
    }

    let accent = page.accent;
    if (req.body.accent !== undefined) {
      if (!ACCENTS.has(req.body.accent)) {
        return res.status(400).json({ error: 'accent must be one of: ' + [...ACCENTS].join(', ') });
      }
      accent = req.body.accent;
    }

    const now = Date.now();
    db.prepare(`
      UPDATE notebook_pages
      SET title = ?, body = ?, accent = ?, updated_at = ?
      WHERE id = ?
    `).run(title, body, accent, now, id);

    res.json(getPage(db, id));
  });

  // DELETE /api/notebook/pages/:id - permanent, only if already trashed
  router.delete('/pages/:id', (req, res) => {
    const id = Number(req.params.id);
    const page = getPage(db, id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    if (page.trashed_at == null) {
      return res.status(409).json({ error: 'Page must be in trash before permanent delete' });
    }

    db.prepare('DELETE FROM notebook_pages WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  return router;
};
