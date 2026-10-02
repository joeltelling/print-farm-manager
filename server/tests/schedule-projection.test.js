// Unit tests for the forward schedule projection (server/projection.js).
//
// The projection is what an operator plans a shift around, so the properties worth pinning
// are: it never writes anything, it decides "busy" from the jobs table rather than the
// lagging polled printer status, it respects the same priority order and per-part ceiling
// as real dispatch, it applies the changeover and staffed-hours model, and its random
// tie-break is stable for a given farm state.
//
// Times are built with local-time Date constructors so the staffed-hours assertions do not
// depend on the machine's timezone.

const Database = require('better-sqlite3');
const {
  projectSchedule,
  nextStaffedMoment,
  nextAvailableAfter,
  effectiveEstimate,
  DEFAULT_PRINT_SECS,
  CHANGEOVER_SECS,
  STAFFED_START_HOUR,
} = require('../projection');

let db;

// A local-time weekday mid-morning, comfortably inside staffed hours.
const MID_MORNING = new Date(2026, 0, 15, 10, 0, 0, 0).getTime();

const HOUR = 3600 * 1000;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT, api_key TEXT,
      group_name TEXT, type TEXT DEFAULT 'prusa', model TEXT NOT NULL,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      job_time_remaining INTEGER, loaded_material TEXT, loaded_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active', priority INTEGER DEFAULT 0,
      required_material TEXT, required_color TEXT, allowed_groups TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0,
      print_time_seconds INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER, material_grams REAL,
      ams_slot INTEGER, allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL REFERENCES printers(id),
      gcode_id INTEGER REFERENCES gcodes(id),
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
  `);
});

// ── Fixture helpers ──────────────────────────────────────────────────────────────

function addPrinter(overrides = {}) {
  const p = {
    name: 'MK4S-1', model: 'mk4s', group_name: null, status: 'IDLE', is_held: 0,
    is_active: 1, job_time_remaining: null, loaded_material: null, loaded_color: null,
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO printers (name, ip, api_key, group_name, model, status, is_held, is_active,
                          job_time_remaining, loaded_material, loaded_color, created_at)
    VALUES (@name, '1.1.1.1', 'k', @group_name, @model, @status, @is_held, @is_active,
            @job_time_remaining, @loaded_material, @loaded_color, 1)
  `).run(p);
  return info.lastInsertRowid;
}

function addProject(overrides = {}) {
  const p = { name: 'Proj', status: 'active', priority: 0, allowed_groups: null,
              required_material: null, required_color: null, created_at: 1, ...overrides };
  return db.prepare(`
    INSERT INTO projects (name, status, priority, required_material, required_color,
                          allowed_groups, created_at, updated_at)
    VALUES (@name, @status, @priority, @required_material, @required_color, @allowed_groups,
            @created_at, 1)
  `).run(p).lastInsertRowid;
}

function addPart(projectId, overrides = {}) {
  const p = { name: 'Part', target_qty: 10, completed_qty: 0, status: 'open',
              sort_order: 0, print_time_seconds: null, created_at: 1, ...overrides };
  return db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, sort_order,
                       print_time_seconds, created_at, updated_at)
    VALUES (?, @name, @target_qty, @completed_qty, @status, @sort_order,
            @print_time_seconds, @created_at, 1)
  `).run(projectId, p).lastInsertRowid;
}

function addGcode(partId, overrides = {}) {
  const g = { printer_model: 'mk4s', filename: 'part.gcode', filepath: 'part.gcode',
              parts_per_plate: 1, est_print_secs: 3600, allowed_groups: null,
              required_material: null, required_color: null, ...overrides };
  return db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate,
                        est_print_secs, allowed_groups, required_material, required_color,
                        created_at)
    VALUES (?, @printer_model, @filename, @filepath, @parts_per_plate, @est_print_secs,
            @allowed_groups, @required_material, @required_color, 1)
  `).run(partId, g).lastInsertRowid;
}

