const express = require('express');

// mergeParams: true so that :id from the parent printers router is visible here
const router = express.Router({ mergeParams: true });

module.exports = (db) => {
  // GET /api/printers/:id/events — full event timeline, newest first
  router.get('/', (req, res) => {
    const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    const events = db.prepare(
      'SELECT * FROM printer_events WHERE printer_id = ? ORDER BY created_at DESC'
    ).all(req.params.id);
    res.json(events);
  });

  // POST /api/printers/:id/events — add a freeform operator note
  router.post('/', (req, res) => {
    const printer = db.prepare('SELECT id FROM printers WHERE id = ?').get(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    const { note } = req.body;
    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'note is required' });
    }
    const result = db.prepare(
      'INSERT INTO printer_events (printer_id, event_type, note, created_at, user_id, user_name) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.params.id, 'note', note.trim(), Date.now(), req.user?.id ?? null, req.user?.name ?? null);
    res.status(201).json(
      db.prepare('SELECT * FROM printer_events WHERE id = ?').get(result.lastInsertRowid)
    );
  });

  return router;
};
