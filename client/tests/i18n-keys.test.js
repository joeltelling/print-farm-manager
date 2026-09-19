import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');
const en = JSON.parse(readFileSync(path.join(SRC, 'locales', 'en.json'), 'utf8'));

// Every leaf key as a dotted path.
function leafPaths(node, prefix = '') {
  return Object.entries(node).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null ? leafPaths(v, p) : [p];
  });
}
const defined = new Set(leafPaths(en));

// i18next resolves a pluralized key like `foo` to `foo_one` / `foo_other` (and the other CLDR
// categories) at runtime, so a call site that says t('foo', { count }) is satisfied by those.
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
function isDefined(key) {
  return defined.has(key) || PLURAL_SUFFIXES.some((s) => defined.has(key + s));
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'locales' ? [] : sourceFiles(full);
    return /\.(jsx?|mjs)$/.test(name) ? [full] : [];
  });
}

// Static keys only. A dynamic key (a template literal with ${...}, or a variable) cannot be
// resolved by reading the source, so it is skipped rather than guessed at.
const PATTERNS = [
  /\bt\(\s*'([A-Za-z0-9_.]+)'/g,             // t('ns.key')
  /\bt\(\s*"([A-Za-z0-9_.]+)"/g,             // t("ns.key")
  /\bt\(\s*`([A-Za-z0-9_.]+)`/g,             // t(`ns.key`) with no interpolation
  /\bi18nKey=(?:\{\s*)?['"]([A-Za-z0-9_.]+)['"]/g, // <Trans i18nKey="ns.key" />
  /\b\w*Key\s*:\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g, // { labelKey: 'ns.key' } read as t(x.labelKey)
];

function keysUsedIn(file) {
  const text = readFileSync(file, 'utf8');
  const found = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) found.push(m[1]);
  }
  return found;
}

describe('translation keys used in client/src', () => {
  const files = sourceFiles(SRC);

  it('finds source files and keys to check (guards against the scan silently matching nothing)', () => {
    expect(files.length).toBeGreaterThan(10);
    const total = files.reduce((n, f) => n + keysUsedIn(f).length, 0);
    expect(total).toBeGreaterThan(300);
  });

  it('every static key exists in en.json', () => {
    const missing = [];
    for (const file of files) {
      for (const key of new Set(keysUsedIn(file))) {
        if (!isDefined(key)) missing.push(`${path.relative(SRC, file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
