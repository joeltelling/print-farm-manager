# Filament Library

Administrator-managed canonical lists of filament types and filament colors. These lists are the single source of truth for what materials and colors exist in the farm; printers and G-codes select from them rather than entering free text.

## Tables

### `filament_types`

| Column | Type    | Notes |
|--------|---------|-------|
| `id`   | INTEGER | PK, autoincrement |
| `name` | TEXT    | Unique, e.g. "PLA", "PETG", "ASA" |

### `filament_colors`

| Column      | Type    | Notes |
|-------------|---------|-------|
| `id`        | INTEGER | PK, autoincrement |
| `name`      | TEXT    | Unique across the whole library, e.g. "Black", "Galaxy Red". A color is a single entity now, not one row per type: see `filament_color_types` below. |
| `hex_color` | TEXT    | Optional hex code, e.g. "#FF0000". Shown as a color swatch in the Settings table. |

### `filament_color_types`

A many-to-many join: which type(s) a color applies to. Added so "Black" (for example) is one entry usable for PLA, PETG, and ASA alike, instead of a separate "Black" row per material.

| Column     | Type    | Notes |
|------------|---------|-------|
| `color_id` | INTEGER | FK → `filament_colors.id` |
| `type_id`  | INTEGER | FK → `filament_types.id` |

`PRIMARY KEY (color_id, type_id)`. A color must have at least one row here; the API refuses to create or update a color into having zero types.

**Migration note:** installs from before this table existed had `filament_colors.type_id NOT NULL` with `UNIQUE(type_id, name)` (a genuinely separate row per type). `server/db.js` migrates automatically on first start after updating: colors sharing the same name collapse into one row (the first non-null `hex_color` found wins), and every old `(color, type)` pair becomes a `filament_color_types` row, so nothing already entered is lost, only de-duplicated by name.

## API Endpoints: `server/routes/filaments.js`

All endpoints are mounted at `/api/filaments`.

### `GET /api/filaments/types`
Returns all filament types ordered by name.
```json
[{ "id": 1, "name": "PLA" }, { "id": 2, "name": "PETG" }]
```

### `POST /api/filaments/types`
Add a new filament type.
- Body: `{ "name": "ASA" }`
- Returns: the created row (201)
- Errors: 400 if name missing, 409 if name already exists

### `DELETE /api/filaments/types/:id`
Remove a filament type by ID.
- Blocked (409) if any color is still linked to this type via `filament_color_types`; remove the type from those colors first (or delete the colors).
- Returns 404 if not found.

### `GET /api/filaments/colors`
Returns one row per (color, type) pair, unchanged in shape from before `filament_color_types` existed, so every existing "colors available for material X" picker in the client works with zero changes. A color linked to two types appears twice here, once per type.
```json
[
  { "id": 1, "name": "Black", "hex_color": "#000000", "type_id": 1, "type_name": "PLA" },
  { "id": 1, "name": "Black", "hex_color": "#000000", "type_id": 2, "type_name": "PETG" }
]
```

### `GET /api/filaments/colors/grouped`
Returns one row per color, with every linked type nested as an array. Used only by the Settings admin table, where a color's full type list is displayed and edited in one place.
```json
[{ "id": 1, "name": "Black", "hex_color": "#000000", "types": [{ "id": 1, "name": "PLA" }, { "id": 2, "name": "PETG" }] }]
```

### `POST /api/filaments/colors`
Create a new color with its initial set of types.
- Body: `{ "name": "Galaxy Red", "hex_color": "#C0392B", "type_ids": [1, 2] }`, `hex_color` is optional, `type_ids` requires at least one id and every id must exist.
- Returns: the created color with its `types` array (201)
- Errors: 400 if name or type_ids missing/empty, or a type_id doesn't exist; 409 if the name already exists (edit the existing color instead of creating a duplicate)

### `PUT /api/filaments/colors/:id`
Partial update. `name`/`hex_color` use the usual COALESCE (omitted fields unchanged). If `type_ids` is present in the body, it **replaces** the color's full type list (the same replace-the-whole-set convention `gcodes.allowed_groups` uses), not a merge: send every type the color should still have, not just the ones being added.
- Body: `{ "type_ids": [1, 3] }` (name/hex_color omitted here, so unchanged)
- Returns: the updated color with its `types` array
- Errors: 404 if not found, 400 if `type_ids` is present but empty or contains an unknown id, 409 on a name collision

### `DELETE /api/filaments/colors/:id`
Remove a filament color by ID (also removes its `filament_color_types` rows). Not blocked by anything referencing it, same non-blocking behavior as before.

## Where filament data is used

| Location | Field | Meaning |
|----------|-------|---------|
| `printers.loaded_material` | type name | What material is currently loaded on the printer |
| `printers.loaded_color` | color name | What color is currently loaded on the printer |
| `gcodes.required_material` | type name | Material required to print this G-code |
| `gcodes.required_color` | color name | Color required to print this G-code |

The scheduler uses `required_material` and `required_color` to match G-codes to printers with matching `loaded_material` / `loaded_color`. None of this matching logic changed: it still compares plain type/color name strings, unaware that a color can now list more than one type.

## Settings UI

The **Filament Library** section in Settings has two sub-sections:

**Filament Types**: table of all types with delete buttons; add form with a required name field.

**Filament Colors**: table of all colors (hex swatch, name, and a comma-separated list of its types), with delete buttons. Clicking the types cell opens an inline checkbox list of every filament type; check/uncheck and Save to change which types that color applies to, without recreating it. The add-color form has its own checkbox list (at least one type required to submit) alongside the name and optional hex picker.

## Client usage

All client pages that show material/color pickers (Settings add-printer form, Printers bulk edit, PrinterDetail edit form, Projects G-code upload and edit) fetch from `/api/filaments/types` and `/api/filaments/colors` (the flattened, one-row-per-type shape) and render `<select>` dropdowns rather than free-text `<input>` elements, filtering colors by `type_name` exactly as before. Only the Settings Filament Library admin table itself uses the new `/api/filaments/colors/grouped` shape.