function addJob(partId, printerId, gcodeId, overrides = {}) {
  const j = { parts_per_plate: 1, status: 'printing', started_at: null, created_at: 1, ...overrides };
  return db.prepare(`
    INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at)
    VALUES (?, ?, ?, @parts_per_plate, @status, @started_at, @created_at)
  `).run(partId, printerId, gcodeId, j).lastInsertRowid;
}

function project(options = {}) {
  return projectSchedule(db, { now: MID_MORNING, version: 'abcdef1234567890', ...options });
}

// ── Clock model ──────────────────────────────────────────────────────────────────

describe('staffed hours and changeover', () => {
  test('a finish inside staffed hours is signed off immediately', () => {
    const at = new Date(2026, 0, 15, 14, 30, 0, 0).getTime();
    expect(nextStaffedMoment(at)).toBe(at);
    expect(nextAvailableAfter(at)).toBe(at + CHANGEOVER_SECS * 1000);
  });

  test('a finish after the last shift waits for the next morning', () => {
    const at = new Date(2026, 0, 15, 23, 10, 0, 0).getTime();
    const expected = new Date(2026, 0, 16, STAFFED_START_HOUR, 0, 0, 0).getTime();
    expect(nextStaffedMoment(at)).toBe(expected);
    expect(nextAvailableAfter(at)).toBe(expected + CHANGEOVER_SECS * 1000);
  });

  test('a finish in the small hours waits for the same morning', () => {
    const at = new Date(2026, 0, 15, 3, 0, 0, 0).getTime();
    const expected = new Date(2026, 0, 15, STAFFED_START_HOUR, 0, 0, 0).getTime();
    expect(nextStaffedMoment(at)).toBe(expected);
  });

  test('the boundary hours themselves are staffed at 06:00 and closed at 22:00', () => {
    const sixAm     = new Date(2026, 0, 15, 6, 0, 0, 0).getTime();
    const tenPm     = new Date(2026, 0, 15, 22, 0, 0, 0).getTime();
    const nextSixAm = new Date(2026, 0, 16, 6, 0, 0, 0).getTime();
    expect(nextStaffedMoment(sixAm)).toBe(sixAm);
    expect(nextStaffedMoment(tenPm)).toBe(nextSixAm);
  });
});

describe('effectiveEstimate precedence', () => {
  test('G-code estimate wins over the part estimate', () => {
    expect(effectiveEstimate(1800, 7200)).toEqual({ secs: 1800, source: 'gcode', unknown: false });
  });

  test('part estimate is used when the G-code has none', () => {
    expect(effectiveEstimate(null, 5400)).toEqual({ secs: 5400, source: 'part', unknown: false });
  });

  test('falls back to the documented default and flags the time as unknown', () => {
    expect(effectiveEstimate(null, null)).toEqual({
      secs: DEFAULT_PRINT_SECS, source: 'default', unknown: true,
    });
  });
});

// ── Block placement ──────────────────────────────────────────────────────────────

