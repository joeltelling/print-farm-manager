# CLAUDE.md: Print Farm Manager Operating Manual

Print Farm Manager runs a real fleet of 50+ printers (Prusa, Bambu, Elegoo, Klipper, OctoPrint) and has been public open source since v1.0.0 (github.com/joeltelling/print-farm-manager). Two consequences shape every decision:

1. Correctness bugs land on physical hardware. A bad dispatch or a double-credited part count wastes plastic, printer hours, and operator trust.
2. Docs are a product surface. Strangers self-install from README.md and docs/installation.md, and community contributors build drivers from docs/driver-authoring.md.

## Session start

- Read docs/README.md first. It is the doc index and current project map.
- ARCHITECTURE.md is the original spec. All phases (1 through 6D) are complete and shipped. Its "what NOT to build" sections are stale phase briefings, not current constraints. The code and docs/ are the source of truth.
- Deliberately parked features (do not build as a side effect of another task): filament/spool tracking, Bambu camera streaming, printer diagnostics panel, multi-group printers. Joel decides when these resume.

## The five non-negotiables

1. **Part counts are sacred.** Any code path that changes `parts.completed_qty` must be backed by exactly one real-world event and must be impossible to double-fire across server restarts, MQTT reconnects, and poll flaps. See "The phantom part credit" below.
2. **Docs ship with the change.** Every feature or fix updates the relevant docs/ file and adds a dated docs/CHANGELOG.md entry in the same commit.
3. **No em dashes or en dashes in prose.** Use commas, colons, parentheses, or plain hyphens in every doc, comment, commit message, and UI string you write. Verify with `grep -rPn '[\x{2013}\x{2014}]'` on your changed files before finishing. (Legacy docs contain thousands of them; do not fix lines you are not otherwise touching.)
4. **Read official protocol docs before touching driver code.** Never guess field names, URL formats, or payload shapes for PrusaLink, Bambu MQTT (OpenBambuAPI), Moonraker, SDCP, or OctoPrint. If the doc is not findable, stop and say so.
5. **Never claim hardware validation that did not happen.** "Implemented from protocol docs, not yet validated on hardware" is the honest and expected phrasing until Joel runs it on a real printer.

## Architecture in one minute

- `server/index.js`: Express entry. Serves the built client from `client/dist` in production (same origin, port 3000) and hosts the operator-action endpoints (set-ready, recommission, set-ready-batch) inline because they need the scheduler instance.
- `server/db.js`: opens SQLite (WAL), creates tables with `CREATE TABLE IF NOT EXISTS`, then runs additive startup migrations as `try { db.exec('ALTER TABLE ...') } catch (_) {}` lines. This is the entire migration system.
- `server/poller.js`: polls every active printer every 15 s via its driver, writes status to the printers table, emits `statusChange` and `printerIdle`.
- `server/scheduler.js`: listens to poller events, picks the highest-priority open part with a matching G-code (model, group, material, color), inserts a job row as a dispatch lock, uploads, and handles FINISHED/ERROR/OFFLINE/STOPPED transitions. Batched sweeps respect `dispatch_batch_size`.
- `server/drivers/`: one module per brand behind a lazy registry (`drivers/index.js`). Contract lives in docs/driver-authoring.md.
- `server/routes/`: one factory module per resource, `module.exports = (db) => router`.
- `client/`: Vite + React 18 SPA. Three runtime deps total (react, react-dom, react-router-dom). No axios, no CSS framework, no state library. Everything hand-rolled and dark-themed.
- Operator safety model: `printers.is_held = 1` means "waiting for a human". Prints finish held; operators confirm quality via Set Ready, which credits quantity and releases the hold. The system prefers asking the operator over inferring.

## Server conventions

