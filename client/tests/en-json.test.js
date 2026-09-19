import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const EN_PATH = path.join(here, '..', 'src', 'locales', 'en.json');
const en = JSON.parse(readFileSync(EN_PATH, 'utf8'));

// Every string leaf as [dotted.path, value].
function leaves(node, prefix = '') {
  return Object.entries(node).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null ? leaves(v, p) : [[p, v]];
  });
}

const all = leaves(en);

describe('client/src/locales/en.json', () => {
  it('has only string values', () => {
    const bad = all.filter(([, v]) => typeof v !== 'string').map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('has no empty or whitespace-only values', () => {
    const empty = all.filter(([, v]) => typeof v === 'string' && v.trim() === '').map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it('contains no em or en dashes (CLAUDE.md: no dashes in UI strings)', () => {
    const dashed = all.filter(([, v]) => /[\u2013\u2014]/.test(v)).map(([k]) => k);
    expect(dashed).toEqual([]);
  });

  it('has balanced Trans component tags in every value', () => {
    const unbalanced = all
      .filter(([, v]) => typeof v === 'string')
      .filter(([, v]) => {
        const opens = [...v.matchAll(/<(\d+)>/g)].map((m) => m[1]).sort();
        const closes = [...v.matchAll(/<\/(\d+)>/g)].map((m) => m[1]).sort();
        return JSON.stringify(opens) !== JSON.stringify(closes);
      })
      .map(([k]) => k);
    expect(unbalanced).toEqual([]);
  });

  it('gives every plural base key both an _one and an _other form', () => {
    const keys = new Set(all.map(([k]) => k));
    const missing = [];
    for (const k of keys) {
      const m = k.match(/^(.*)_(one|other)$/);
      if (!m) continue;
      const pair = m[2] === 'one' ? `${m[1]}_other` : `${m[1]}_one`;
      if (!keys.has(pair)) missing.push(`${k} has no ${pair}`);
    }
    expect(missing).toEqual([]);
  });
});