describe('projected blocks', () => {
  test('an idle printer starts its first block now, sized by the G-code estimate', () => {
    const printerId = addPrinter();
    const partId = addPart(addProject(), { target_qty: 1 });
    addGcode(partId, { est_print_secs: 5400 });

    const result = project();
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      kind: 'projected',
      printer_id: printerId,
      part_id: partId,
      start: MID_MORNING,
      end: MID_MORNING + 5400 * 1000,
      est_secs: 5400,
      time_source: 'gcode',
      time_unknown: false,
    });
  });

  test('a part with no G-code estimate uses the part-level estimate', () => {
    addPrinter();
    const partId = addPart(addProject(), { target_qty: 1, print_time_seconds: 4500 });
    addGcode(partId, { est_print_secs: null });

    const [block] = project().blocks;
    expect(block.est_secs).toBe(4500);
    expect(block.time_source).toBe('part');
    expect(block.time_unknown).toBe(false);
  });

  test('with no estimate anywhere the block is the two-hour default, flagged unknown', () => {
    addPrinter();
    const partId = addPart(addProject(), { target_qty: 1 });
    addGcode(partId, { est_print_secs: null });

    const [block] = project().blocks;
    expect(block.est_secs).toBe(DEFAULT_PRINT_SECS);
    expect(block.est_secs).toBe(2 * 3600);
    expect(block.time_source).toBe('default');
    expect(block.time_unknown).toBe(true);
  });

  test('consecutive blocks on one printer are separated by the changeover', () => {
    addPrinter();
    const partId = addPart(addProject(), { target_qty: 3 });
    addGcode(partId, { est_print_secs: 3600, parts_per_plate: 1 });

    const { blocks } = project();
    expect(blocks).toHaveLength(3);
    expect(blocks[1].start).toBe(blocks[0].end + CHANGEOVER_SECS * 1000);
    expect(blocks[2].start).toBe(blocks[1].end + CHANGEOVER_SECS * 1000);
  });

  test('a block finishing after the last shift pushes the next start to the morning', () => {
    // 21:00 start, a 2 h print ends at 23:00, so the plate is not swapped until 06:00.
    const lateEvening = new Date(2026, 0, 15, 21, 0, 0, 0).getTime();
    addPrinter();
    const partId = addPart(addProject(), { target_qty: 2 });
    addGcode(partId, { est_print_secs: 2 * 3600, parts_per_plate: 1 });

    const { blocks } = project({ now: lateEvening, horizonHours: 48 });
    expect(blocks).toHaveLength(2);
    const nextMorning = new Date(2026, 0, 16, STAFFED_START_HOUR, 0, 0, 0).getTime();
    expect(blocks[1].start).toBe(nextMorning + CHANGEOVER_SECS * 1000);
  });
});

// ── Busy detection: the whole point of not trusting printers.status ──────────────

