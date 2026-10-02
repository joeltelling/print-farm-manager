// Freshness fingerprint for the forward schedule.
//
// The schedule is derived state: it is a function of the printers, the open parts, their
// G-code estimates, the project priorities, and the active job rows. The client needs to
// know when its copy is out of date so it can show a recalculating state instead of
// silently rendering numbers the server already knows are wrong.
//
// This is a fingerprint of the inputs rather than a counter that mutation sites increment.
// A counter needs a bump() call at every write that matters (dispatch, poll, estimate
// edit, reorder, target_qty change, project activation) and silently goes stale the first
// time a new write path forgets one: exactly the drift this codebase keeps paying for
// elsewhere. Hashing the inputs cannot forget, because there is nothing to remember.
//
// Deliberately excluded: printers.job_progress and printers.job_time_remaining. Those
// change on every 15 s poll of every printing printer. Including them would change the
// fingerprint constantly and pin the UI in a permanent "recalculating" state, which is
// the same lie as stale data wearing a spinner. Live progress moves the leading edge of
// the in-progress block, which the client picks up on its own refresh; the fingerprint is
// for structural change (a job started, an estimate was edited, a part closed).
//
// The Print Queue (GET /api/parts/queue) is built from these same inputs and returns this
// fingerprint too, so a new input to either view belongs in the hash.
//
// Rows are limited to active projects because only those can be scheduled. That bounds the
// scan on a farm with years of completed project history, and a project's own status is
// part of the hash, so activating one changes the fingerprint and pulls its parts in.

const crypto = require('crypto');

// Bumped when the set of hashed inputs changes, so an old client's fingerprint can never
// accidentally compare equal to a new server's.
const FINGERPRINT_VERSION = 'v1';

function fingerprint(db) {
  const h = crypto.createHash('sha1');
  h.update(FINGERPRINT_VERSION);

  for (const p of db.prepare(`
    SELECT id, status, is_held, model, group_name, loaded_material, loaded_color
    FROM printers WHERE is_active = 1 ORDER BY id
  `).all()) {
    h.update(`P${p.id}|${p.status}|${p.is_held}|${p.model}|${p.group_name || ''}|${p.loaded_material || ''}|${p.loaded_color || ''};`);
  }

  for (const pr of db.prepare(`
    SELECT id, status, priority, required_material, required_color, allowed_groups
    FROM projects WHERE status = 'active' ORDER BY id
  `).all()) {
    h.update(`J${pr.id}|${pr.status}|${pr.priority}|${pr.required_material || ''}|${pr.required_color || ''}|${pr.allowed_groups || ''};`);
  }

  for (const pt of db.prepare(`
    SELECT parts.id, parts.status, parts.target_qty, parts.completed_qty, parts.sort_order,
           parts.print_time_seconds
    FROM parts JOIN projects ON projects.id = parts.project_id
    WHERE projects.status = 'active' ORDER BY parts.id
  `).all()) {
    h.update(`T${pt.id}|${pt.status}|${pt.target_qty}|${pt.completed_qty}|${pt.sort_order}|${pt.print_time_seconds ?? ''};`);
  }

  for (const g of db.prepare(`
    SELECT gcodes.id, gcodes.part_id, gcodes.printer_model, gcodes.parts_per_plate,
           gcodes.est_print_secs, gcodes.allowed_groups, gcodes.required_material,
           gcodes.required_color
    FROM gcodes
    JOIN parts    ON parts.id    = gcodes.part_id
    JOIN projects ON projects.id = parts.project_id
    WHERE projects.status = 'active' ORDER BY gcodes.id
  `).all()) {
    h.update(`G${g.id}|${g.part_id}|${g.printer_model}|${g.parts_per_plate}|${g.est_print_secs ?? ''}|${g.allowed_groups || ''}|${g.required_material || ''}|${g.required_color || ''};`);
  }

  // Only jobs the projection consumes. A finished job's effect on the schedule is already
  // captured by parts.completed_qty above.
  for (const j of db.prepare(`
    SELECT id, printer_id, part_id, status, parts_per_plate, started_at, created_at
    FROM jobs WHERE status IN ('uploading', 'printing') ORDER BY id
  `).all()) {
    h.update(`B${j.id}|${j.printer_id}|${j.part_id}|${j.status}|${j.parts_per_plate}|${j.started_at ?? ''}|${j.created_at};`);
  }

  return h.digest('hex').slice(0, 16);
}

module.exports = { fingerprint, FINGERPRINT_VERSION };
