# CLAUDE.md: Print Farm Manager Operating Manual

Print Farm Manager runs a real fleet of 50+ printers (Prusa, Bambu, Elegoo, Klipper, OctoPrint) and has been public open source since v1.0.0 (github.com/joeltelling/print-farm-manager). This checkout is the seanlw/print-farm-manager fork; the upstream repository has stopped receiving commits (as of 2026-09), so this fork carries its own CI, Dependabot config, and dependency updates. Two consequences shape every decision:

1. Correctness bugs land on physical hardware. A bad dispatch or a double-credited part count wastes plastic, printer hours, and operator trust.
2. Docs are a product surface. Strangers self-install from README.md and docs/installation.md, and community contributors build drivers from docs/driver-authoring.md.

## Session start

- Read docs/README.md first. It is the doc index and current project map.
- ARCHITECTURE.md is the original spec. All phases (1 through 6D) are complete and shipped. Its "what NOT to build" sections are stale phase briefings, not current constraints. The code and docs/ are the source of truth.
- Deliberately parked features (do not build as a side effect of another task): filament/spool tracking, Bambu camera streaming, printer diagnostics panel, multi-group printers. Sean (the fork owner) decides when these resume. One exception exists: an optional Spoolman integration (server/integrations/spoolman.js, server/routes/spoolman.js, docs/spoolman.md) was built on this fork and does not exist upstream.
- docs/proposals/ is a local-only folder of internal planning notes. It is deliberately never committed (it may be absent in a fresh clone), is not in the doc index, and is not current behavior. Do not commit it or link to it from committed docs. The one decision it holds that matters here: the client test framework (Vitest, dev dependencies only) is being built in phases. Phase 1 is done (Vitest, `client/src/lib/format.js`, `client/tests/`). Still planned and approved: a thin DOM layer (happy-dom and React Testing Library, added when that phase starts), and extracting the shared "awaiting sign-off" predicate. Playwright end-to-end tests are deferred. Do not add a dependency beyond Vitest, happy-dom, `@testing-library/react` and `@testing-library/dom` without asking Sean.

## The five non-negotiables

1. **Part counts are sacred.** Any code path that changes `parts.completed_qty` must be backed by exactly one real-world event and must be impossible to double-fire across server restarts, MQTT reconnects, and poll flaps. See "The phantom part credit" below.
2. **Docs ship with the change.** Every feature or fix updates the relevant docs/ file and adds a dated docs/CHANGELOG.md entry in the same commit.
3. **No em dashes or en dashes in prose.** Use commas, colons, parentheses, or plain hyphens in every doc, comment, commit message, and UI string you write. Verify with `grep -rPn '[\x{2013}\x{2014}]'` on your changed files before finishing. (Legacy docs contain thousands of them; do not fix lines you are not otherwise touching.)
4. **Read official protocol docs before touching driver code.** Never guess field names, URL formats, or payload shapes for PrusaLink, Bambu MQTT (OpenBambuAPI), Moonraker, SDCP, or OctoPrint. If the doc is not findable, stop and say so.
5. **Never claim hardware validation that did not happen.** "Implemented from protocol docs, not yet validated on hardware" is the honest and expected phrasing until someone has run it on a real printer and reported the result.

## Architecture in one minute

