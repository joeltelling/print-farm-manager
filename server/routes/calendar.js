const express = require('express');
const { activeDispatchBlock } = require('../calendar-gate');

const EVENT_TYPES = new Set([
  'stock_arrival',
  'shipment',
  'deadline',
  'production_closure',
  'note',
]);

const EVENT_STATUSES = new Set(['planned', 'done', 'cancelled']);

function tableExists(db, name) {
  const row = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name);
  return !!row;
}

// ERP dates are TEXT ISO (or YYYY-MM-DD); shopfloor is INTEGER ms. Normalize
// everything in the overview response to epoch milliseconds.
function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

function overlapsRange(startAt, endAt, from, to) {
  const start = startAt ?? 0;
  const end = endAt == null ? start : endAt;
  return start < to && end >= from;
}

function parseRange(query) {
  const from = Number(query.from);
  const to = Number(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { error: 'from and to are required as epoch milliseconds' };
  }
  if (to < from) {
    return { error: 'to must be greater than or equal to from' };
  }
  return { from, to };
}

function validateEventBody(body, { partial = false } = {}) {
  const errors = [];

  if (!partial || body.event_type !== undefined) {
    const type = body.event_type;
    if (!type || !EVENT_TYPES.has(type)) {
      errors.push('event_type must be one of: ' + [...EVENT_TYPES].join(', '));
    }
  }

  if (!partial || body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) errors.push('title is required');
  }

  if (!partial || body.start_at !== undefined) {
    const startAt = Number(body.start_at);
    if (!Number.isFinite(startAt)) errors.push('start_at is required as epoch milliseconds');
  }

  if (body.end_at !== undefined && body.end_at !== null) {
    const endAt = Number(body.end_at);
    if (!Number.isFinite(endAt)) errors.push('end_at must be epoch milliseconds or null');
  }

  if (!partial || body.status !== undefined) {
    if (body.status != null && !EVENT_STATUSES.has(body.status)) {
      errors.push('status must be one of: ' + [...EVENT_STATUSES].join(', '));
    }
  }

  if (errors.length) return { error: errors.join('; ') };

  const startAt = body.start_at !== undefined ? Number(body.start_at) : undefined;
  const endAt = body.end_at === undefined
    ? undefined
    : (body.end_at === null || body.end_at === '' ? null : Number(body.end_at));

  if (startAt !== undefined && endAt != null && endAt < startAt) {
    return { error: 'end_at must be greater than or equal to start_at' };
  }

  return { startAt, endAt };
}

// When blocks_dispatch will be 1 after create/update, end_at is required so a
// closure cannot lock the farm forever.
function requireClosureEnd(blocksDispatch, endAt, existingEndAt) {
  const blocks = blocksDispatch === 1 || blocksDispatch === true || blocksDispatch === '1';
  if (!blocks) return null;
  const resolved = endAt !== undefined ? endAt : existingEndAt;
  if (resolved == null) {
    return 'end_at is required when blocks_dispatch is set (production closures cannot be open-ended)';
  }
  return null;
}

