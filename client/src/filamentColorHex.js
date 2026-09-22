// Looks up a filament color's hex_color by name, from the flattened
// GET /api/filaments/colors list (one row per (color, type) pair: the same
// color name can appear more than once, always with the same hex_color, since
// it's one color entity now; see docs/filaments.md). Used wherever a printer's
// loaded_color needs a swatch, not just the Filament Library admin table.
export function buildColorHexMap(filamentColors) {
  const map = new Map();
  for (const c of filamentColors) {
    if (c.hex_color && !map.has(c.name)) map.set(c.name, c.hex_color);
  }
  return map;
}
