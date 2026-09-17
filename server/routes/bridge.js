/**
 * Bridge: shopfloor → ERP posting queue.
 * Creates a pending erp_posting; inventory moves only after operator confirm in ERP.
 * Does not change parts.completed_qty.
 */
const { recordShopfloorPosting } = require('../erp/postings');

module.exports = (db) => {
  const router = require('express').Router();

  router.post('/units-completed', (req, res) => {
    const body = req.body || {};
    const qty = Number(body.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ error: 'qty must be a non-negative number' });
    }

    let part = null;
    if (body.sku) {
      try {
        part = db.prepare(
          'SELECT id, name, project_id, erp_sku FROM parts WHERE erp_sku = ? LIMIT 1'
        ).get(body.sku);
      } catch (_) { /* erp_sku column missing on very old DBs */ }
    }

    try {
      const jobRef = body.shopfloor_job_ref;
      const job_id = jobRef != null && Number.isFinite(Number(jobRef)) ? Number(jobRef) : null;
      const { posting, created } = recordShopfloorPosting(db, {
        job_id,
        part_id: part?.id || body.part_id || null,
        printer_id: body.printer_id || null,
        sku: body.sku || null,
        erp_item_id: body.erp_item_id || null,
        qty,
        note: body.op_id ? `bridge op=${body.op_id}` : 'bridge units-completed',
      });

      console.log('[bridge] units_completed:', JSON.stringify({
        posting_id: posting.id, created, sku: posting.erp_sku, qty: posting.qty,
      }));

      res.status(created ? 201 : 200).json({
        ok: true,
        posting,
        created,
        linked_part: part,
        note: 'Pending ERP posting created; confirm in /erp/postings to move stock',
      });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  return router;
};
