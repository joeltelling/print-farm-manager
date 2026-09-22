// Persistent printer event log — records decommission, recommission, job outcomes,
// and freeform operator notes. Events are never deleted.
// No FK constraint on printer_id — history survives printer deletion.

const db = require('./db');

const _insert = db.prepare(
  'INSERT INTO printer_events (printer_id, event_type, note, created_at, user_id, user_name) VALUES (?, ?, ?, ?, ?, ?)'
);

// `user` is the acting operator (req.user, or an equivalent {id, name} shape),
// omitted for a system-generated event (scheduler.js's own job_finished etc.):
// see db.js's user_id/user_name migration comment for why this isn't an FK.
function insert(printerId, eventType, note = null, user = null) {
  _insert.run(printerId, eventType, note ?? null, Date.now(), user?.id ?? null, user?.name ?? null);
}

module.exports = { insert };
