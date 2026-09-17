/**
 * Shared masters live in the same SQLite DB as shopfloor (ERP tables: machine, item).
 * CoMa React reads these; ERP Express routes own writes for full CRUD.
 * product <-> project, component <-> part, machine <-> printer.
 */
module.exports = (db) => {
  const router = require('express').Router();

  function tableExists(name) {
    const row = db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name);
    return !!row;
  }

  function columnExists(table, column) {
    if (!tableExists(table)) return false;
    return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
  }

  // GET /api/shared/machines: ERP machine rates + shopfloor printers (linked)
  router.get('/machines', (_req, res) => {
    let rates = [];
    if (tableExists('machine')) {
      if (tableExists('printers')) {
        rates = db.prepare(`
          SELECT m.id, m.machine AS name, m.hourly_rate, m.is_active, m.printer_id, m.needs_erp_data,
                 p.name AS printer_name, p.model AS printer_model, p.status AS printer_status,
                 'rate' AS kind
          FROM machine m
          LEFT JOIN printers p ON p.id = m.printer_id
          ORDER BY m.machine COLLATE NOCASE
        `).all();
      } else {
        rates = db.prepare(
          `SELECT id, machine AS name, hourly_rate, is_active, printer_id, needs_erp_data, 'rate' AS kind
           FROM machine ORDER BY machine COLLATE NOCASE`
        ).all();
      }
    }

    const printers = tableExists('printers')
      ? db.prepare(
          `SELECT id, name, model, status, is_active, 'printer' AS kind
           FROM printers ORDER BY name COLLATE NOCASE`
        ).all()
      : [];

    const linked = rates.filter(r => r.printer_id != null).length;

    res.json({
      machines: rates,
      printers,
      linked_printer_machines: linked,
      source: 'shared-sqlite',
    });
  });

  // GET /api/shared/materials: ERP items + filament library + project/part links
  router.get('/materials', (_req, res) => {
    const items = tableExists('item')
      ? db.prepare(
          `SELECT id, sku, name, dimension, display_uom_code, purchase_uom_code,
                  is_active, item_role, sourcing, project_id, part_id, needs_erp_data, 'item' AS kind
           FROM item ORDER BY sku COLLATE NOCASE`
        ).all()
      : [];

    const filamentTypes = tableExists('filament_types')
      ? db.prepare('SELECT id, name FROM filament_types ORDER BY name COLLATE NOCASE').all()
      : [];

    let filamentColors = [];
    if (tableExists('filament_colors')) {
      const hexColumn = columnExists('filament_colors', 'hex_color')
        ? 'hex_color'
        : (columnExists('filament_colors', 'hex') ? 'hex' : 'NULL');
      filamentColors = db.prepare(
        `SELECT id, name, ${hexColumn} AS hex, ${hexColumn} AS hex_color, type_id
         FROM filament_colors ORDER BY name COLLATE NOCASE`
      ).all();
    }

    res.json({
      items,
      products: items.filter(i => i.item_role === 'product'),
      components: items.filter(i => i.item_role === 'component'),
      raw: items.filter(i => i.item_role === 'raw'),
      filament_types: filamentTypes,
      filament_colors: filamentColors,
      aliases: { product: 'project', component: 'part' },
      sourcing: ['manufactured', 'outsource'],
      source: 'shared-sqlite',
    });
  });

  return router;
};
