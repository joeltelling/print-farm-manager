---
name: add-connector
description: Scaffold, register, test, and document a new printer brand driver (connector) end to end. Use when adding support for a new printer brand or protocol, or when reviewing a community driver PR for completeness.
---

# Add a Printer Connector

You are adding a new printer brand to Print Farm Manager. This is a 6-file change with a hard behavioral contract. Work through the phases in order and do not skip the final checklist.

## Phase 0: Protocol research (do this before writing any code)

1. Read `docs/driver-authoring.md` in full. It is the contract this skill enforces.
2. Read `docs/multi-brand.md` for the design background.
3. Find the official protocol documentation for the brand and fetch it (WebFetch or WebSearch). Known references:
   - Bambu: https://github.com/Doridian/OpenBambuAPI
   - Klipper: Moonraker web API docs (note: upload options like `print=true` are multipart FORM FIELDS, never query params; Moonraker silently ignores query params)
   - Prusa: PrusaLink OpenAPI spec
   - Elegoo: SDCP protocol docs / elegoo-link source
4. Never guess at field names, URL formats, or command payloads. Four consecutive wrong commits were once made on the Bambu `project_file` URL format because the docs were not checked. If you cannot find authoritative docs for a payload, stop and tell Joel what is missing rather than guessing.
5. Decide the connection model before coding:
   - Stateless request/response polling (Prusa, Klipper, OctoPrint pattern): no module state at all.
   - Persistent connection (Bambu, CC2 pattern): module-level `const connections = new Map()` keyed by `printer.id`, status served from a cached last-known payload, OFFLINE until the first message arrives.

## Phase 1: The driver file

Create `server/drivers/<id>.js` where `<id>` is the lowercase brand id (e.g. `octoprint`, `elegoo-centauri2`).

Exact interface (all async, `printer` DB row is always the first argument):

```js
module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
// optional extra: deleteFile(printer, filename)
```

Contract rules, each one checkable:

- `getStatus(printer)` returns `{ status, progress, timeRemaining, currentFile }`. It must NEVER throw: wrap everything, return `{ status: 'OFFLINE', progress: null, timeRemaining: null }` on any error. Request timeout around 8000 ms.
- `status` must be one of the canonical strings: `IDLE | PRINTING | PAUSED | FINISHED | STOPPED | ERROR | OFFLINE | READY | UNKNOWN`. Map every native state explicitly. Two mappings matter most:
  - User-cancelled prints map to `STOPPED`, not `ERROR` (ERROR fails the job; STOPPED cancels it and waits for the operator).
  - `FINISHED` is the ONLY status that credits inventory. Never synthesize FINISHED from a guess, and never let a reconnect or cold start replay a stale FINISHED (see the no-double-credit section of `docs/driver-authoring.md`).
- `uploadAndPrint(printer, gcodeFullPath, filename, options)` resolves only when the print has actually been started, throws on failure. If the printer reports a transfer already in progress, throw with `err.code = 'UPLOAD_CONFLICT'` so the scheduler applies its 60 s retry delay instead of 5 s.
- `checkIfPrinting(printer)` returns a boolean, true for printing OR paused, false on any error. The scheduler uses it to detect "upload timed out on our side but the printer started anyway".
- `cancelJob(printer)` logs failures, does not throw. A stub is acceptable if the protocol has no reliable cancel.
- Drivers NEVER touch the DB. No `require('../db')`, no SQL. All protocol state lives in the driver module.
- File header comment follows the house pattern: protocol summary, prerequisites on the printer, which DB fields hold credentials (`printer.ip`, `printer.api_key`, `printer.serial_number`), connection model notes, and the protocol reference URL.

## Phase 2: Registration (5 more touchpoints)

1. `server/drivers/index.js`: add one lazy loader line to `LOADERS`:
   ```js
   '<id>': () => require('./<id>'),
   ```
2. `server/routes/models.js`: add `<id>` to `VALID_CONNECTORS`.
3. `server/routes/printers.js`: if the brand has no API key, add it to `NO_API_KEY_TYPES`.
4. `client/src/pages/Settings.jsx`: run `grep -rn "octoprint" client/src` and mirror every hit for the new brand: `TYPE_OPTIONS`, the label map, `NO_API_KEY_TYPES`, `CREDENTIAL_HELP` text, name placeholder, and the serial-number field condition if the brand needs a serial.
5. If the brand needs a new DB column (like `serial_number` did), add it as an additive migration in `server/db.js`: `try { db.exec('ALTER TABLE ...'); } catch (_) {}`. Nothing destructive, no migration framework.

## Phase 3: Tests

Create `server/tests/<id>-driver.test.js`. House pattern:

- Jest + CommonJS. Mock at the transport layer: `jest.mock('axios')` for HTTP drivers, mock `mqtt`/socket for persistent drivers. `jest.clearAllMocks()` in `afterEach`.
- Cover at minimum, one test each:
  1. Each native state maps to the right canonical status (table-drive it).
  2. `getStatus` returns OFFLINE (not a throw) when the request fails.
  3. `uploadAndPrint` happy path sends the documented payload (assert URL, headers, form fields exactly).
  4. `uploadAndPrint` conflict path throws with `code: 'UPLOAD_CONFLICT'`.
  5. `checkIfPrinting` true for printing and paused, false on error.
- If a test needs a real file, write it into `server/gcode/` in `beforeAll`, track it in a `filesToClean` array, delete in `afterAll`.
- Run the full suite: `npm test`. All green before proceeding.

## Phase 4: Docs (not optional)

1. `docs/multi-brand.md`: add the brand section (protocol, credentials, quirks).
2. `README.md`: add a row to the Supported Printers table.
3. `docs/installation.md`: document how the operator finds the credentials on the printer.
4. `docs/CHANGELOG.md`: prepend a dated entry (`## YYYY-MM-DD: feat(drivers) add <Brand> connector`) with what/why prose and a `### Changes` file list.
5. All new prose: no em or en dashes. Verify with:
   ```bash
   grep -rPn '[\x{2013}\x{2014}]' docs/multi-brand.md README.md docs/installation.md
   ```
   (Only inspect the lines you added; legacy dashes elsewhere are not yours to fix in this change.)

## Phase 5: Hardware validation status

Software-complete is not hardware-confirmed. In the CHANGELOG entry and in your summary to Joel, state explicitly which of these has been done:

- [ ] Status mapping observed against a real printer
- [ ] Upload + auto-start confirmed on real hardware
- [ ] FINISHED transition credited exactly once
- [ ] Cancel-from-printer-screen maps to STOPPED
- [ ] Power-cycle / network-drop recovery observed

If none, say so plainly: "implemented from protocol docs, not yet validated on hardware". Never describe a driver as confirmed working without Joel having run it on a real printer.

## Final checklist (all must be true)

- [ ] Driver file implements all four functions with the exact signatures
- [ ] `getStatus` cannot throw; OFFLINE on error
- [ ] Every native state mapped to a canonical status, cancel maps to STOPPED
- [ ] `UPLOAD_CONFLICT` code on transfer-in-progress
- [ ] No DB access anywhere in the driver
- [ ] All 6 registration touchpoints done (drivers/index.js, models.js VALID_CONNECTORS, printers.js NO_API_KEY_TYPES if applicable, Settings.jsx mirror of grep hits, db.js additive migration if needed)
- [ ] Driver test file with the 5 minimum cases, `npm test` green
- [ ] multi-brand.md, README table, installation.md, CHANGELOG all updated
- [ ] New prose is dash-free
- [ ] Hardware validation status stated honestly
