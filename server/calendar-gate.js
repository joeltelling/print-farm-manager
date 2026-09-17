// Shared production-closure gate used by the scheduler (server/scheduler.js) and
// the operator diagnostic GET /api/parts/:id/dispatch-status (server/routes/parts.js).
// Keep both call sites in sync: if the scheduler skips dispatch because of a closure,
// the diagnostic must say the same thing.

/**
 * Returns the first planned calendar event that currently blocks new job
 * reservations, or null if dispatch is allowed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} [now=Date.now()]
 * @returns {{ id: number, title: string, start_at: number, end_at: number|null }|null}
 */
function activeDispatchBlock(db, now = Date.now()) {
  try {
    return db.prepare(`
      SELECT id, title, start_at, end_at FROM calendar_events
      WHERE blocks_dispatch = 1 AND status = 'planned'
        AND start_at <= ?
        AND (end_at IS NULL OR end_at > ?)
      ORDER BY start_at
      LIMIT 1
    `).get(now, now) || null;
  } catch (_) {
    // Table may not exist yet on a partially-migrated install; never throw into
    // the dispatch path.
    return null;
  }
}

module.exports = { activeDispatchBlock };