describe('busy detection comes from the jobs table, not the polled status', () => {
  test('a just-dispatched printer still reporting FINISHED is busy, not free', () => {
    // Exactly the reported symptom: the scheduler wrote the job row synchronously, but the
    // 15 s poll has not run, so printers.status is still the previous FINISHED.
    const printerId = addPrinter({ status: 'FINISHED', is_held: 0 });
    const partId = addPart(addProject(), { target_qty: 5 });
    const gcodeId = addGcode(partId, { est_print_secs: 3600, parts_per_plate: 1 });
    addJob(partId, printerId, gcodeId, { status: 'printing', started_at: MID_MORNING });

    const { blocks, printers } = project();
    const active = blocks.filter(b => b.kind === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].end).toBe(MID_MORNING + 3600 * 1000);

    // No projected block may start before the running one has finished and been cleared.
    const projected = blocks.filter(b => b.kind === 'projected');
    expect(projected.length).toBeGreaterThan(0);
    for (const b of projected) {
      expect(b.start).toBeGreaterThanOrEqual(active[0].end + CHANGEOVER_SECS * 1000);
    }
    expect(printers[0].available_at).toBe(nextAvailableAfter(active[0].end));
  });

  test('an uploading job blocks the printer even before the print starts', () => {
    const printerId = addPrinter({ status: 'IDLE' });
    const partId = addPart(addProject(), { target_qty: 5 });
    const gcodeId = addGcode(partId, { est_print_secs: 1800 });
    addJob(partId, printerId, gcodeId, { status: 'uploading', started_at: null });

    const { blocks } = project();
    const active = blocks.filter(b => b.kind === 'active');
    expect(active).toHaveLength(1);
    // The print has not begun, so its clock starts now rather than at a start time it
    // does not have yet.
    expect(active[0].start).toBe(MID_MORNING);
    expect(active[0].end).toBe(MID_MORNING + 1800 * 1000);
  });

  test('live time-remaining from a printing printer beats the stored estimate', () => {
    const printerId = addPrinter({ status: 'PRINTING', job_time_remaining: 600 });
    const partId = addPart(addProject(), { target_qty: 5 });
    const gcodeId = addGcode(partId, { est_print_secs: 9999 });
    addJob(partId, printerId, gcodeId, { status: 'printing', started_at: MID_MORNING - HOUR });

    const [active] = project().blocks.filter(b => b.kind === 'active');
    expect(active.end).toBe(MID_MORNING + 600 * 1000);
  });

  test('a finished-but-unresolved job ends now, not at its original estimate', () => {
    // The "awaiting sign-off" case: the printer reports FINISHED while the job row is
    // still 'printing' because nothing has resolved it yet. The plate is off the nozzle,
    // so the block must not run on to an estimate the farm has already outlived.
    const printerId = addPrinter({ status: 'FINISHED', is_held: 1 });
    const partId = addPart(addProject(), { target_qty: 5 });
    const gcodeId = addGcode(partId, { est_print_secs: 6 * 3600 });
    addJob(partId, printerId, gcodeId, { status: 'printing', started_at: MID_MORNING - 2 * HOUR });

    const { blocks, printers } = project();
    const [active] = blocks.filter(b => b.kind === 'active');
    expect(active.end).toBe(MID_MORNING);
    expect(printers[0].available_at).toBe(MID_MORNING + CHANGEOVER_SECS * 1000);
  });

  test('a just-dispatched job is not mistaken for a finished one', () => {
    // The same shape as the test above, but seconds old instead of hours: printers.status
    // is simply the stale pre-dispatch value. Collapsing this block would free the lane
    // and project a phantom second job onto a printer that is actually busy.
    const printerId = addPrinter({ status: 'FINISHED', is_held: 0 });
    const partId = addPart(addProject(), { target_qty: 5 });
    const gcodeId = addGcode(partId, { est_print_secs: 3600 });
    addJob(partId, printerId, gcodeId, { status: 'printing', started_at: MID_MORNING - 5000 });

    const [active] = project().blocks.filter(b => b.kind === 'active');
    expect(active.end).toBe(MID_MORNING - 5000 + 3600 * 1000);
  });

  test('an offline printer mid-print keeps its estimated finish', () => {
    // A printer can be unreachable while its print carries on: the transient MQTT drop
    // the scheduler protects against. OFFLINE is not evidence the plate is done.
    const printerId = addPrinter({ status: 'OFFLINE', is_held: 1 });
    const partId = addPart(addProject(), { target_qty: 5 });
    const gcodeId = addGcode(partId, { est_print_secs: 4 * 3600 });
    addJob(partId, printerId, gcodeId, { status: 'printing', started_at: MID_MORNING - HOUR });

    const [active] = project().blocks.filter(b => b.kind === 'active');
    expect(active.end).toBe(MID_MORNING - HOUR + 4 * HOUR);
  });

  test('a print past its estimate ends now rather than in the past', () => {
    const printerId = addPrinter({ status: 'PRINTING', job_time_remaining: null });
    const partId = addPart(addProject(), { target_qty: 5 });
    const gcodeId = addGcode(partId, { est_print_secs: 60 });
    addJob(partId, printerId, gcodeId, { status: 'printing', started_at: MID_MORNING - 10 * HOUR });

    const [active] = project().blocks.filter(b => b.kind === 'active');
    expect(active.end).toBe(MID_MORNING);
  });
});

// ── Printer availability states ──────────────────────────────────────────────────

describe('printer availability', () => {
  test('a held printer with no job needs a changeover and says why', () => {
    addPrinter({ status: 'FINISHED', is_held: 1 });
    const partId = addPart(addProject(), { target_qty: 1 });
    addGcode(partId);

    const { printers, blocks } = project();
    expect(printers[0].blocked_reason).toBe('Awaiting operator sign-off');
    expect(printers[0].available_at).toBe(MID_MORNING + CHANGEOVER_SECS * 1000);
    expect(blocks[0].start).toBe(MID_MORNING + CHANGEOVER_SECS * 1000);
  });

  test('an offline printer with no job is not projected at all', () => {
    addPrinter({ status: 'OFFLINE', is_held: 0 });
    const partId = addPart(addProject(), { target_qty: 1 });
    addGcode(partId);

    const { printers, blocks } = project();
    expect(printers[0].available_at).toBeNull();
    expect(printers[0].blocked_reason).toBe('Printer is OFFLINE');
    expect(blocks).toHaveLength(0);
  });

  test('decommissioned printers are excluded entirely', () => {
    addPrinter({ name: 'Retired', is_active: 0 });
    const partId = addPart(addProject(), { target_qty: 1 });
    addGcode(partId);

    const { printers, blocks } = project();
    expect(printers).toHaveLength(0);
    expect(blocks).toHaveLength(0);
  });
});

