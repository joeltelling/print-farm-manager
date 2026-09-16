# ERP architecture (CoMa / core-manufacturing)

This document records the placement decision for the production ERP inside this repository. It is the product-level plan. Implementation of BOM, inventory ledgers, costing, and invoices comes later. The UI already reserves an **ERP** nav section and an `/erp` placeholder page.

## Product shape

`core-manufacturing` is **ERP-first**. The existing Print Farm Manager code (poller, scheduler, Fleet, Projects, Jobs) is the first **shopfloor connector**: machine type `3d_printer`.

Future machine types (laser, plotter, and others) are added by development, one connector at a time. They do not plug in autonomously: each type has different job files, status models, and operator flows.

```
ERP (definition + money)
  articles, BOM / recipes, cost drivers, inventory, production orders, invoices
        |
        | production order releases work
        v
Shopfloor connectors (execution)
  3d_printer (current CoMa farm) | laser (future) | plotter (future)
        |
        | units_completed (after operator confirmation)
        v
ERP inventory + cost accumulation + invoicing inputs
```

## Domain boundary (non-negotiable)

| Domain | Owner | Owns |
|---|---|---|
| Definition and money | ERP | SKU / article, BOM lines (qty or %), bought parts, packaging (box, protectors), shipping, advertising %, sales-platform %, electricity €/h, plastic €/kg, manufacturing time, stock ledger, invoices |
| Machine execution | Shopfloor | printer/machine status, dispatch, G-code (or type-specific job files), holds, Set Ready, farm `parts.completed_qty` |
| Bridge | Typed events | OP creates or updates farm Projects/Parts; shopfloor emits `units_completed` only after a real confirmed outcome; ERP posts inventory and rolls cost |

Rules:

- The farm **does not** compute margins or issue invoices.
- The ERP **does not** speak MQTT, Moonraker, PrusaLink, or SDCP.
- Do **not** add advertising %, IVA, stock, or invoice columns onto `parts` / `projects`.
- Do **not** let `scheduler.js` write inventory or `invoice_lines`.
- Farm backup/restore stays fleet-only. ERP backup is a separate domain when it exists.

## Why not inside the current farm schema

The farm SQLite schema and scheduler exist to run a print fleet safely. `parts.completed_qty` is sacred: every increment must map to one real-world event and must not double-fire across restarts. Mixing invoices, stock ledgers, and multi-machine costing into that same schema would blur the boundary and make a later real production ERP harder to attach.

Short term the ERP may share the same Node process and UI shell. It must still use a **separate logical schema** (planned: `data/erp.sqlite` or equivalent), never the printers/jobs tables.

## Planned ERP concepts (not built yet)

- **Article (SKU):** `raw` | `buy` | `make` | `packaging` | `service`
- **BOM / recipe:** lines with quantity or percentage (material share, advertising, platform fee, scrap)
- **Cost drivers:** €/h electricity, €/kg material, manufacturing time, shipping, packaging
- **Inventory ledger:** movements only (no silent stock edits), same philosophy as farm part counts
- **Production order (OP):** target qty for a `make` article; releasing it creates shopfloor work
- **Invoice:** commercial document with numbering and PDF; independent of any single printer job

Estimated unit cost = sum of recipe drivers. That math lives in the ERP, not in Fleet or Projects.

## Machine types

Follow the spirit of [driver-authoring.md](../driver-authoring.md): a documented contract, then one implementation per type.

- ERP only sees `machine_type`, `capabilities[]`, and progress/completion events.
- `3d_printer` is today's drivers under `server/drivers/` plus poller/scheduler.
- Laser / plotter / etc. are separate deliverables when needed.

## Repo evolution (later)

When the ERP has real screens and APIs:

```
core-manufacturing/
  apps/erp/              # ERP API + UI
  apps/shopfloor-3d/     # current server/ + client farm surfaces
  packages/machine-contract/
  docs/erp/              # this folder
```

Until then: keep the farm tree where it is, document here, and expose the ERP entry in the shell nav only.

## Bridge event (documented stub)

Intended event (not wired yet):

- Name: `shopfloor.units_completed`
- Fired when: operator confirms a good outcome (e.g. Set Ready with confirmed qty), never from a heuristic time window
- Payload (sketch): `{ op_id?, article_id?, qty, machine_type, shopfloor_job_ref, at }`
- ERP handler: inventory receipt for `make` articles, cost accumulation; no-op until ledgers exist

## UI today

- Nav sections: **ERP** and **Shopfloor**, plus Settings
- Route `/erp`: placeholder describing this plan
- Shopfloor routes unchanged: Dashboard, Fleet, Printers, Projects, Jobs

## Out of scope for the architecture doc phase

- ERP routes under `/api/erp`
- `erp.sqlite` and migrations
- Real BOM / costing / invoice UI
- Moving folders into `apps/`
