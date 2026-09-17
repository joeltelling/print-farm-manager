const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  listTimelapses,
  getTimelapse,
  deleteTimelapse,
  stopCapture,
  renderTimelapse,
  frameName,
} = require('../timelapse');

module.exports = (db) => {
  const router = express.Router();

  // GET /api/timelapses
  router.get('/', (req, res) => {
    try {
      res.json(listTimelapses(db, {
        printer_id: req.query.printer_id,
        job_id: req.query.job_id,
        part_id: req.query.part_id,
        status: req.query.status,
        limit: req.query.limit,
      }));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/timelapses/:id
  router.get('/:id', (req, res) => {
    const tl = getTimelapse(db, req.params.id);
    if (!tl) return res.status(404).json({ error: 'Timelapse not found' });
    res.json(tl);
  });

  // GET /api/timelapses/:id/video
  router.get('/:id/video', (req, res) => {
    const tl = getTimelapse(db, req.params.id);
    if (!tl) return res.status(404).json({ error: 'Timelapse not found' });
    if (!tl.video_path || !fs.existsSync(tl.video_path)) {
      return res.status(404).json({ error: 'Video not ready' });
    }
    res.set('Content-Type', 'video/mp4');
    res.set('Cache-Control', 'no-store');
    fs.createReadStream(tl.video_path).pipe(res);
  });

  // GET /api/timelapses/:id/frames/:n
  router.get('/:id/frames/:n', (req, res) => {
    const tl = getTimelapse(db, req.params.id);
    if (!tl) return res.status(404).json({ error: 'Timelapse not found' });
    const n = parseInt(req.params.n, 10);
    if (!Number.isFinite(n) || n < 1) {
      return res.status(400).json({ error: 'frame number must be a positive integer' });
    }
    if (!tl.dir_path) return res.status(404).json({ error: 'No frames' });
    const file = path.join(tl.dir_path, frameName(n));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Frame not found' });
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });

  // POST /api/timelapses/:id/render — re-render from frames
  router.post('/:id/render', async (req, res) => {
    const tl = getTimelapse(db, req.params.id);
    if (!tl) return res.status(404).json({ error: 'Timelapse not found' });
    if (tl.status === 'capturing') {
      return res.status(409).json({ error: 'Still capturing; stop first' });
    }
    try {
      db.prepare(`UPDATE timelapses SET status = 'rendering', render_error = NULL WHERE id = ?`)
        .run(tl.id);
      const out = await renderTimelapse(db, tl.id);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/timelapses/:id
  router.delete('/:id', (req, res) => {
    try {
      res.json(deleteTimelapse(db, req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /api/timelapses/:id/stop — stop a capturing session
  router.post('/:id/stop', (req, res) => {
    try {
      res.json(stopCapture(db, req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  return router;
};
