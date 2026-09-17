# Calendar

Planned events for the shopfloor and a hard gate on new job dispatch during production closures.

## Why it exists

ERP and shopfloor tables mostly record what already happened (`sales_order.sale_date`, `stock_move.trans_date`, `jobs.started_at`). There is no purchase-order / ETA model yet, and project/part rows have no deadline columns. Operators still need to plan: stock arriving next week, a shipment date, a hard deadline, or a multi-day plant shutdown where the scheduler must not start new prints.

The calendar owns those **planned** rows in `calendar_events`. A read-only overview layer overlays recent jobs, sales, stock receipts, and work orders for the same date range so the month view is not only forward-looking.

## Event types

| `event_type` | Typical use | Blocks dispatch by default? |
|---|---|---|
| `stock_arrival` | Expected material or finished-goods receipt | No |
| `shipment` | Planned outbound ship date | No |
| `deadline` | Soft or hard due date for a project / SKU | No |
| `production_closure` | Holiday, maintenance, plant closed N days | **Yes** (`blocks_dispatch` defaults to 1) |
| `note` | Free-form reminder | No |

Statuses: `planned`, `done`, `cancelled`. Only `planned` events with `blocks_dispatch = 1` affect the scheduler.

## Production closure gate

`server/calendar-gate.js` exports `activeDispatchBlock(db, now)`. It returns the first planned event whose window contains `now` and whose `blocks_dispatch` is 1.

Call sites (must stay in sync):

1. `_reserveJob` in `server/scheduler.js` (before any job `INSERT`). Every dispatch path converges here.
2. `sweepIdlePrinters` early return (avoids noisy logs every 15 s).
3. `GET /api/parts/:id/dispatch-status` blocker text (operator diagnostic sync pair).

Limits (documented honestly):

- Blocks **new reservations** only. Uploads already in flight and prints already running continue.
- Does not touch `parts.completed_qty` or `printers.is_held`.
- Closures that set `blocks_dispatch` require an `end_at` (API returns 400 otherwise) so the farm cannot be locked open-ended by mistake.
- One in-memory notification per closure id per scheduler process lifetime (not every sweep).

## API surface

Mounted at `/api/calendar` (requires login like every other `/api/*` route). See [api.md](api.md#calendar).

## UI

`client/src/pages/Calendar.jsx` under Shopfloor nav (`/calendar`): Monday-based month grid, day detail panel, create/edit/delete with `useToast` / `useConfirm`. Passive banner on Calendar and Dashboard when a closure is active.

## Backup

`calendar_events` is included in `GET /api/backup` export and restore (unlike `auth_*` / `ebay_credential`). Older backups without the key leave existing calendar rows alone.

## Out of scope (for now)

- External calendar sync (Google, iCal feed)
- Purchase-order / vendor master data
- Writing `work_order.due_date` (column exists in ERP schema but is unused by routes)