- `server/index.js`: Express entry. Serves the built client from `client/dist` in production (same origin, port 3000) and hosts the operator-action endpoints (set-ready, recommission, set-ready-batch) inline because they need the scheduler instance.
- `server/db.js`: opens SQLite (WAL), creates tables with `CREATE TABLE IF NOT EXISTS`, then runs additive startup migrations as `try { db.exec('ALTER TABLE ...') } catch (_) {}` lines. This is the entire migration system.
- `server/poller.js`: polls every active printer every 15 s via its driver, writes status to the printers table, emits `statusChange` and `printerIdle`.
- `server/scheduler.js`: listens to poller events, picks the highest-priority open part with a matching G-code (model, group, material, color), inserts a job row as a dispatch lock, uploads, and handles FINISHED/ERROR/OFFLINE/STOPPED transitions. Batched sweeps respect `dispatch_batch_size`. `scheduleForPrinter` is the single dispatch entry point: the `printerIdle` handler and the no-job fallback both route through it, so new code should not call `_dispatchToPrinter` directly.
- `server/integrations/spoolman.js` plus `server/routes/spoolman.js` and `server/routes/filaments.js`: the optional, off-by-default Spoolman integration and the Filament Library (fork only, see Session start). `server/backup.js` takes and prunes automatic database backups at startup, separate from the export/restore in `server/routes/backup.js`.
- `server/drivers/`: one module per brand behind a lazy registry (`drivers/index.js`). Contract lives in docs/driver-authoring.md.
- `server/routes/`: one factory module per resource, `module.exports = (db) => router`.
- `client/`: Vite 8 + React 18 SPA, with pure display helpers in `client/src/lib/` and Vitest tests in `client/tests/`. Runtime deps are kept deliberately few: react, react-dom, react-router-dom (v7, classic component and hook API only), i18next with react-i18next and the browser language detector, and three (the G-code viewer). No axios, no CSS framework, no state library. Everything hand-rolled and dark-themed. Adding a runtime dependency is an escalation (rule 3 below).
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
- Schema changes are additive only: a new `try/catch ALTER TABLE` line in db.js. No migration framework, no destructive migrations, nothing that loses data on an existing install. Order matters: an older migration rebuilds `jobs` to make `gcode_id` nullable and hardcodes the pre-Spoolman column list, so any new `ALTER TABLE jobs ADD COLUMN` must be placed after that rebuild (see the 2026-08-03 CHANGELOG entry and `server/tests/db-fresh-install.test.js`). Always verify a schema change against a brand-new database, not only your long-lived dev one.
- G-code uniqueness on `(part_id, printer_model)` is enforced in the routes, not by a DB constraint.
- Log lines are prefixed with the module: `console.log('[scheduler] ...')`.
- Timing constants are named, in caps, with a comment stating what they must exceed and why (see `STALE_JOB_GRACE_MS` in scheduler.js).
- Node is pinned to `>=22 <24` (native better-sqlite3 build breaks on Node 24 on Windows). The production farm machine is Windows: use `path.join`, split stored paths with `split(/[\\/]/)`, and keep update.bat working.
- `DEMO_MODE=true` skips real polling; `server/seed-demo.js` fills a demo DB. Use these when developing without printers. A dev database that was restored from real farm data still points at real printer IPs, so set `DEMO_MODE=true` for any browser check or experiment, or the poller will contact real hardware.
- Root `npm test` runs the server Jest suite and then the client Vitest suite (`npm run test:server` and `npm run test:client` run them separately). Run it in Docker when the host Node is not 22.x: `docker compose run --rm print-farm-manager-dev npm test` (or `exec` against a running dev container). After changing dependencies, rebuild the image and renew its anonymous volumes (`docker compose up -d --build -V print-farm-manager-dev`), or the container keeps the old `node_modules`.

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
- Client tests cover pure logic only: `client/src/lib/format.js`, translation keys, `en.json`, and the client/server input formats. Put new display logic that does not need React in `client/src/lib/` with a test in `client/tests/`, never copy a formatter into a page. Pages, hooks and the G-code viewer have no automated tests yet, so verify those in a browser (dev container, `DEMO_MODE=true`) and say in your summary exactly which routes and interactions you checked.
- New UI text goes through i18n, never hardcoded in JSX. Add a key to `client/src/locales/en.json` (the source of truth for every user-facing string, and the schema every other language file must match) and render it with `t('namespace.key')`. See docs/TRANSLATING.md for the key convention, pluralization, and `common.*` versus a page namespace.

## Sync pairs: code that must change together

If you touch one side of a pair, grep for and update the other in the same commit. These have each caused a real bug or review finding:

| If you change | You must also check |
|---|---|
| Scheduler candidate/eligibility SQL (scheduler.js) | `GET /api/parts/:id/dispatch-status` in routes/parts.js, which mirrors it for operator diagnostics |
| Any new table or column | server/routes/backup.js export AND restore (column lists derive from the live schema; keep it that way), plus server/tests/backup-restore.test.js seeding and asserting it |
| Driver registry (drivers/index.js) | routes/models.js VALID_CONNECTORS, routes/printers.js NO_API_KEY_TYPES, and every brand touchpoint in client/src/pages/Settings.jsx (find them with `grep -rn "octoprint" client/src`) |
| A route's request/response shape | docs/api.md entry and the route's test file |
| "Awaiting sign-off" derived-status logic (`is_held === 1 && status FINISHED/IDLE/STOPPED`) | It is duplicated across Dashboard.jsx, Fleet.jsx, Printers.jsx; keep all copies identical. Known drift: the list-level `awaitingConfirmation` in Fleet.jsx omits `STOPPED` while Fleet's per-card check includes it. It is planned to be fixed by a shared `isAwaitingSignoff` helper as part of the client test framework work. Do not fix it in passing: it widens what bulk Set Ready can target, which needs the completed_qty analysis first. |
| `formatDurationForInput` / `formatMaterialForInput` (client/src/lib/format.js) or `normalizePrintTime` / `normalizeMaterialGrams` (server/routes/gcodes.js) | The other side, and `client/tests/input-format-contract.test.js`, which feeds the client's pre-filled text through the server's real parsers |
| A new `t('key')`, `i18nKey`, or `labelKey` in the client | `client/src/locales/en.json` (`client/tests/i18n-keys.test.js` fails on a key that does not exist) |
| Node version (package.json `engines`, Dockerfile `FROM node:`, CI `node-version`, the `node` ignore in .github/dependabot.yml) | Keep all four consistent with the `>=22 <24` pin. A Node 25 base-image bump once failed only because better-sqlite3 would not compile |
| A new `package.json` or Dockerfile in the tree | Add a matching entry to .github/dependabot.yml, or it is never updated |
| README.md install steps | docs/installation.md (and vice versa) |

