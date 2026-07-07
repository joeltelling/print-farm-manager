# Writing a Printer Connector (Driver Authoring Guide)

This guide is for printer manufacturers and community contributors who want to add support for a new printer brand or protocol. It documents the full driver contract: the four required functions, the canonical status model and exactly how the system reacts to each status, the two architecture patterns to copy from, and every file a new connector touches.

Read [multi-brand.md](multi-brand.md) first for the history and design rationale of the driver layer, and [CONTRIBUTING.md](../CONTRIBUTING.md) for general contribution rules. This document is the technical contract.

---

## How a Connector Fits In

One driver file covers a **connector family**: every printer model that speaks the same protocol. The farm never talks to printers directly; two subsystems call your driver through the registry:

- **The poller** (`server/poller.js`) calls `getStatus(printer)` for every active printer every 15 seconds and writes the result to the DB. Status *transitions* drive everything else: dispatch, part crediting, operator holds.
- **The scheduler** (`server/scheduler.js`) calls `uploadAndPrint(...)` to start jobs, `checkIfPrinting(...)` to recover from ambiguous upload failures, and `cancelJob(...)` when the farm cancels a job.

Your driver is the only brand-specific code in the system. The poller, scheduler, DB schema, and UI are shared and must not need changes for a new brand (with the small UI registration exceptions listed in the checklist below).

Two hard boundaries:

- **Drivers never touch the database.** Everything a driver needs arrives on the `printer` row passed to every function. Drivers return data; the poller and scheduler decide what to persist.
- **Drivers own all protocol state.** If your protocol needs a persistent connection, hold it in a module-level Map keyed by `printer.id` (see the persistent-connection pattern below). Nothing outside the driver knows the connection exists.

---

## The Driver Interface

Every driver exports four async functions. All take the `printer` DB row as the first argument.

```
getStatus(printer)
  → { status, progress, timeRemaining, currentFile }

uploadAndPrint(printer, gcodeFullPath, filename, options)
  → resolves when the print is confirmed started; throws on failure

cancelJob(printer)
  → resolves when cancellation is confirmed (or logged as failed)

checkIfPrinting(printer)
  → boolean
```

Optional exports:

```
deleteFile(printer, filename)
  → if exported, the scheduler calls it after a job finishes to clean the
    file off the printer's storage (see bambu.js). Fire-and-forget: errors
    are swallowed by the caller.
```

### The `printer` row

Fields your driver can rely on:

| Field | Meaning |
|---|---|
| `printer.id` | Stable numeric ID. Use as the key for any module-level connection Map. |
| `printer.ip` | Host, possibly with a port (`192.168.1.50:5000`). Never assume port 80 is implied if your protocol uses another port; either document a fixed port (Klipper uses 7125) or accept host:port in this field (OctoPrint pattern). |
| `printer.api_key` | Whatever secret your protocol needs. The column name is historical: Bambu stores its LAN access code here, Elegoo SDCP and Klipper store `''`. |
| `printer.serial_number` | Used by protocols that need a device ID (Bambu MQTT topics, CC2). `''` otherwise. |
| `printer.name` | Operator-facing display name. Use it in log lines. |
| `printer.type` | Your connector ID (the registry key). |

`model`, `group_name`, `loaded_material`, and `loaded_color` also exist on the row but belong to the scheduler's routing logic; drivers should not read them.

### getStatus(printer)

Returns `{ status, progress, timeRemaining, currentFile }`.

- `status`: one of the canonical statuses (next section). This is the single most important thing your driver produces.
- `progress`: 0 to 100 while `PRINTING`, otherwise `null`.
- `timeRemaining`: seconds while `PRINTING`, otherwise `null`.
- `currentFile`: display name of the file being printed, or `null`. If `null`, the poller falls back to a DB join through the jobs table, so only populate it if your protocol reports it directly.

Rules:

