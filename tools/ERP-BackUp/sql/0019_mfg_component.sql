BEGIN;

CREATE TABLE IF NOT EXISTS mfg_component (
  id                BIGSERIAL PRIMARY KEY,
  sku               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  machine           TEXT,
  std_minutes       NUMERIC(10,3) NOT NULL DEFAULT 0,
  raw_item_id       BIGINT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  raw_qty_per_unit  NUMERIC(18,6) NOT NULL,
  scrap_pct         NUMERIC(9,3)  NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfg_component_raw ON mfg_component(raw_item_id);
CREATE INDEX IF NOT EXISTS idx_mfg_component_active ON mfg_component(is_active);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'mfg_component_set_updated_at'
  ) THEN
    CREATE OR REPLACE FUNCTION mfg_component_set_updated_at()
    RETURNS TRIGGER AS $F$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END
    $F$ LANGUAGE plpgsql;
  END IF;
END$$;

DROP TRIGGER IF EXISTS trg_mfg_component_updated_at ON mfg_component;
CREATE TRIGGER trg_mfg_component_updated_at
BEFORE UPDATE ON mfg_component
FOR EACH ROW EXECUTE FUNCTION mfg_component_set_updated_at();

COMMIT;
