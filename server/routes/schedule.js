const express = require('express');
const router  = express.Router();

const { projectSchedule, DEFAULT_HORIZON_HOURS, MAX_HORIZON_HOURS } = require('../projection');
const { fingerprint } = require('../schedule-state');

module.exports = (db) => {
  // GET /api/schedule/version: just the freshness fingerprint of the schedule's inputs.
  // Declared before the collection route out of habit for this codebase's route ordering
  // rule. Cheap by design: the page polls it to decide whether its rendered schedule is
  // stale, and only refetches the full projection when the fingerprint moved.
  router.get('/version', (_req, res) => {
    res.json({ version: fingerprint(db) });
  });

  // GET /api/schedule: the forward-looking projection.
  // Read-only: computes nothing into the database, dispatches nothing.
  router.get('/', (req, res) => {
    const { horizon_hours } = req.query;

    let horizonHours = DEFAULT_HORIZON_HOURS;
    if (horizon_hours !== undefined && horizon_hours !== '') {
      const parsed = Number(horizon_hours);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_HORIZON_HOURS) {
        return res.status(400).json({
          error: `horizon_hours must be a number between 1 and ${MAX_HORIZON_HOURS}`,
        });
      }
      horizonHours = parsed;
    }

    res.json(projectSchedule(db, { horizonHours }));
  });

  return router;
};