- All DB access uses better-sqlite3's synchronous API. Never `await` a DB call, never wrap one in a Promise.
- Timestamps are Unix epoch milliseconds from `Date.now()`, stored as INTEGER. Never seconds, never ISO strings.
- Booleans are INTEGER 0/1.
- Route modules export `(db) => router` and are mounted in server/index.js. The projects router additionally receives the scheduler.
- Partial updates use `COALESCE(?, column)` so omitted fields keep their value. Updates are PUT, not PATCH.
- Static routes go before parameterized ones (`/reorder` before `/:id`) or Express matches the literal as an id.
- Not-found pattern: look the row up first, `return res.status(404).json({ error: 'X not found' })`. Validation errors are 400 with the missing field names. Conflicts are 409. Creates return 201 with the row re-selected by `lastInsertRowid`.
- Multi-statement writes wrap in `db.transaction(() => { ... })()`.
- Schema changes are additive only: a new `try/catch ALTER TABLE` line in db.js. No migration framework, no destructive migrations, nothing that loses data on an existing install.
- G-code uniqueness on `(part_id, printer_model)` is enforced in the routes, not by a DB constraint.
- Log lines are prefixed with the module: `console.log('[scheduler] ...')`.
- Timing constants are named, in caps, with a comment stating what they must exceed and why (see `STALE_JOB_GRACE_MS` in scheduler.js).
- Node is pinned to `>=22 <24` (native better-sqlite3 build breaks on Node 24 on Windows). The production farm machine is Windows: use `path.join`, split stored paths with `split(/[\\/]/)`, and keep update.bat working.
- `DEMO_MODE=true` skips real polling; `server/seed-demo.js` fills a demo DB. Use these when developing without printers.

## Driver conventions (summary; the contract is docs/driver-authoring.md)

- Four async functions, printer row always first: `getStatus`, `uploadAndPrint`, `cancelJob`, `checkIfPrinting`. Optional `deleteFile`.
- `getStatus` never throws: return `{ status: 'OFFLINE', progress: null, timeRemaining: null }` on any error, ~8 s timeouts.
- Canonical statuses only: IDLE, PRINTING, PAUSED, FINISHED, STOPPED, ERROR, OFFLINE, READY, UNKNOWN. User-cancelled prints are STOPPED, not ERROR. FINISHED is the only status that credits inventory.
- Drivers never touch the DB. Persistent-connection state (Bambu, CC2) lives in a module-level `Map` keyed by `printer.id`.
- Throw with `err.code = 'UPLOAD_CONFLICT'` when the printer reports a transfer already in progress; the scheduler waits 60 s instead of 5 s.
- Moonraker specifically: upload options such as `print=true` are multipart form fields. Query params are silently ignored and the upload still returns 200.

## Client conventions

- Native `fetch` with relative `/api/...` URLs. No axios. Vite proxies `/api` to port 3000 in dev.
- Live pages (Fleet, Dashboard, Jobs, Settings notifications) poll on a 15 s `setInterval` inside `useEffect` with cleanup. Static pages fetch on mount and refetch after mutations.
- Two error channels, never mixed up: background poll fetches swallow errors with `.catch(() => {})`; user-initiated mutations surface failures via toast, reading the body with `const body = await res.json().catch(() => ({}))` then `showToast('X failed: ' + (body.error || res.status), 'error')`.
- `useToast()` and `useConfirm()` return `[fn, element]` tuples, instantiated per page. You must render `{toastEl}` and `{confirmModal}` in the page JSX or nothing appears. Toast variants: 'success' (default), 'error', 'warning'.
- Destructive actions gate on `await confirm({ title, message, confirmLabel, danger: true })`. `window.confirm` and `alert` do not exist in this codebase; keep it that way.
- Refetch after mutating is the default. Optimistic updates are rare and carry an explanatory comment.
- Styling is inline `style={{}}` objects against a hard-coded dark palette (page `#0a0f1a`, cards `#131720`, borders `#1e2433`/`#2d3748`, text `#e2e8f0`/`#94a3b8`/`#64748b`, action blue `#2563eb`). There are no CSS variables: copy hex values from an existing page. Status color maps are `const` objects at the top of each page file with a fallback entry.
- Shared hooks live in `client/src/` next to App.jsx; shared components live in `client/src/components/`.
- Cross-page signals use window CustomEvents (see `farmNameChanged`), not context. There are no providers.
- File uploads use FormData without a Content-Type header; G-code upload alone uses XMLHttpRequest for progress reporting.
- New layouts must work at the 600 px breakpoint (scoped inline `<style>` blocks, see App.jsx and Jobs.jsx).

## Sync pairs: code that must change together

If you touch one side of a pair, grep for and update the other in the same commit. These have each caused a real bug or review finding:

