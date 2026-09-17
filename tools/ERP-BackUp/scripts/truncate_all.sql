-- Truncate all user tables in schema public, restart identities, cascade FKs.
-- Excludes alembic_version if present.
DO $$
DECLARE
  stmt text;
BEGIN
  SELECT 'TRUNCATE TABLE ' || string_agg(format('%I.%I', schemaname, tablename), ', ') || ' RESTART IDENTITY CASCADE'
    INTO stmt
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename <> 'alembic_version';

  IF stmt IS NOT NULL THEN
    EXECUTE stmt;
  END IF;
END$$;
