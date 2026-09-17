/**
 * Customers + sales documents: Presupuesto (quote) -> Albaran (delivery note) ->
 * Factura (invoice). Simple-docs scope: sequential numbering per doc type, IVA-style
 * per-line tax_rate, no VeriFactu/SII wiring. See docs/erp/README.md "Sales documents".
 *
 * Shopfloor sync: a confirmed erp_posting (server/erp/postings.js) can be turned into
 * a delivery-note line via attachPostingToDelivery(), carrying job_id/posting_id for
 * traceability. This never touches parts.completed_qty; it only records what already
 * happened on the printer as a line the operator can bill.
 */
const { num, round4 } = require('./costing');

const DOC_PREFIX = { quote: 'PRE', delivery: 'ALB', invoice: 'FAC' };
const DOC_TYPES = new Set(['quote', 'delivery', 'invoice']);
// Allowed one-step conversions in the convertible chain: quote -> delivery -> invoice.
const NEXT_DOC_TYPE = { quote: 'delivery', delivery: 'invoice' };

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}
function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function nextDocNumber(db, docType) {
  const prefix = DOC_PREFIX[docType];
  let seq;
  db.transaction(() => {
    const row = db.prepare('SELECT next_seq FROM doc_counter WHERE doc_type = ?').get(docType);
    seq = row ? row.next_seq : 1;
    db.prepare(
      'INSERT INTO doc_counter (doc_type, next_seq) VALUES (?, ?) ON CONFLICT(doc_type) DO UPDATE SET next_seq = ?'
    ).run(docType, seq + 1, seq + 1);
  })();
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

// ---------- Customers ----------

function customerOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tax_id: row.tax_id,
    email: row.email,
    phone: row.phone,
    address: row.address,
    city: row.city,
    postal_code: row.postal_code,
    country: row.country,
    notes: row.notes,
    is_active: !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listCustomers(db, opts = {}) {
  const search = (opts.search || '').trim().toLowerCase();
  let rows = db.prepare('SELECT * FROM customer ORDER BY name COLLATE NOCASE').all();
  if (search) {
    rows = rows.filter(r =>
      (r.name || '').toLowerCase().includes(search) || (r.tax_id || '').toLowerCase().includes(search)
    );
  }
  return rows.map(customerOut);
}

function getCustomer(db, id) {
  const row = db.prepare('SELECT * FROM customer WHERE id = ?').get(id);
  if (!row) throw notFound('Customer not found');
  return customerOut(row);
}

function createCustomer(db, body = {}) {
  const name = String(body.name || '').trim();
  if (!name) throw badRequest('name is required');
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO customer (name, tax_id, email, phone, address, city, postal_code, country, notes, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    name,
    body.tax_id || null,
    body.email || null,
    body.phone || null,
    body.address || null,
    body.city || null,
    body.postal_code || null,
    body.country || null,
    body.notes || null,
    now
  );
  return getCustomer(db, r.lastInsertRowid);
}

function updateCustomer(db, id, body = {}) {
  const existing = db.prepare('SELECT * FROM customer WHERE id = ?').get(id);
  if (!existing) throw notFound('Customer not found');
  db.prepare(`
    UPDATE customer SET
      name = COALESCE(?, name),
      tax_id = COALESCE(?, tax_id),
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      address = COALESCE(?, address),
      city = COALESCE(?, city),
      postal_code = COALESCE(?, postal_code),
      country = COALESCE(?, country),
      notes = COALESCE(?, notes),
      is_active = COALESCE(?, is_active),
      updated_at = ?
    WHERE id = ?
  `).run(
    body.name != null ? String(body.name).trim() : null,
    body.tax_id, body.email, body.phone, body.address, body.city, body.postal_code, body.country, body.notes,
    body.is_active != null ? (body.is_active ? 1 : 0) : null,
    Date.now(),
    id
  );
  return getCustomer(db, id);
}

// ---------- Sales documents ----------

function lineOut(row) {
  return {
    id: row.id,
    doc_id: row.doc_id,
    item_id: row.item_id,
    sku: row.sku,
    description: row.description,
    qty: num(row.qty),
    unit_price: num(row.unit_price),
    tax_rate: num(row.tax_rate),
    line_total: num(row.line_total),
    job_id: row.job_id,
    posting_id: row.posting_id,
  };
}

function docOut(row, lines) {
  return {
    id: row.id,
    doc_type: row.doc_type,
    doc_number: row.doc_number,
    customer_id: row.customer_id,
    status: row.status,
    issue_date: row.issue_date,
    due_date: row.due_date,
    notes: row.notes,
    subtotal: num(row.subtotal),
    tax_total: num(row.tax_total),
    total: num(row.total),
    source_doc_id: row.source_doc_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lines: lines ? lines.map(lineOut) : undefined,
  };
}

function validateLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw badRequest('At least one line is required');
  }
  return rawLines.map((l) => {
    const description = String(l.description || '').trim();
    if (!description) throw badRequest('Each line needs a description');
    const qty = num(l.qty);
    if (!(qty > 0)) throw badRequest('Each line qty must be > 0');
    const unit_price = num(l.unit_price);
    if (unit_price < 0) throw badRequest('unit_price cannot be negative');
    const tax_rate = l.tax_rate != null ? num(l.tax_rate) : 21;
    return {
      item_id: l.item_id != null ? Number(l.item_id) : null,
      sku: l.sku || null,
      description,
      qty,
      unit_price,
      tax_rate,
      line_total: round4(qty * unit_price),
      job_id: l.job_id != null ? Number(l.job_id) : null,
      posting_id: l.posting_id != null ? Number(l.posting_id) : null,
    };
  });
}