- **Never throw.** Wrap the whole body in try/catch and return `{ status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null }` on any failure. The poller treats an exception as a bug, not as an offline printer.
- **Keep it fast.** The poll interval is 15 seconds and all printers are polled concurrently. Use a request timeout of about 8 seconds so a dead printer cannot stall the loop into the next tick.
- **Be stateless if you can.** If your protocol is request/response over HTTP, follow `prusa.js` / `klipper.js` / `octoprint.js`. If it pushes state over a persistent connection, cache the latest payload and answer from cache (see `bambu.js`).

### uploadAndPrint(printer, gcodeFullPath, filename, options)

Uploads a file and starts printing it, in whatever way your protocol requires (one call, upload-then-command, chunked transfer, and so on).

- `gcodeFullPath` is a resolved absolute path that already exists on disk. Read it with a stream for large files.
- `filename` is the bare name to use on the printer (`part.gcode`).
- `options.amsSlot` is a material-slot index for printers with a multi-material unit (`-1` or `null` means default/external spool). Ignore it if your hardware has no equivalent.
- **Resolve only when the print is confirmed started.** The scheduler marks the job `printing` the moment your promise resolves. Resolving after a successful upload but before the print command is acknowledged will mark jobs as printing that never started.
- **Throw on failure.** The scheduler retries: 3 attempts total, 5 seconds apart.
- **Throw `UPLOAD_CONFLICT` for transfer-in-progress conflicts.** If your protocol can reject an upload because a previous transfer is still running (typically a prior attempt that timed out on our side but continued on the printer), throw an error with `code: 'UPLOAD_CONFLICT'`:

  ```js
  throw Object.assign(new Error('transfer already in progress'), { code: 'UPLOAD_CONFLICT' });
  ```

  The scheduler waits 60 seconds before retrying a conflict instead of 5, giving the in-flight transfer time to finish.
- Use a generous timeout (the existing drivers use 5 minutes) since files can be large and farm networks slow.

If all attempts fail, the scheduler calls your `checkIfPrinting()` before giving up. This recovers the common failure mode where the upload request timed out client-side but the printer received the file and started anyway. Get `checkIfPrinting` right and this whole class of network flakiness self-heals.

### cancelJob(printer)

Called when the farm cancels a job (operator action). Attempt the cancellation and log a warning on failure rather than throwing; callers do not handle rejections from this function. If your protocol has no reliable cancel, ship a documented stub (see `prusa.js`) rather than a best-effort guess that might cancel the wrong thing.

### checkIfPrinting(printer)

Return `true` if the printer is currently printing **or paused**, `false` otherwise, and `false` on any error. Paused counts as printing because a paused job is still occupying the printer and still recoverable.

---

## Canonical Statuses: What the System Does With Each

Your driver's core job is mapping native protocol states onto this set. The poller only reacts to *transitions* (the DB status changing between polls), so a latched status that repeats every poll is fine.

| Status | Meaning | What the system does on the transition |
|---|---|---|
| `IDLE` | Ready for work | Poller emits `printerIdle`; the scheduler immediately tries to dispatch a job. **Only report IDLE when the printer can genuinely accept a print.** |
| `PRINTING` | Actively printing (including heating/leveling/preparing) | Progress and time remaining are persisted each poll. A transition back to PRINTING also auto-recovers a job that was held for a transient OFFLINE or ERROR blip. |
| `PAUSED` | Print paused (filament runout, user pause) | Printer is held for operator attention if it has an active job. The job stays `printing`. |
| `FINISHED` | A print completed successfully | **The scheduler credits the part count** (`completed_qty += parts_per_plate`), marks the job finished, and holds the printer until an operator confirms print quality. See the warning below. |
| `STOPPED` | Print cancelled by a person at the printer | The scheduler cancels the job (no part credit) and holds the printer for operator sign-off. |
| `ERROR` | Firmware-detected fault | The job is failed, the printer is held. |
| `OFFLINE` | Unreachable | Treated as transient: the job is left as `printing` and the printer is held. If the printer comes back PRINTING, the hold auto-clears. |
| `READY` | Prusa-specific "operator armed the printer" state | Treated as a safe state; does not trigger dispatch. Most drivers never emit it. |
| `UNKNOWN` | Native state you did not recognize | Safe fallback. Holds the printer if it has an active job. Log the raw native state so it can be classified and mapped in a follow-up. |

