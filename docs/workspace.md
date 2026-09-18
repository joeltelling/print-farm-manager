# Workspace (board and notebook)

Operator scratch space inside CoMa: a single shared kanban board and a technical notebook. Neither path touches printers, `completed_qty`, or the scheduler. Data lives in the same SQLite file and is included in backup export/restore.

## Navigation

Third nav module **Workspace** (alongside ERP and Shopfloor):

| Screen | Route | API |
|---|---|---|
| Board | `/workspace` | `/api/workspace` |
| Notebook | `/workspace/bloc` | `/api/notebook` |

## Board

One shared board (no multi-board model). Columns and cards are editable.

Default columns (seeded only when `workspace_columns` is empty, including after the operator deletes every column):

| Title | Accent |
|---|---|
| To Do | amber |
| In Progress | violet |
| Review | cyan |
| Done | lime |

Accents: `lime`, `violet`, `cyan`, `amber`, `red`, `indigo`.

UI is CoMa-styled panels and cards (not a Trello chrome clone). Drag-and-drop uses native HTML5 DnD (same approach as project reorder on the Projects page). Card click opens a modal for title + notes (body).

## Notebook

Plain-text notes with soft delete (`trashed_at`). Dark graph-paper paper (lime grid on CoMa panel surfaces), accent swatches, autosave (~400 ms debounce), trash / restore / permanent delete, client-side `.txt` export and print.

Does not implement markdown, attachments, or multi-page notebook pagination.

## Hardware

Not applicable: no printer protocol or fleet I/O. Behavior is covered by route tests and backup round-trip tests only.
