// Shapes a printer DB row for API responses. The stored api_key (PrusaLink key, Bambu
// access code, OctoPrint key) is a reusable credential for the printer itself, so it is
// never sent to clients. Callers get has_api_key instead so the UI can show whether a
// key is set without exposing it.
function publicPrinter(row) {
  if (!row || typeof row !== 'object') return row;
  const { api_key, ...rest } = row;
  return { ...rest, has_api_key: api_key != null && String(api_key) !== '' };
}

module.exports = { publicPrinter };