### FINISHED is load-bearing: the no-double-credit rule

`FINISHED` is the only status that mutates inventory. The project's hardest rule (see CONTRIBUTING.md, "Part counts are sacred") lands directly on your status mapping:

- **Report FINISHED only for a print that actually completed.** Never for a cancelled print (that is `STOPPED`), never as a synonym for idle.
- **Beware reconnect flapping.** The poller fires on transitions, so `FINISHED → OFFLINE → FINISHED` (a network blip while the printer sits on its "print complete" screen) is two FINISHED transitions. The poller and scheduler have guards for this (hold gating on active jobs, process-lifetime gating on job recovery), but your driver must not make it worse: after a reconnect, do not report FINISHED until you have *fresh* state from the printer confirming it. Returning OFFLINE until the first post-reconnect status message arrives (the `bambu.js` pattern) is the safe default.
- **Cold start matters.** When the farm server restarts while a printer sits on a stale "complete" screen from a print the farm never dispatched, your driver will report FINISHED and the scheduler will find no matching job. That path is handled (it logs "may be outside system" and moves on), but only because FINISHED maps honestly. Do not try to suppress or synthesize states based on what you guess the farm knows.

### Distinguish user-cancel from genuine faults

If your protocol reports a cancelled print and a failed print as the same native state (Bambu does: both are `gcode_state: FAILED`), you must find the disambiguating signal (Bambu uses `print_error` codes) and split them into `STOPPED` vs `ERROR`. Mapping user cancels to `ERROR` shows operators a false fault they cannot clear; mapping faults to `STOPPED` hides real failures. The Bambu section of [multi-brand.md](multi-brand.md) documents the worked example.

### Synthesizing FINISHED when your protocol has no such state

Some firmwares report the same idle state before and after a print. If so, you must synthesize FINISHED from available evidence, and the condition must (a) be true continuously until the next print starts, and (b) clear itself when one does. The OctoPrint driver is the reference: not printing + a job file still loaded + completion at 100%. Because the poller reacts only to the transition, a condition that stays true is reported once, and the hold gate prevents re-holds after operator confirmation.

---

## Two Architecture Patterns

Pick the one matching your protocol and copy its structure.

**Stateless polling** (`prusa.js`, `klipper.js`, `octoprint.js`): request/response HTTP. No state between calls, no connection management. Each function makes its own requests with timeouts. This is the simpler pattern; prefer it if your protocol allows.

**Persistent connection** (`bambu.js`, `elegoo-centauri.js`, `elegoo-centauri2.js`): WebSocket or MQTT. The driver holds a module-level `Map` of `printer.id → connection`, creates connections lazily on first use, auto-reconnects on drop, and merges pushed status updates into a cached "latest state" object. `getStatus()` answers from cache instantly. Return `OFFLINE` until the first status message arrives after (re)connect: an open socket with no data yet is not a reachable printer, and reporting stale pre-disconnect state after a reconnect is how false FINISHED transitions happen.

**Dependency loading rule (both patterns):** the registry (`server/drivers/index.js`) loads drivers lazily, so a farm with no printers of your brand never loads your module. Keep it that way: require heavy or native dependencies (`mqtt`, `ws`, protocol SDKs) at the top of *your driver file only*, never in shared files. If your driver needs a new npm package, that is fine; note it in your PR and the docs.

**Conventions:** prefix log lines with your connector ID (`[bambu] ...`); include `printer.name` in every message; comment the top of the file with the protocol reference URLs you worked from.

---

## Registration Checklist

Everything a new connector touches, in order:

