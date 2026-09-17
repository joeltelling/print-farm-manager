Backup plan (every 15 days)
================================

Goal
----
Keep regular database backups; naming convention prefers sqlite-style filenames, but since the app uses PostgreSQL we store compressed Postgres dumps instead (restorable with `pg_restore`).

What to run
-----------
1) Ensure `DATABASE_URL` is exported (postgres connection string).
2) Run: `./scripts/backup_db.sh` (defaults to `data/backups/YYYYMMDD-acres-erp.dump`).
3) Optional custom dir: `./scripts/backup_db.sh /path/to/backups`.

Restore (example)
-----------------
1) Create an empty database (e.g., `createdb acres_restore`).
2) Run: `pg_restore --clean --if-exists --no-owner --dbname=acres_restore data/backups/YYYYMMDD-acres-erp.dump`.

Automation suggestion (15-day cadence)
--------------------------------------
- Cron example (runs at 02:00 UTC every 15 days):
  `0 2 */15 * * cd /home/fmunoz/acres-erp && ./scripts/backup_db.sh >> /home/fmunoz/acres-erp/data/backups/backup.log 2>&1`
- Adjust path and user as needed; ensure `DATABASE_URL` is available to cron (via environment or sourced file).

Notes
-----
- Producing a true SQLite copy from Postgres is non-trivial; prefer the provided Postgres dump for fidelity.
- Dumps are in `pg_dump --format=custom`, which is compressed and restorable with `pg_restore`.