// ── Demand accounting ────────────────────────────────────────────────────────────

describe('quantity accounting', () => {
  test('stops projecting once open demand is met', () => {
    addPrinter();
    const partId = addPart(addProject(), { target_qty: 6, completed_qty: 2 });
    addGcode(partId, { parts_per_plate: 2, est_print_secs: 1800 });

    // 4 remaining at 2 per plate is exactly 2 more plates.
    expect(project().blocks).toHaveLength(2);
  });

  test('jobs already in flight count against remaining demand', () => {
    const printerId = addPrinter({ name: 'A', status: 'PRINTING' });
    addPrinter({ name: 'B', status: 'IDLE' });
    const partId = addPart(addProject(), { target_qty: 2 });
    const gcodeId = addGcode(partId, { parts_per_plate: 1, est_print_secs: 1800 });
    addJob(partId, printerId, gcodeId, { status: 'printing', started_at: MID_MORNING, parts_per_plate: 1 });

    const { blocks } = project();
    // One plate is already running, so only one more is needed across the whole farm.
    expect(blocks.filter(b => b.kind === 'active')).toHaveLength(1);
    expect(blocks.filter(b => b.kind === 'projected')).toHaveLength(1);
  });

  test('a second printer falls through to the next part when the first is fully covered', () => {
    addPrinter({ name: 'A' });
    addPrinter({ name: 'B' });
    const projectId = addProject();
    const first  = addPart(projectId, { name: 'First',  target_qty: 1, sort_order: 0 });
    const second = addPart(projectId, { name: 'Second', target_qty: 1, sort_order: 1 });
    addGcode(first,  { est_print_secs: 3600 });
    addGcode(second, { est_print_secs: 3600 });

    const { blocks } = project();
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks.map(b => b.part_id))).toEqual(new Set([first, second]));
    // Both start immediately: two idle printers, two parts, one plate each.
    expect(blocks.every(b => b.start === MID_MORNING)).toBe(true);
  });

  test('project priority orders what gets printed first', () => {
    addPrinter();
    const low  = addProject({ name: 'Low',  priority: 5 });
    const high = addProject({ name: 'High', priority: 1 });
    const lowPart  = addPart(low,  { target_qty: 1 });
    const highPart = addPart(high, { target_qty: 1 });
    addGcode(lowPart,  { est_print_secs: 3600 });
    addGcode(highPart, { est_print_secs: 3600 });

    const { blocks } = project();
    expect(blocks[0].part_id).toBe(highPart);
    expect(blocks[1].part_id).toBe(lowPart);
  });

  test('targeting rules exclude a printer that cannot run the part', () => {
    addPrinter({ name: 'PLA machine', loaded_material: 'PLA' });
    const partId = addPart(addProject(), { target_qty: 1 });
    addGcode(partId, { required_material: 'PETG' });

    const { blocks, unscheduled } = project();
    expect(blocks).toHaveLength(0);
    expect(unscheduled).toEqual([
      expect.objectContaining({ part_id: partId, remaining_qty: 1, reason: 'no_eligible_printer' }),
    ]);
  });

  test('a part in a non-active project is never projected', () => {
    addPrinter();
    const draft = addProject({ status: 'draft' });
    const partId = addPart(draft, { target_qty: 1 });
    addGcode(partId);

    const { blocks, unscheduled } = project();
    expect(blocks).toHaveLength(0);
    expect(unscheduled).toHaveLength(0);
  });
});

// ── Tie-break ────────────────────────────────────────────────────────────────────