function totalsFor(lines) {
  const subtotal = round4(lines.reduce((s, l) => s + l.qty * l.unit_price, 0));
  const tax_total = round4(lines.reduce((s, l) => s + (l.qty * l.unit_price * l.tax_rate) / 100, 0));
  return { subtotal, tax_total, total: round4(subtotal + tax_total) };
}

function getSalesDoc(db, id, opts = {}) {
  const row = db.prepare('SELECT * FROM sales_doc WHERE id = ?').get(id);
  if (!row) throw notFound('Document not found');
  if (opts.withLines === false) return docOut(row);
  const lines = db.prepare('SELECT * FROM sales_doc_line WHERE doc_id = ? ORDER BY id').all(id);
  return docOut(row, lines);
}

function listSalesDocs(db, opts = {}) {
  const clauses = [];
  const params = [];
  if (opts.doc_type) {
    if (!DOC_TYPES.has(opts.doc_type)) throw badRequest(`doc_type must be one of ${[...DOC_TYPES].join(', ')}`);
    clauses.push('doc_type = ?');
    params.push(opts.doc_type);
  }
  if (opts.customer_id) {
    clauses.push('customer_id = ?');
    params.push(Number(opts.customer_id));
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM sales_doc ${where} ORDER BY id DESC LIMIT 500`).all(...params);
  const customers = Object.fromEntries(db.prepare('SELECT id, name FROM customer').all().map(c => [c.id, c.name]));
  return rows.map(r => ({ ...docOut(r), customer_name: customers[r.customer_id] || null }));
}

function createSalesDoc(db, body = {}) {
  const doc_type = String(body.doc_type || '').trim();
  if (!DOC_TYPES.has(doc_type)) throw badRequest(`doc_type must be one of ${[...DOC_TYPES].join(', ')}`);
  if (!body.customer_id) throw badRequest('customer_id is required');
  const customer = db.prepare('SELECT id FROM customer WHERE id = ?').get(Number(body.customer_id));
  if (!customer) throw notFound('Customer not found');
  const lines = validateLines(body.lines);
  const totals = totalsFor(lines);
  const now = Date.now();
  const issue_date = body.issue_date || new Date().toISOString().slice(0, 10);

  let id;
  db.transaction(() => {
    const doc_number = nextDocNumber(db, doc_type);
    const r = db.prepare(`
      INSERT INTO sales_doc
        (doc_type, doc_number, customer_id, status, issue_date, due_date, notes, subtotal, tax_total, total, source_doc_id, created_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc_type, doc_number, Number(body.customer_id), issue_date, body.due_date || null, body.notes || null,
      totals.subtotal, totals.tax_total, totals.total, body.source_doc_id || null, now
    );
    id = r.lastInsertRowid;
    const insLine = db.prepare(`
      INSERT INTO sales_doc_line (doc_id, item_id, sku, description, qty, unit_price, tax_rate, line_total, job_id, posting_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of lines) {
      insLine.run(id, l.item_id, l.sku, l.description, l.qty, l.unit_price, l.tax_rate, l.line_total, l.job_id, l.posting_id, now);
    }
  })();
  return getSalesDoc(db, id);
}

function requireDraft(row) {
  if (row.status !== 'draft') throw conflict(`Document is ${row.status}, only draft documents can be edited`);
}

function updateSalesDoc(db, id, body = {}) {
  const row = db.prepare('SELECT * FROM sales_doc WHERE id = ?').get(id);
  if (!row) throw notFound('Document not found');
  requireDraft(row);

  if (body.customer_id != null) {
    const customer = db.prepare('SELECT id FROM customer WHERE id = ?').get(Number(body.customer_id));
    if (!customer) throw notFound('Customer not found');
  }

  const lines = body.lines !== undefined ? validateLines(body.lines) : null;
  const totals = lines ? totalsFor(lines) : null;
  const now = Date.now();

  db.transaction(() => {
    db.prepare(`
      UPDATE sales_doc SET
        customer_id = COALESCE(?, customer_id),
        issue_date = COALESCE(?, issue_date),
        due_date = ?,
        notes = COALESCE(?, notes),
        subtotal = COALESCE(?, subtotal),
        tax_total = COALESCE(?, tax_total),
        total = COALESCE(?, total),
        updated_at = ?
      WHERE id = ?
    `).run(
      body.customer_id != null ? Number(body.customer_id) : null,
      body.issue_date || null,
      body.due_date !== undefined ? body.due_date : row.due_date,
      body.notes,
      totals ? totals.subtotal : null,
      totals ? totals.tax_total : null,
      totals ? totals.total : null,
      now,
      id
    );
    if (lines) {
      db.prepare('DELETE FROM sales_doc_line WHERE doc_id = ?').run(id);
      const insLine = db.prepare(`
        INSERT INTO sales_doc_line (doc_id, item_id, sku, description, qty, unit_price, tax_rate, line_total, job_id, posting_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of lines) {
        insLine.run(id, l.item_id, l.sku, l.description, l.qty, l.unit_price, l.tax_rate, l.line_total, l.job_id, l.posting_id, now);
      }
    }
  })();
  return getSalesDoc(db, id);
}

