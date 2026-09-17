DO $$ BEGIN CREATE TYPE item_dimension AS ENUM ('COUNT','AREA','LENGTH','WEIGHT','VOLUME'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE item_type AS ENUM ('RAW_MAT','COMP','FIN_GOOD'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE move_type AS ENUM ('RECEIVE','ADJUST','ISSUE','TRANSFER','SHIP','PRODUCE','CONSUME'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS uom (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  dimension item_dimension NOT NULL,
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  factor_to_base NUMERIC(24,8) NOT NULL,
  precision_scale SMALLINT NOT NULL DEFAULT 4
);
CREATE UNIQUE INDEX IF NOT EXISTS uom_one_base_per_dimension ON uom(dimension) WHERE is_base = TRUE;

CREATE TABLE IF NOT EXISTS warehouse ( id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL );

CREATE TABLE IF NOT EXISTS location (
  id SERIAL PRIMARY KEY,
  warehouse_id INT NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  CONSTRAINT location_code_format CHECK (code = UPPER(code) AND code ~ '^[0-9]{2}[A-Z][0-9]{2}$'),
  UNIQUE (warehouse_id, code)
);

CREATE TABLE IF NOT EXISTS item (
  id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  dimension item_dimension NOT NULL DEFAULT 'COUNT',
  base_uom_code TEXT NOT NULL REFERENCES uom(code),
  display_uom_code TEXT REFERENCES uom(code),
  purchase_uom_code TEXT REFERENCES uom(code),
  standard_cost NUMERIC(12,4),
  item_type item_type,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS vendor ( id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE );

CREATE TABLE IF NOT EXISTS po (
  id SERIAL PRIMARY KEY,
  po_number TEXT UNIQUE NOT NULL,
  vendor_id INT NOT NULL REFERENCES vendor(id),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS po_line (
  id SERIAL PRIMARY KEY,
  po_id INT NOT NULL REFERENCES po(id) ON DELETE CASCADE,
  item_id INT NOT NULL REFERENCES item(id),
  qty_value NUMERIC(24,8) NOT NULL,
  uom_code TEXT NOT NULL REFERENCES uom(code),
  unit_price_input NUMERIC(12,6) NOT NULL,
  unit_cost_base NUMERIC(12,8) NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS po_line_po_idx ON po_line(po_id);

CREATE TABLE IF NOT EXISTS stock_move (
  id SERIAL PRIMARY KEY,
  move_type move_type NOT NULL,
  item_id INT NOT NULL REFERENCES item(id),
  warehouse_from_id INT REFERENCES warehouse(id),
  warehouse_to_id   INT REFERENCES warehouse(id),
  location_from_id  INT REFERENCES location(id),
  location_to_id    INT REFERENCES location(id),
  qty_base NUMERIC(24,8) NOT NULL,
  unit_cost_base NUMERIC(12,8),
  note TEXT,
  idem_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_move_item_idx ON stock_move(item_id);

CREATE TABLE IF NOT EXISTS warehouse_item_cost (
  warehouse_id INT NOT NULL REFERENCES warehouse(id) ON DELETE CASCADE,
  item_id INT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  wac NUMERIC(12,8) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, item_id)
);

CREATE TABLE IF NOT EXISTS doc_counter (
  series TEXT NOT NULL,
  yy SMALLINT NOT NULL,
  next_seq INT NOT NULL DEFAULT 1,
  PRIMARY KEY (series, yy)
);

CREATE OR REPLACE VIEW v_stock_by_location AS
SELECT i.id AS item_id, i.sku, COALESCE(sm.warehouse_id,0) AS warehouse_id, COALESCE(sm.location_id,0) AS location_id,
       SUM(sm.in_qty) - SUM(sm.out_qty) AS qty_base
FROM (
  SELECT item_id, warehouse_to_id AS warehouse_id, location_to_id AS location_id, qty_base AS in_qty, 0::NUMERIC AS out_qty
  FROM stock_move WHERE location_to_id IS NOT NULL
  UNION ALL
  SELECT item_id, warehouse_from_id, location_from_id, 0::NUMERIC, qty_base
  FROM stock_move WHERE location_from_id IS NOT NULL
) sm
JOIN item i ON i.id = sm.item_id
GROUP BY i.id, i.sku, COALESCE(sm.warehouse_id,0), COALESCE(sm.location_id,0);

CREATE OR REPLACE VIEW v_stock_by_warehouse AS
SELECT item_id, sku, warehouse_id, SUM(qty_base) AS qty_base
FROM v_stock_by_location
GROUP BY item_id, sku, warehouse_id;

-- Semillas
INSERT INTO uom(code,name,dimension,is_base,factor_to_base,precision_scale) VALUES
('EA','Each','COUNT',TRUE,1,0),
('SET','Set (10 EA)','COUNT',FALSE,10,0),
('SQIN','Square Inch','AREA',TRUE,1,2),
('SQFT','Square Foot','AREA',FALSE,144,4)
ON CONFLICT (code) DO NOTHING;

INSERT INTO warehouse(code,name) VALUES
('raw_mat','Raw Materials'),
('comps','Components'),
('fin_goods','Finished Goods')
ON CONFLICT (code) DO NOTHING;

INSERT INTO location(warehouse_id,code)
SELECT w.id, x.code FROM warehouse w
JOIN (VALUES ('01A01'),('01A02'),('02A01'),('02B01')) AS x(code) ON TRUE
WHERE NOT EXISTS (SELECT 1 FROM location l WHERE l.warehouse_id=w.id AND l.code=x.code);

INSERT INTO vendor(name) VALUES ('Default Vendor') ON CONFLICT (name) DO NOTHING;