module.exports = (db) => {
  const router = express.Router();

  // Static paths before /events/:id
  router.get('/dispatch-block', (_req, res) => {
    const block = activeDispatchBlock(db);
    res.json({ active: !!block, block });
  });

  router.get('/overview', (req, res) => {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const items = [];

    const jobs = db.prepare(`
      SELECT j.id, j.status, j.started_at, j.finished_at, j.created_at,
             p.name AS part_name, pr.name AS printer_name
      FROM jobs j
      LEFT JOIN parts p ON p.id = j.part_id
      LEFT JOIN printers pr ON pr.id = j.printer_id
      WHERE COALESCE(j.started_at, j.created_at) < ?
        AND COALESCE(j.finished_at, j.started_at, j.created_at) >= ?
    `).all(to, from);

    for (const j of jobs) {
      const start = j.started_at ?? j.created_at;
      const end = j.finished_at ?? null;
      items.push({
        source: 'job',
        id: j.id,
        title: j.part_name
          ? `Print: ${j.part_name}${j.printer_name ? ` on ${j.printer_name}` : ''}`
          : `Job #${j.id}`,
        start_at: start,
        end_at: end,
        status: j.status,
      });
    }

    if (tableExists(db, 'sales_order')) {
      const sales = db.prepare(`
        SELECT id, sku, qty, sale_date
        FROM sales_order
      `).all();
      for (const s of sales) {
        const start = toEpochMs(s.sale_date);
        if (start == null || !overlapsRange(start, start, from, to)) continue;
        items.push({
          source: 'sale',
          id: s.id,
          title: s.sku ? `Sale: ${s.sku} x${s.qty}` : `Sale #${s.id}`,
          start_at: start,
          end_at: null,
          status: 'posted',
          item_sku: s.sku || null,
        });
      }
    }

    if (tableExists(db, 'stock_move')) {
      const moves = db.prepare(`
        SELECT id, item_id, qty, trans_date, created_at, note
        FROM stock_move
        WHERE qty > 0
      `).all();
      for (const m of moves) {
        const start = toEpochMs(m.trans_date) ?? toEpochMs(m.created_at);
        if (start == null || !overlapsRange(start, start, from, to)) continue;
        items.push({
          source: 'stock_receipt',
          id: m.id,
          title: m.note ? `Stock in: ${m.note}` : `Stock receipt #${m.id}`,
          start_at: start,
          end_at: null,
          status: 'posted',
        });
      }
    }

    if (tableExists(db, 'work_order')) {
      const wos = db.prepare(`
        SELECT id, status, created_at, completed_at, qty
        FROM work_order
      `).all();
      for (const w of wos) {
        const created = toEpochMs(w.created_at);
        if (created != null && overlapsRange(created, created, from, to)) {
          items.push({
            source: 'work_order',
            id: w.id,
            title: `WO #${w.id} opened`,
            start_at: created,
            end_at: null,
            status: w.status,
          });
        }
        const completed = toEpochMs(w.completed_at);
        if (completed != null && overlapsRange(completed, completed, from, to)) {
          items.push({
            source: 'work_order',
            id: w.id,
            title: `WO #${w.id} completed`,
            start_at: completed,
            end_at: null,
            status: w.status,
          });
        }
      }
    }

    items.sort((a, b) => (a.start_at || 0) - (b.start_at || 0));
    res.json({ from, to, items });
  });

  router.get('/events', (req, res) => {
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    const { from, to } = range;
    const type = req.query.type ? String(req.query.type) : null;
    if (type && !EVENT_TYPES.has(type)) {
      return res.status(400).json({ error: 'invalid event type filter' });
    }

    let sql = `
      SELECT * FROM calendar_events
      WHERE start_at < ?
        AND COALESCE(end_at, start_at) >= ?
    `;
    const params = [to, from];
    if (type) {
      sql += ' AND event_type = ?';
      params.push(type);
    }
    sql += ' ORDER BY start_at ASC, id ASC';
    res.json(db.prepare(sql).all(...params));
  });

  router.post('/events', (req, res) => {
    const body = req.body || {};
    const checked = validateEventBody(body, { partial: false });
    if (checked.error) return res.status(400).json({ error: checked.error });

    const title = String(body.title).trim();
    const eventType = body.event_type;
    const blocksDispatch = body.blocks_dispatch === 1 || body.blocks_dispatch === true || body.blocks_dispatch === '1' ? 1 : 0;
    // production_closure defaults to blocking when the operator did not override.
    const willBlock = eventType === 'production_closure' && body.blocks_dispatch === undefined
      ? 1
      : blocksDispatch;

    const endAt = checked.endAt === undefined ? null : checked.endAt;
    const closureErr = requireClosureEnd(willBlock, endAt, null);
    if (closureErr) return res.status(400).json({ error: closureErr });

    if (body.project_id != null) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(body.project_id);
      if (!project) return res.status(400).json({ error: 'project_id not found' });
    }

    const now = Date.now();
    const allDay = body.all_day === 0 || body.all_day === false || body.all_day === '0' ? 0 : 1;
    const status = EVENT_STATUSES.has(body.status) ? body.status : 'planned';
    const notes = body.notes != null ? String(body.notes) : null;
    const itemSku = body.item_sku != null && String(body.item_sku).trim() !== ''
      ? String(body.item_sku).trim()
      : null;
    const projectId = body.project_id != null ? Number(body.project_id) : null;

    const result = db.prepare(`
      INSERT INTO calendar_events (
        event_type, title, notes, start_at, end_at, all_day, status,
        blocks_dispatch, project_id, item_sku, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventType,
      title,
      notes,
      checked.startAt,
      endAt,
      allDay,
      status,
      willBlock,
      projectId,
      itemSku,
      now,
      now,
    );

    const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  });

  router.put('/events/:id', (req, res) => {
    const existing = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const body = req.body || {};
    const checked = validateEventBody(body, { partial: true });
    if (checked.error) return res.status(400).json({ error: checked.error });

    const nextType = body.event_type !== undefined ? body.event_type : existing.event_type;
    const nextBlocks = body.blocks_dispatch !== undefined
      ? (body.blocks_dispatch === 1 || body.blocks_dispatch === true || body.blocks_dispatch === '1' ? 1 : 0)
      : existing.blocks_dispatch;
    const nextEnd = checked.endAt !== undefined ? checked.endAt : existing.end_at;
    const nextStart = checked.startAt !== undefined ? checked.startAt : existing.start_at;

    if (nextEnd != null && nextEnd < nextStart) {
      return res.status(400).json({ error: 'end_at must be greater than or equal to start_at' });
    }

    const closureErr = requireClosureEnd(nextBlocks, nextEnd, null);
    if (closureErr) return res.status(400).json({ error: closureErr });

    if (body.project_id !== undefined && body.project_id != null) {
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(body.project_id);
      if (!project) return res.status(400).json({ error: 'project_id not found' });
    }

    const title = body.title !== undefined ? String(body.title).trim() : existing.title;
    const notes = body.notes !== undefined
      ? (body.notes == null ? null : String(body.notes))
      : existing.notes;
    const allDay = body.all_day !== undefined
      ? (body.all_day === 0 || body.all_day === false || body.all_day === '0' ? 0 : 1)
      : existing.all_day;
    const status = body.status !== undefined ? body.status : existing.status;
    const projectId = body.project_id !== undefined
      ? (body.project_id == null ? null : Number(body.project_id))
      : existing.project_id;
    const itemSku = body.item_sku !== undefined
      ? (body.item_sku == null || String(body.item_sku).trim() === '' ? null : String(body.item_sku).trim())
      : existing.item_sku;

    db.prepare(`
      UPDATE calendar_events SET
        event_type = COALESCE(?, event_type),
        title = COALESCE(?, title),
        notes = ?,
        start_at = COALESCE(?, start_at),
        end_at = ?,
        all_day = COALESCE(?, all_day),
        status = COALESCE(?, status),
        blocks_dispatch = COALESCE(?, blocks_dispatch),
        project_id = ?,
        item_sku = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      body.event_type !== undefined ? nextType : null,
      body.title !== undefined ? title : null,
      notes,
      checked.startAt !== undefined ? checked.startAt : null,
      nextEnd,
      body.all_day !== undefined ? allDay : null,
      body.status !== undefined ? status : null,
      body.blocks_dispatch !== undefined ? nextBlocks : null,
      projectId,
      itemSku,
      Date.now(),
      existing.id,
    );

    // When event_type is forced to production_closure without an explicit blocks_dispatch,
    // keep existing blocks_dispatch (COALESCE above). Operator can set it via the form.
    res.json(db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(existing.id));
  });

  router.delete('/events/:id', (req, res) => {
    const result = db.prepare('DELETE FROM calendar_events WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true });
  });

  return router;
};
