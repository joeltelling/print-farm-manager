// Tests for server/events.js's insert(), including the `user` param added
// alongside operator-action attribution (see docs/CHANGELOG.md). events.js
// does `require('./db')` at module load, a pre-existing design (not
// parameterized like a route factory), so this mocks that module with a real
// in-memory database rather than exercising it against the production one.

jest.mock('../db', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printer_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id  INTEGER NOT NULL,
      event_type  TEXT NOT NULL,
      note        TEXT,
      created_at  INTEGER NOT NULL,
      user_id     INTEGER,
      user_name   TEXT
    );
  `);
  return db;
});

const db = require('../db');
const events = require('../events');

afterEach(() => db.prepare('DELETE FROM printer_events').run());

function lastEvent() {
  return db.prepare('SELECT * FROM printer_events ORDER BY id DESC LIMIT 1').get();
}

test('stores event_type, note, and created_at', () => {
  events.insert(1, 'job_finished', 'Job 1, Widget (4 parts)');
  const row = lastEvent();
  expect(row.printer_id).toBe(1);
  expect(row.event_type).toBe('job_finished');
  expect(row.note).toBe('Job 1, Widget (4 parts)');
  expect(row.created_at).toBeGreaterThan(0);
});

test('note defaults to null when omitted', () => {
  events.insert(2, 'recommission');
  expect(lastEvent().note).toBeNull();
});

// A system-generated event (the scheduler's own job_finished/offline_with_job/
// recovered/job_cancelled) is never attributed to an operator: no `user` arg.
test('user_id/user_name are null when no user is passed (system event)', () => {
  events.insert(3, 'job_finished', 'Job 2, Widget (4 parts)');
  const row = lastEvent();
  expect(row.user_id).toBeNull();
  expect(row.user_name).toBeNull();
});

test('stores user_id/user_name when a user is passed', () => {
  events.insert(4, 'decommission', 'bad print', { id: 7, name: 'Joel', role: 'admin' });
  const row = lastEvent();
  expect(row.user_id).toBe(7);
  expect(row.user_name).toBe('Joel');
});
