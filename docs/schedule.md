# Schedule (Forward Projection)

The Jobs page is a record of what happened. The Schedule page is the opposite view: what the
farm is expected to do next, drawn as one column per printer against a time axis, so an
operator can see when a printer frees up, when a project finishes, and where the gaps are.

**It is a projection, not a queue.** Nothing on this page is a commitment. No job rows are
created, no dispatch happens, and `parts.completed_qty` is never touched. A projected block
is a prediction that the scheduler will make the same choice when the moment arrives, made by
replaying the scheduler's own rules forward against a simulated clock.

| File | Role |
|---|---|
| `server/projection.js` | The projection engine. Read-only. |
| `server/candidate-query.js` | The dispatch eligibility predicate, shared with the scheduler. |
| `server/schedule-state.js` | Fingerprint of the projection's inputs, for client freshness. |
| `server/routes/schedule.js` | `GET /api/schedule`, `GET /api/schedule/version`. |
| `client/src/pages/Schedule.jsx` | The page. |
| `client/src/scheduleDirty.js` | Cross-page "your schedule is stale" signal. |

## How a printer's availability is decided

Busy or free comes from the **jobs table**, not from `printers.status`.

A job row is written synchronously the moment the scheduler reserves a dispatch, while
`printers.status` is only refreshed by the 15 s poll. For several seconds after a dispatch, a
printer that already has a plate running still reads `FINISHED` or `IDLE` in the printers
table. A projection that trusted that status would call the printer free and stack a phantom
second job onto it.

The order of preference for the end of an in-progress block:

1. **Live countdown.** If the printer reports `PRINTING` with a `job_time_remaining`, use it. The printer knows better than the slicer did.
2. **Print is over, waiting on a person.** If the job row still says `printing` but the printer reports `FINISHED`, `IDLE`, or `STOPPED`, and the job is older than the 90 s fresh-dispatch window, the plate is off the nozzle: the block ends now. This is the "awaiting sign-off" state the Jobs page renders. `OFFLINE` and `ERROR` are excluded on purpose, because a printer can be unreachable while its print carries on (the transient Bambu MQTT case).
3. **Estimate.** `started_at` plus the effective estimate. A print already past its estimate ends now rather than in the past.

For a printer with no active job: held means a person is still needed (a changeover from now,
with `blocked_reason` set); unheld and `IDLE`/`FINISHED`/`STOPPED` means free now, matching
`sweepIdlePrinters`; anything else (`OFFLINE`, `ERROR`, `PAUSED`, `UNKNOWN`, `READY`) is not
projected at all, and the page hatches that column rather than leaving it suggestively empty.

## The operator model

The farm is staffed, not lights-out, and every print finishes held for sign-off. Two rules
model the human step, both reported to the client in `assumptions` so the page states them
instead of presenting the projection as fact:

- **Changeover: 15 minutes.** Between two prints on one printer, someone has to swap the plate and confirm the result.
- **Staffed hours: 06:00 to 22:00, server local time.** A print finishing inside that window is signed off when it finishes. One finishing after 22:00 waits until 06:00 the next morning, then takes its changeover. Printing overnight is fine; only the human step is gated.

So a print ending at 21:50 is followed by a start at 22:05, and one ending at 23:10 is
followed by a start at 06:15. Those overnight gaps are shaded on the page so they explain
themselves.

These are farm policy, not physics. They are named constants in `server/projection.js`
(`CHANGEOVER_SECS`, `STAFFED_START_HOUR`, `STAFFED_END_HOUR`), not operator settings; promoting
them to the settings table is a reasonable future change.

## Block length, and what "unknown" means

Three sources, in order:

1. `gcodes.est_print_secs`: per plate and per printer model, normally read straight out of the sliced file at upload time (see `server/slicer-metadata.js`). Reported as `time_source: "gcode"`.
2. `parts.print_time_seconds`: the optional operator estimate from the Add Part form. Reported as `time_source: "part"`.
3. **Two hours**, when neither exists. Reported as `time_source: "default"` with `time_unknown: true`, and drawn with a `?` marker so nobody mistakes the default for a measurement.

The fallback is deliberately visible. A schedule made of silent two-hour guesses looks exactly
like a schedule made of real data.

