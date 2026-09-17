/**
 * eBay Sell API tables in the same SQLite file as shopfloor + ERP.
 * CREATE IF NOT EXISTS only. ebay_credential is intentionally NOT backed up.
 */
function ensureEbaySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ebay_credential (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      environment TEXT NOT NULL DEFAULT 'sandbox',
      client_id TEXT,
      client_secret TEXT,
      refresh_token TEXT,
      marketplace_id TEXT NOT NULL DEFAULT 'EBAY_US',
      scopes TEXT,
      auto_post INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS ebay_listing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES item(id),
      ebay_sku TEXT UNIQUE NOT NULL,
      offer_id TEXT,
      listing_id TEXT,
      last_pushed_qty REAL,
      last_pushed_price REAL,
      last_push_at INTEGER,
      last_error TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS ebay_order (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      legacy_order_id TEXT,
      creation_date TEXT,
      last_modified_date TEXT,
      order_payment_status TEXT,
      order_fulfillment_status TEXT,
      buyer_username TEXT,
      total_amount REAL,
      currency TEXT,
      marketplace_id TEXT,
      raw_json TEXT,
      imported_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ebay_order_line (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_item_id TEXT UNIQUE NOT NULL,
      ebay_order_id TEXT NOT NULL,
      ebay_sku TEXT,
      title TEXT,
      qty REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      total_price REAL NOT NULL DEFAULT 0,
      item_id INTEGER REFERENCES item(id),
      status TEXT NOT NULL DEFAULT 'pending',
      sales_order_id INTEGER,
      stock_move_id INTEGER,
      posted_at INTEGER,
      note TEXT,
      shortage_json TEXT,
      FOREIGN KEY (ebay_order_id) REFERENCES ebay_order(order_id)
    );

    CREATE TABLE IF NOT EXISTS ebay_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Seed single credential row so UPDATEs always have a target
  const row = db.prepare('SELECT id FROM ebay_credential WHERE id = 1').get();
  if (!row) {
    db.prepare(
      `INSERT INTO ebay_credential (id, environment, marketplace_id, auto_post, updated_at)
       VALUES (1, 'sandbox', 'EBAY_US', 1, ?)`
    ).run(Date.now());
  }
}

module.exports = { ensureEbaySchema };