describe('random tie-break among printers that come free together', () => {
  function twoTiedPrintersOnePart() {
    addPrinter({ name: 'A' });
    addPrinter({ name: 'B' });
    const partId = addPart(addProject(), { target_qty: 1 });
    addGcode(partId, { est_print_secs: 3600 });
    return partId;
  }

  test('the same farm state always produces the same winner', () => {
    twoTiedPrintersOnePart();
    const first  = project({ version: 'deadbeefdeadbeef' });
    const second = project({ version: 'deadbeefdeadbeef' });
    expect(first.blocks).toEqual(second.blocks);
  });

  test('the winner is genuinely random across differing farm states', () => {
    twoTiedPrintersOnePart();
    const winners = new Set();
    // Each distinct fingerprint reseeds the shuffle. Over a spread of seeds both tied
    // printers must be able to win, otherwise the "random" pick is really a fixed order.
    for (let i = 0; i < 40; i++) {
      const [block] = project({ version: (0x1000000 + i * 7919).toString(16) }).blocks;
      winners.add(block.printer_id);
    }
    expect(winners.size).toBe(2);
  });

  test('printers that are not tied keep their strict order regardless of seed', () => {
    const busyId = addPrinter({ name: 'Busy', status: 'PRINTING', job_time_remaining: 4 * 3600 });
    addPrinter({ name: 'Free', status: 'IDLE' });
    const partId = addPart(addProject(), { target_qty: 1 });
    const gcodeId = addGcode(partId, { est_print_secs: 3600 });
    addJob(partId, busyId, gcodeId, { status: 'printing', started_at: MID_MORNING, parts_per_plate: 0 });

    for (let i = 0; i < 10; i++) {
      const projected = project({ version: (0x2000000 + i * 104729).toString(16) })
        .blocks.filter(b => b.kind === 'projected');
      // The free printer is hours ahead of the busy one, so it always takes the work.
      expect(projected[0].printer_id).not.toBe(busyId);
    }
  });
});

// ── Horizon and safety ───────────────────────────────────────────────────────────

describe('horizon', () => {
  test('demand past the horizon is reported rather than silently dropped', () => {
    addPrinter();
    const partId = addPart(addProject(), { target_qty: 50 });
    addGcode(partId, { est_print_secs: 4 * 3600, parts_per_plate: 1 });

    const result = project({ horizonHours: 12 });
    expect(result.truncated).toBe(true);
    expect(result.blocks.every(b => b.start <= result.horizon_end)).toBe(true);
    expect(result.unscheduled[0]).toMatchObject({
      part_id: partId,
      reason: 'beyond_horizon',
    });
    // Some demand was placed, the rest is accounted for.
    const placed = result.blocks.length;
    expect(result.unscheduled[0].remaining_qty).toBe(50 - placed);
  });

  test('assumptions are reported so the page can state them', () => {
    expect(project().assumptions).toEqual({
      default_print_secs: 7200,
      changeover_secs: 900,
      staffed_start_hour: 6,
      staffed_end_hour: 22,
      tie_window_secs: 60,
    });
  });
});

describe('the projection is read-only', () => {
  test('no rows are written and no quantity is credited', () => {
    const printerId = addPrinter({ status: 'PRINTING' });
    const partId = addPart(addProject(), { target_qty: 20, completed_qty: 3 });
    const gcodeId = addGcode(partId, { parts_per_plate: 2, est_print_secs: 1800 });
    addJob(partId, printerId, gcodeId, { status: 'printing', started_at: MID_MORNING, parts_per_plate: 2 });

    const before = {
      jobs:     db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,
      parts:    db.prepare('SELECT completed_qty, status, updated_at FROM parts WHERE id = ?').get(partId),
      printers: db.prepare('SELECT status, is_held FROM printers WHERE id = ?').get(printerId),
    };

    const result = project();
    expect(result.blocks.length).toBeGreaterThan(1);

    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(before.jobs);
    expect(db.prepare('SELECT completed_qty, status, updated_at FROM parts WHERE id = ?').get(partId))
      .toEqual(before.parts);
    expect(db.prepare('SELECT status, is_held FROM printers WHERE id = ?').get(printerId))
      .toEqual(before.printers);
  });
});