## Named mistakes and the rule that prevents each

- **The async database.** Writing `await db.prepare(...)` or making route handlers async for DB work. Rule: better-sqlite3 is synchronous; `await` on a DB call is always wrong here.
- **The phantom part credit.** Adding a recovery path that credits `completed_qty` from a time-window heuristic ("a job failed recently, the printer says FINISHED now, credit it"). This shipped once with a 24-hour window and double-credited Bambu printers on every restart; it was a critical bug. Rule: recovery credit paths gate on the current process lifetime (`finished_at > scheduler.startedAt`), and when in doubt credit only on explicit operator action against a still-active job.
- **The stale-status replay.** Trusting the first statuses a Bambu printer reports after connect. First poll is OFFLINE (MQTT still connecting), second can be a FINISHED latched from before the server started. Rule: an OFFLINE to FINISHED transition never blindly credits; every FINISHED handler must survive a cold start against a stale printer state.
- **The guessed protocol field.** Fixing a driver by pattern-matching what the payload "should" look like. Four consecutive wrong commits were once made on the Bambu project_file URL. Rule: fetch the official protocol doc (the URL is usually in the driver's header comment) before editing any driver payload.
- **The hold bypass.** "Fixing" a stuck printer by clearing `is_held` or auto-resolving a job in code. Holds exist so a human confirms physical outcomes. Rule: only operator endpoints (set-ready, recommission) and the one documented auto-unhold (held printer recovers to PRINTING with a live job) may clear a hold.
- **The route shadowed by :id.** Adding `router.put('/reorder')` after `router.put('/:id')` and wondering why reorder 404s with "Part not found". Rule: static paths are declared above parameterized ones in every route file.
- **The destructive migration.** Renaming or dropping a column, or adding a migration framework. Rule: schema evolution is additive `try/catch ALTER TABLE` in db.js only; anything else needs Sean's sign-off (existing installs in the wild must survive `git pull`).
- **The silent Moonraker no-op.** Passing upload options as query params. Moonraker returns 200 and ignores them; the print never starts. Rule: Moonraker options are form fields appended to the multipart body.
- **The window.confirm shortcut.** Using `window.confirm`/`alert` for a destructive action. Rule: `useConfirm` with `danger: true`, and render the modal element.
- **The invisible toast.** Calling `showToast` without rendering `{toastEl}` in the JSX. Rule: every page that mutates renders both `{toastEl}` and `{confirmModal}` at the end of its JSX.
- **The poll-error toast storm.** Surfacing background poll failures through the toast channel, spamming an operator every 15 s while a printer reboots. Rule: poll errors are swallowed or shown as a passive banner; only user-initiated actions toast.
- **The diff-only review.** Reviewing a PR by reading only changed lines. A community PR once fixed backup export while the adjacent restore code kept a stale hardcoded column list, silently dropping data. Rule: audit the unchanged code adjacent to a diff, especially the sync pairs table above.
- **The forgotten changelog.** Landing a change with no docs/CHANGELOG.md entry or component-doc update. Rule: docs are part of the definition of done, not a follow-up.
- **The fake hardware pass.** Describing a driver as working because tests pass against mocks. Rule: state hardware-validation status explicitly in the changelog entry and the summary; mocks prove the contract, not the printer.
- **The Windows path break.** Building paths with string concatenation and `/`, or shell commands that assume bash. Rule: `path.join` for construction, `split(/[\\/]/)` for parsing stored filepaths, and remember update.bat and PM2 on the farm machine.
- **The convenient timestamp.** Storing `new Date().toISOString()` or epoch seconds. Rule: `Date.now()` milliseconds, INTEGER column, everywhere.
- **The heavyweight test.** Importing server/index.js or the real db.js in a test. Rule: tests build `new Database(':memory:')`, define the minimal schema inline, mount the route factory on a throwaway Express app, and drive it with supertest. Drivers mock the transport (`jest.mock('axios')`, mocked mqtt), never the driver module itself. The single deliberate exception is `server/tests/db-fresh-install.test.js`, which loads a copy of the real db.js into a scratch directory because the bug class it guards (migration ordering on a fresh database) cannot be reproduced any other way.
- **The migration order trap.** Adding an `ALTER TABLE jobs ADD COLUMN` above the older `jobs` table rebuild in db.js. The rebuild hardcodes the old column list, so fresh installs crashed with a column-count mismatch while the long-lived dev database, already past that migration, hid it. Rule: new `jobs` columns go after the rebuild, and every schema change is tested against a brand-new database.
- **The duplicated helper.** Copy-pasting a formatter into a page. `formatDuration` once existed three times with three different signatures, and the awaiting sign-off condition drifted between Fleet, Dashboard and Printers. Rule: shared display logic goes in `client/src/lib/format.js` (or a sibling) with a test, and the duplicated-copies problem is solved by importing, not by a sync-pair note.
- **The snapshot test.** Snapshotting rendered markup or inline style objects. Every cosmetic tweak breaks it and nobody learns anything from the diff. Rule: assert on behavior and on chosen translation keys and values, never on styles.
- **The fake browser pass.** Treating a green client test suite as proof the UI works. The suite covers pure logic in plain Node; it never renders a page, a hook, the router, or the WebGL viewer. Rule: for anything past `client/src/lib/`, still check it in a real browser and say what you checked.
- **The blind dependency bump.** Merging a Dependabot major because CI is green. CI runs the server suite and a Docker build, not the client at runtime. Dependabot proposed Node 25 (better-sqlite3 will not compile) and react 19 without react-dom (npm ERESOLVE); the Docker build caught those only because they failed to install, while a bump that builds but breaks at runtime (router, three) would pass CI. Rule: majors and anything that touches routing, the G-code viewer, or the build toolchain get a real browser check in the dev container with `DEMO_MODE=true` before merging.

## Quality bar per deliverable

Every bar is a checklist. A deliverable is done when every box is checked, not when it "looks good".

**Baseline for any code change:**
- [ ] `npm test` passes in full (no skips added), which runs the server and client suites. Run it in Docker if the host Node is not 22.x
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
- [ ] Client tests pass, and new shared display logic lives in `client/src/lib/` with a test
- [ ] Pages, hooks or the viewer changed: browser-checked against the dev container with `DEMO_MODE=true`, and the summary names what was checked
- [ ] Toast/confirm rules followed; loading state exists; palette copied from an existing page
- [ ] Works at the 600 px breakpoint if layout changed

**Docs-only change:**
- [ ] Format matches the existing doc (compare against a recent section before writing)
- [ ] Dash-free; docs/README.md index updated if a file was added

**Community PR review:**
- [ ] Follow .claude/skills/pr-review/SKILL.md (adjacent-code audit, sync pairs, part-count scrutiny, severity-tagged findings)

## When uncertain: escalation rules

Ask Sean before acting when any of these is true. Otherwise act, and flag assumptions in your summary.

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

## Dependabot

- Config lives in .github/dependabot.yml: monthly, 7-day cooldown, minor and patch updates grouped per manifest, GitHub Actions grouped into one PR. Major bumps of better-sqlite3, the `node` image, react, and react-dom are ignored on purpose and are done by hand.
- Security updates are separate from that schedule and still open promptly.
- Reviewing a Dependabot PR: green CI is necessary, not sufficient (see "The blind dependency bump"). Read the changelog for majors, check the sync pairs table for the Node pin, and browser-check client-side or build-tool bumps before merging.
- When a PR conflicts after another merge (usually `package-lock.json`), comment `@dependabot rebase` on it.

## Skills

- `/ship`: finishing pass for any change (tests, docs, changelog, dash check, commit).
- `/add-connector`: scaffold and register a new printer brand driver end to end.
- `/pr-review`: review a community PR with this repo's specific failure modes in mind.
- `/review`: execution-verified review of a PR or branch against main.