| If you change | You must also check |
|---|---|
| Scheduler candidate/eligibility SQL (scheduler.js) | `GET /api/parts/:id/dispatch-status` in routes/parts.js, which mirrors it for operator diagnostics |
| Any new table or column | server/routes/backup.js export AND restore (column lists derive from the live schema; keep it that way), plus server/tests/backup-restore.test.js seeding and asserting it |
| Driver registry (drivers/index.js) | routes/models.js VALID_CONNECTORS, routes/printers.js NO_API_KEY_TYPES, and every brand touchpoint in client/src/pages/Settings.jsx (find them with `grep -rn "octoprint" client/src`) |
| A route's request/response shape | docs/api.md entry and the route's test file |
| "Awaiting sign-off" derived-status logic (`is_held === 1 && status FINISHED/IDLE`) | It is duplicated across Dashboard.jsx, Fleet.jsx, Printers.jsx; keep all copies identical |
| README.md install steps | docs/installation.md (and vice versa) |

## Named mistakes and the rule that prevents each

- **The async database.** Writing `await db.prepare(...)` or making route handlers async for DB work. Rule: better-sqlite3 is synchronous; `await` on a DB call is always wrong here.
- **The phantom part credit.** Adding a recovery path that credits `completed_qty` from a time-window heuristic ("a job failed recently, the printer says FINISHED now, credit it"). This shipped once with a 24-hour window and double-credited Bambu printers on every restart; it was a critical bug. Rule: recovery credit paths gate on the current process lifetime (`finished_at > scheduler.startedAt`), and when in doubt credit only on explicit operator action against a still-active job.
- **The stale-status replay.** Trusting the first statuses a Bambu printer reports after connect. First poll is OFFLINE (MQTT still connecting), second can be a FINISHED latched from before the server started. Rule: an OFFLINE to FINISHED transition never blindly credits; every FINISHED handler must survive a cold start against a stale printer state.
- **The guessed protocol field.** Fixing a driver by pattern-matching what the payload "should" look like. Four consecutive wrong commits were once made on the Bambu project_file URL. Rule: fetch the official protocol doc (the URL is usually in the driver's header comment) before editing any driver payload.
- **The hold bypass.** "Fixing" a stuck printer by clearing `is_held` or auto-resolving a job in code. Holds exist so a human confirms physical outcomes. Rule: only operator endpoints (set-ready, recommission) and the one documented auto-unhold (held printer recovers to PRINTING with a live job) may clear a hold.
- **The route shadowed by :id.** Adding `router.put('/reorder')` after `router.put('/:id')` and wondering why reorder 404s with "Part not found". Rule: static paths are declared above parameterized ones in every route file.
- **The destructive migration.** Renaming or dropping a column, or adding a migration framework. Rule: schema evolution is additive `try/catch ALTER TABLE` in db.js only; anything else needs Joel's sign-off (existing installs in the wild must survive `git pull`).
- **The silent Moonraker no-op.** Passing upload options as query params. Moonraker returns 200 and ignores them; the print never starts. Rule: Moonraker options are form fields appended to the multipart body.
- **The window.confirm shortcut.** Using `window.confirm`/`alert` for a destructive action. Rule: `useConfirm` with `danger: true`, and render the modal element.
- **The invisible toast.** Calling `showToast` without rendering `{toastEl}` in the JSX. Rule: every page that mutates renders both `{toastEl}` and `{confirmModal}` at the end of its JSX.
- **The poll-error toast storm.** Surfacing background poll failures through the toast channel, spamming an operator every 15 s while a printer reboots. Rule: poll errors are swallowed or shown as a passive banner; only user-initiated actions toast.
- **The diff-only review.** Reviewing a PR by reading only changed lines. A community PR once fixed backup export while the adjacent restore code kept a stale hardcoded column list, silently dropping data. Rule: audit the unchanged code adjacent to a diff, especially the sync pairs table above.
- **The forgotten changelog.** Landing a change with no docs/CHANGELOG.md entry or component-doc update. Rule: docs are part of the definition of done, not a follow-up.
- **The fake hardware pass.** Describing a driver as working because tests pass against mocks. Rule: state hardware-validation status explicitly in the changelog entry and the summary; mocks prove the contract, not the printer.
- **The Windows path break.** Building paths with string concatenation and `/`, or shell commands that assume bash. Rule: `path.join` for construction, `split(/[\\/]/)` for parsing stored filepaths, and remember update.bat and PM2 on the farm machine.
- **The convenient timestamp.** Storing `new Date().toISOString()` or epoch seconds. Rule: `Date.now()` milliseconds, INTEGER column, everywhere.
- **The heavyweight test.** Importing server/index.js or the real db.js in a test. Rule: tests build `new Database(':memory:')`, define the minimal schema inline, mount the route factory on a throwaway Express app, and drive it with supertest. Drivers mock the transport (`jest.mock('axios')`, mocked mqtt), never the driver module itself.

## Quality bar per deliverable

Every bar is a checklist. A deliverable is done when every box is checked, not when it "looks good".

**Baseline for any code change:**
- [ ] `npm test` passes in full (24 suites, ~378 tests; no skips added)
- [ ] The relevant docs/ component file reflects the new behavior
- [ ] docs/CHANGELOG.md has a new dated entry at the top: `## YYYY-MM-DD: short title`, prose explaining what and why (including the real-world trigger if it was a bug), then a `### Changes` bullet list of `path: what changed`
- [ ] `git diff` of prose and comments shows no em/en dashes (`grep -P '[\x{2013}\x{2014}]'` on changed files)
- [ ] Commit message is `feat(scope):` / `fix(scope):` / `docs:` / `chore(scope):` / `test(scope):`, body explains why, ends with the Co-Authored-By trailer

**Bug fix, additionally:**
- [ ] A regression test exists that fails without the fix
- [ ] The changelog entry names the real-world scenario that triggered it

**New or changed endpoint, additionally:**
- [ ] Factory pattern, static-before-param ordering, 400/404/409 semantics, COALESCE partial updates, transactions on multi-writes
- [ ] docs/api.md entry with a fenced JSON example, required/optional fields, and status codes
- [ ] A supertest file covering success, validation failure, and not-found

**Driver work, additionally:**
- [ ] The full checklist in .claude/skills/add-connector/SKILL.md (contract, registration touchpoints, mocked tests, docs, honest hardware status)

**Client change, additionally:**
- [ ] `npm run build` succeeds
- [ ] Toast/confirm rules followed; loading state exists; palette copied from an existing page
- [ ] Works at the 600 px breakpoint if layout changed

**Docs-only change:**
- [ ] Format matches the existing doc (compare against a recent section before writing)
- [ ] Dash-free; docs/README.md index updated if a file was added

**Community PR review:**
- [ ] Follow .claude/skills/pr-review/SKILL.md (adjacent-code audit, sync pairs, part-count scrutiny, severity-tagged findings)

## When uncertain: escalation rules

Ask Joel before acting when any of these is true. Otherwise act, and flag assumptions in your summary.

1. **completed_qty:** the change adds or alters any path that increments or decrements `parts.completed_qty`, beyond mechanically preserving existing behavior. Present the analysis first: what unique real-world event backs the credit, and why it cannot double-fire across restart, reconnect, or poll flap.
2. **Schema:** anything beyond an additive `ALTER TABLE ADD COLUMN` or new `CREATE TABLE IF NOT EXISTS`.
3. **Dependencies:** any new runtime dependency (native modules doubly so; remember Windows plus Node 22/23).
4. **Public onboarding docs:** restructuring README.md or docs/installation.md. Small accuracy fixes are fine autonomously.
5. **Scope growth:** the fix "wants" a new page, subsystem, or feature surface, or touches a parked feature (filament tracking, camera streaming, diagnostics panel, multi-group).
6. **Protocol dead end:** official docs for a protocol behavior cannot be found. Report what you searched and what is missing; do not guess.

Act without asking, then report plainly:
- Driver code written from protocol docs but unvalidated on hardware: ship it labeled "not yet validated on hardware".
- Test failures unrelated to your change: leave them failing, report the exact output.
- A discovered bug outside the task: report it; fix it only if it blocks the task.

Default philosophy when torn between inferring and asking the operator (in product code): the system asks the operator. Hold the printer, add a notification, let Set Ready resolve it. That is the design's answer to ambiguity, and it is also yours.

## Skills

- `/ship`: finishing pass for any change (tests, docs, changelog, dash check, commit).
- `/add-connector`: scaffold and register a new printer brand driver end to end.
- `/pr-review`: review a community PR with this repo's specific failure modes in mind.
