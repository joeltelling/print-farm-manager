# Multi-Brand Printer Support

> **Phase 6B complete (2026-04-08).** Elegoo Centauri Carbon support is implemented via the `sdcp` npm package. Both Prusa and Elegoo printers are fully supported.

## Overview

The system was built against PrusaLink (Prusa's REST API). The `type` column on the `printers` table has always anticipated future brands. Phase 6 makes that column meaningful by introducing a **printer driver abstraction layer**.

The first non-Prusa target is the **Elegoo Centauri Carbon**, selected because:
- It's a capable FDM machine that would slot naturally into a mixed fleet
- Its community-documented SDCP protocol is well-understood (see external links below)
- Adding it exercises the full abstraction — protocol, auth, upload, and state mapping all differ from Prusa

See [ARCHITECTURE.md Section 13](../ARCHITECTURE.md#13-phase-6--multi-brand-printer-support) for the full spec.

---

## The Core Problem

PrusaLink is a REST API (HTTP polling). The Elegoo Centauri Carbon uses **SDCP — a WebSocket-based proprietary protocol**. They are fundamentally different communication models.

| Capability | PrusaLink | Elegoo SDCP |
|---|---|---|
| Status | `GET /api/v1/status` | WebSocket request/response on port 3030 |
| Upload | `PUT /api/v1/files/usb/{name}` | `POST /uploadFile/upload` (multipart) |
| Print trigger | `Print-After-Upload: 1` header | WebSocket command after upload |
| Auth | `X-Api-Key` header | None (LAN only) |
| File format | `.bgcode` / `.gcode` | `.gcode` only |

This means the poller and scheduler can't just swap a URL — they need to call different code entirely depending on printer brand.

---

## Canonical State Model

Both brands map their native states to a shared internal set. The rest of the system (poller events, scheduler logic, UI colors) never changes:

| Canonical | PrusaLink source | SDCP source |
|---|---|---|
| `IDLE` | `IDLE` | Not printing, cause code 0 |
| `PRINTING` | `PRINTING` | Active print job |
| `FINISHED` | `FINISHED` | Print completed |
| `PAUSED` | `PAUSED` | Paused |
| `ERROR` | `ERROR`, `ATTENTION` | Temperature / jam / homing fault |
| `OFFLINE` | Timeout | WebSocket unreachable |

---

## Driver Architecture

A new `server/drivers/` directory. Each driver exports three functions with the same interface:

```
getStatus(printer)         → { status, jobName, progress, timeRemaining }
uploadAndPrint(printer, filePath, filename)  → resolves when print confirmed started
cancelJob(printer)         → resolves when cancellation confirmed
```

The driver registry (`server/drivers/index.js`) maps `printer.type → driver module`. The poller and scheduler call `getDriver(printer.type)` and never touch brand-specific code directly.

---

## Files to Create

| File | Purpose | Status |
|---|---|---|
| `server/drivers/index.js` | Driver registry — maps type string to module | **Done** |
| `server/drivers/prusa.js` | Extracts existing PrusaLink logic from poller.js / scheduler.js | **Done** |
| `server/drivers/elegoo-centauri.js` | New SDCP WebSocket implementation | **Done** |

---

## Files to Modify

| File | What changes | Status |
|---|---|---|
| `server/poller.js` | Replace direct axios PrusaLink calls with `driver.getStatus(printer)` | **Done** |
| `server/scheduler.js` | Replace `_uploadGCode()` with `driver.uploadAndPrint(...)` | **Done** |
| `server/routes/printers.js` | Add `elegoo-centauri` type, `centauri-carbon` model, make `api_key` optional | **Done** |
| `client/src/pages/Fleet.jsx` | Add `centauri-carbon` to model list and labels | **Done** |
| `client/src/pages/Dashboard.jsx` | Same model list additions | **Done** |
| `client/src/pages/Settings.jsx` | Add model option; hide API key field for Elegoo brand | **Done** |

No DB schema changes are needed. The existing columns (`type`, `api_key`, `model`, `job_name`, `job_progress`, `job_time_remaining`) are all reusable.

---

## New Dependency

```bash
npm install sdcp
```

Uses the `sdcp` npm package (blakejrobinson) which wraps the SDCP WebSocket protocol, handling connection management, message framing, UUID-matched request/response correlation, and auto-reconnect. This replaced the original plan to use `ws` directly.

---

## Elegoo SDCP Notes

- Persistent WebSocket connection per printer (port 3030), managed inside the driver
- Reconnect on drop — the driver holds connections in a module-level Map keyed by printer ID
- Message format: `{ Id: "<uuid>", Data: { Cmd: <int>, RequestID: "<uuid>", MainboardID: "<str>" }, Topic: "..." }`
- No authentication — LAN access only; `api_key` stored as `''` in DB

### External References

- [OpenCentauri API docs](https://docs.opencentauri.cc/software/api/) — community-maintained spec
- [cassini](https://github.com/vvuk/cassini) — Node.js SDCP client (reference implementation)
- [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant) — Home Assistant integration with comprehensive state mapping
- [RemmyLee/carbon](https://github.com/RemmyLee/carbon) — developer documentation for SDCP

---

## G-Code Filename Parsing

The existing Prusa Slicer filename regex (`^(\d+)x ... .bgcode$`) will not match Elegoo/OrcaSlicer output. This is fine — the system already handles parse failures gracefully: it returns `parse_failed: true` and the operator enters `parts_per_plate` and model manually. No code change is needed for G-code parsing in Phase 6.

---

## What Is Not Changing

- The entire state machine in `poller.js` (hold logic, cold-start handling, event emission)
- The dispatch batching, ceiling math, and retry logic in `scheduler.js`
- The DB schema
- All existing Prusa functionality

The driver layer is an extraction + addition — not a rewrite.