## Priority, ceilings, and ties

The projection walks printers in order of when they come free and asks
`server/candidate-query.js` what each would print next. That module holds the eligibility
predicate and the priority ordering (project priority, project age, part `sort_order`, part
age) as a single shared SQL fragment: the scheduler and the projection build their queries
from it, so the schedule cannot drift from what dispatch actually does. Each caller keeps its
own SELECT list, so adding a column for one never widens the other's query.

Demand accounting mirrors `_reserveJob`'s ceiling: quantity already committed by in-flight
jobs counts against a part's remaining target, projected blocks add to that running total, and
a printer falls through to the next part down the priority order once a part is fully covered.

**Ties are broken at random.** When several printers come free within 60 s of each other and
more than one can take the highest-priority part, the winner is picked uniformly at random
among them. The generator is seeded from the schedule fingerprint, which makes the choice
stable for a given farm state: the page re-renders identically on every poll instead of
shuffling blocks every 15 s, and any real change reshuffles the tie.

## Freshness: how the page knows it is stale

This is the part that deliberately does not follow the poll-and-hope pattern used elsewhere in
the app. `printers.status` lagging its own poll is what makes a just-dispatched printer show
`FINISHED` on the Fleet page for a few seconds; a derived view like this one would inherit that
lag and compound it, with no way for an operator to tell "current" from "stale".

Instead, `server/schedule-state.js` hashes the projection's inputs, and `GET /api/schedule`
returns that fingerprint alongside the payload.

- The page polls `GET /api/schedule/version` every 5 s. A different fingerprint means its rendered schedule is out of date: it shows an explicit **"Recalculating schedule"** state and refetches.
- Editing an estimate on the Projects page also fires a `scheduleDirty` window event (`client/src/scheduleDirty.js`), so an open Schedule tab goes stale instantly rather than up to one poll later. Same CustomEvent pattern as `farmNameChanged`; this client has no providers.
- The full projection is still refetched every 15 s, because live `job_time_remaining` moves the leading edge of an in-progress block without changing the fingerprint.

The fingerprint is a hash of the inputs rather than a counter that mutation sites increment.
A counter needs a `bump()` at every write that matters and silently goes stale the first time a
new write path forgets one. Hashing cannot forget. The trade is an O(rows) scan per call,
bounded by restricting parts and G-codes to active projects.

`printers.job_progress` and `job_time_remaining` are excluded from the hash on purpose. Every
poll rewrites them for every printing printer, so including them would change the fingerprint
constantly and pin the UI in a permanent recalculating state, which is the same lie as stale
data wearing a spinner.

The projection itself is recomputed per request rather than cached against the fingerprint,
since it is cheap and live progress has to be picked up anyway. The fingerprint's jobs are
client freshness and tie-break stability, not memoisation.

## The page

- One column per active printer, ordered by group then name, with a sticky heading row and a sticky Outlook-style time gutter. A red line marks the current time and ticks every 10 s, measured against the server's clock (the payload carries `now`, and the page keeps the offset) so the line never drifts against the blocks.
- Blocks are coloured per project. In-progress blocks are solid, projected blocks are dashed and translucent, and a block that started before the visible window is clipped with an `↑` marker instead of running up behind the heading.
- Horizon selector (6 h to 3 days, default 24 h) and a row-height zoom. Off-hours are shaded; unavailable printers are hatched with their reason.
- Open demand the projection could not place is listed underneath, either as "beyond this horizon" or as "no eligible printer", the latter pointing at the existing per-part **Why isn't this printing?** diagnostic rather than reimplementing it.
- With 50-plus printers the grid scrolls horizontally inside its own container; the page body never scrolls sideways.

## Limits worth knowing

- The projection assumes prompt sign-off. A farm where plates sit unconfirmed for hours will run behind it. `blocked_reason` shows which printers are waiting on a person right now, but the projection does not model an operator being slow.
- Staffed hours use the server's local time. The production farm machine is single-site, so there is no timezone selector.
- Upload time, filament runouts, failed prints, and retries are not modelled.
- Long horizons on a large farm are capped (`MAX_PROJECTED_BLOCKS`, `MAX_ITERATIONS`); hitting a cap sets `truncated` rather than silently returning a short schedule.