1. **`server/drivers/<your-id>.js`**: the driver itself. The connector ID is lowercase, hyphenated, and permanent (it is stored in every printer row).
2. **`server/drivers/index.js`**: add one lazy loader line to `LOADERS`.
3. **`server/routes/printers.js`**: if your protocol needs no API key, add your ID to `NO_API_KEY_TYPES` so printer creation does not demand one.
4. **`client/src/pages/Settings.jsx`**: register the connector in the Add Printer form: `TYPE_OPTIONS` (dropdown entry), the type-to-label map, `NO_API_KEY_TYPES` (hides the key field), `CREDENTIAL_HELP` (one sentence telling the operator where on the printer to find the credentials), the name placeholder, and the serial-number field condition if your protocol needs one. The reliable way to find every touch point: search the client for an existing connector ID (`grep -rn "octoprint" client/src`).
5. **`server/tests/<your-id>-driver.test.js`**: driver tests with the network layer mocked. See `server/tests/octoprint-driver.test.js` for the pattern. Cover every native-state-to-canonical-status mapping and the UPLOAD_CONFLICT path.
6. **Docs**: add your connector family to the table in `docs/multi-brand.md` plus a notes section for protocol quirks; add a dated entry to `docs/CHANGELOG.md`; add a row to the Supported Printers table in `README.md` and the credentials table in `docs/installation.md`.

Printer **models** need no code: operators register models at runtime (Settings → Printer Models) and pick your connector for each. Your driver never sees the model string.

---

## Testing Against Real Hardware

Automated tests with mocked networks catch mapping bugs; they cannot catch a protocol behaving differently than its documentation claims. Before a connector ships, run this matrix on a real printer and report the results in your PR (per CONTRIBUTING.md, stating your hardware and firmware version):

1. **Every status**: idle, printing (check progress and time remaining update), paused, completed, cancelled, faulted (if you can provoke one safely).
2. **Cancel from the printer's own screen** mid-print. Verify the farm shows `STOPPED`, not `ERROR` or `FINISHED`.
3. **Dispatch a job from the farm** and let it run to completion. Verify exactly one part credit and that the printer is held for confirmation.
4. **Pull the network cable mid-print**, wait for `OFFLINE`, plug it back in. Verify the farm recovers to `PRINTING` and the job survives with no duplicate credit when it finishes.
5. **Restart the farm server mid-print.** Verify the printer is picked up as `PRINTING` on the first poll and the job completes normally.
6. **Restart the farm server while the printer sits on its "print complete" screen.** Verify no part is double-credited.
7. **Upload timeout recovery**: if you can simulate a slow network, verify that an upload which times out client-side but starts on the printer is recovered via `checkIfPrinting` rather than double-dispatched.
8. **Filament runout** (if your hardware detects it): verify it maps to `PAUSED`, the printer is held, and resuming at the printer returns it to `PRINTING`.

---

## Developing Without a Fleet

- `npm run dev` runs the server and client with no printers configured. Add your printer via Settings once your driver is registered.
- A printer row pointing at an unreachable IP exercises your OFFLINE path every 15 seconds.
- `DEMO_MODE=true` disables polling entirely if you need the UI without driver noise.
- The poll loop logs every status transition (`[poller] Name: OLD → NEW`), which is usually all you need to watch while validating mappings. Add temporary logging of raw native states inside your driver while classifying them.

---

## Reference Implementations

| Driver | Pattern | Worth copying for |
|---|---|---|
| `octoprint.js` | Stateless HTTP | The cleanest recent example; synthesized FINISHED detection |
| `prusa.js` | Stateless HTTP | UPLOAD_CONFLICT handling, pre-delete before upload |
| `klipper.js` | Stateless HTTP | Fixed non-80 port convention |
| `bambu.js` | Persistent (MQTT) | Connection Map, cached push state, partial-update merging, STOPPED/ERROR disambiguation, optional `deleteFile` |
| `elegoo-centauri.js` | Persistent (WebSocket) | Request/response correlation over a socket |
| `elegoo-centauri2.js` | Persistent (MQTT) + chunked HTTP upload | Mixed-transport protocols |
