# Translating Print Farm Manager

The client is wired up with [react-i18next](https://react.i18next.com/). `client/src/locales/en.json`
is the source of truth for every user-facing string in the UI: it also doubles as the schema
that every other language file must match.

## Adding a new language

1. Copy `client/src/locales/en.json` to `client/src/locales/<code>.json` (e.g. `pl.json` for Polish),
   using the [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes) language code.
2. Translate the **values** only (never rename or remove a key), and keep any `{{placeholder}}`
   tokens and `<0>...</0>` tags exactly as they appear (they're interpolation and rich-text markup
   substituted at render time).
3. Register the language in `client/src/i18n.js`:
   - Import the JSON file at the top: `import pl from './locales/pl.json';`
   - Add it to `resources`: `pl: { translation: pl },`
   - Add an entry to `SUPPORTED_LANGUAGES`: `{ code: 'pl', label: 'Polski' }`
4. That's it: the language switcher in Settings picks it up automatically.

Note: `client/src/i18n.js` sets `load: 'languageOnly'`, so a detected region code (e.g. a browser
reporting `en-US`) is collapsed to its base code (`en`) before resolution. Register languages with
their base ISO 639-1 code only, region variants are never distinguished for translation purposes.

That collapsing is deliberately scoped to *translations* only. Date, time, and number formatting
(`toLocaleString`, `Intl.NumberFormat`, etc.) uses a separate formatting locale from
`getFormattingLocale()`/`useFormattingLocale()` in `client/src/i18n.js`, which keeps the browser's
regional variant (`en-GB`, `en-US`) when it matches the active translation language. Adding a
language affects both: the translated strings themselves, and, once an operator's browser regional
variant matches that language, the date/number formatting they see. See "Internationalization" in
`docs/web-app.md` for the full explanation.

## Key convention

Keys are `namespace.key`, kept flat (no more than two segments). Where a page has sub-sections,
the section name is folded into the key itself in camelCase (e.g. `settings.dispatchTitle`), not
nested a third level deep. Reuse `common.*` for words that repeat across many pages (buttons,
status words) instead of duplicating them per namespace.

## What not to translate

- Code identifiers, API field names, and URLs.
- Brand names (Prusa, Bambu, Elegoo, Klipper, OctoPrint, PayPal, …).
- Backend error messages: the server only replies in English for now.

## Pluralization

Keys that vary by count use i18next's plural suffixes, e.g. `jobCount_one` / `jobCount_other`.
Provide both forms; i18next picks the right one from the `count` value passed to `t()`.