function confirmSalesDoc(db, id) {
  const row = db.prepare('SELECT * FROM sales_doc WHERE id = ?').get(id);
  if (!row) throw notFound('Document not found');
  requireDraft(row);
  db.prepare("UPDATE sales_doc SET status = 'confirmed', updated_at = ? WHERE id = ?").run(Date.now(), id);
  return getSalesDoc(db, id);
}

function cancelSalesDoc(db, id) {
  const row = db.prepare('SELECT * FROM sales_doc WHERE id = ?').get(id);
  if (!row) throw notFound('Document not found');
  if (row.status === 'cancelled') throw conflict('Document is already cancelled');
  db.prepare("UPDATE sales_doc SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), id);
  return getSalesDoc(db, id);
}

// Copies a confirmed document's lines into a new draft document one step further down
// the chain (quote -> delivery -> invoice). source_doc_id keeps the paper trail; a
// document can be converted more than once (partial delivery/partial invoicing).
function convertSalesDoc(db, id, toType) {
  const row = db.prepare('SELECT * FROM sales_doc WHERE id = ?').get(id);
  if (!row) throw notFound('Document not found');
  if (row.status !== 'confirmed') throw conflict('Only confirmed documents can be converted');
  const expected = NEXT_DOC_TYPE[row.doc_type];
  if (!expected || expected !== toType) {
    throw badRequest(`${row.doc_type} can only be converted to ${expected || 'nothing'}`);
  }
  const lines = db.prepare('SELECT * FROM sales_doc_line WHERE doc_id = ? ORDER BY id').all(id);
  const created = createSalesDoc(db, {
    doc_type: toType,
    customer_id: row.customer_id,
    notes: row.notes,
    source_doc_id: row.id,
    lines: lines.map(l => ({
      item_id: l.item_id, sku: l.sku, description: l.description, qty: l.qty,
      unit_price: l.unit_price, tax_rate: l.tax_rate, job_id: l.job_id, posting_id: l.posting_id,
    })),
  });
  return created;
}

// ---------- Shopfloor sync: confirmed posting -> delivery note line ----------

function attachPostingToDelivery(db, postingId, opts = {}) {
  const posting = db.prepare('SELECT * FROM erp_posting WHERE id = ?').get(postingId);
  if (!posting) throw notFound('Posting not found');
  if (posting.status !== 'posted') throw conflict('Only a confirmed (posted) posting can be attached to a delivery note');

  const item = posting.erp_sku ? db.prepare('SELECT * FROM item WHERE sku = ?').get(posting.erp_sku) : null;
  const description = item ? `${item.sku} - ${item.name}` : (posting.erp_sku || `Job #${posting.job_id}`);
  const line = {
    item_id: item ? item.id : null,
    sku: posting.erp_sku || null,
    description,
    qty: num(posting.qty) || 1,
    unit_price: num(opts.unit_price) || 0,
    tax_rate: opts.tax_rate != null ? num(opts.tax_rate) : 21,
    job_id: posting.job_id,
    posting_id: posting.id,
  };

  if (opts.doc_id) {
    const doc = db.prepare('SELECT * FROM sales_doc WHERE id = ?').get(opts.doc_id);
    if (!doc) throw notFound('Delivery note not found');
    if (doc.doc_type !== 'delivery') throw badRequest('Target document must be a delivery note (albaran)');
    requireDraft(doc);
    const existingLines = db.prepare('SELECT * FROM sales_doc_line WHERE doc_id = ? ORDER BY id').all(doc.id);
    return updateSalesDoc(db, doc.id, {
      lines: [...existingLines.map(l => ({
        item_id: l.item_id, sku: l.sku, description: l.description, qty: l.qty,
        unit_price: l.unit_price, tax_rate: l.tax_rate, job_id: l.job_id, posting_id: l.posting_id,
      })), line],
    });
  }

  if (!opts.customer_id) throw badRequest('customer_id is required to create a new delivery note');
  return createSalesDoc(db, {
    doc_type: 'delivery',
    customer_id: opts.customer_id,
    issue_date: opts.issue_date,
    notes: `Auto-generated from shopfloor posting #${posting.id} (job #${posting.job_id ?? '-'})`,
    lines: [line],
  });
}

module.exports = {
  DOC_TYPES,
  NEXT_DOC_TYPE,
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  listSalesDocs,
  getSalesDoc,
  createSalesDoc,
  updateSalesDoc,
  confirmSalesDoc,
  cancelSalesDoc,
  convertSalesDoc,
  attachPostingToDelivery,
};
