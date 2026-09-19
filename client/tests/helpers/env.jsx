// Shared setup for the DOM tests (files that start with `// @vitest-environment happy-dom`).
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import i18n from '../../src/i18n.js';

// Real English strings, straight from en.json, so tests assert what an operator reads.
export { i18n };
// Throws on an unknown key. i18next would return the key itself, and a test would then go
// looking for that literal text and fail with a confusing "element not found".
export const t = (key, opts) => {
  if (!i18n.exists(key, opts)) throw new Error(`Unknown translation key in test: ${key}`);
  return i18n.t(key, opts);
};

// Unmount everything and restore globals after each test. Call once at the top of a test file.
export function installDomCleanup() {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    window.history.replaceState({}, '', '/');
    window.localStorage.clear();
  });
}

const originalFetch = globalThis.fetch;

function compile(pattern) {
  // 'GET /api/printers/:id/events' -> a RegExp. :name matches one path segment.
  const [method, path] = pattern.split(' ');
  const source = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+');
  return { method, re: new RegExp(`^${source}$`) };
}

// Replaces global fetch with a router over `routes`: { 'GET /api/x': body | (url, init) => body }.
// A route value can also be { status, body }. Any request that matches no route is recorded in
// `unmocked` and answered 404, so a test can assert that a page asked for nothing unexpected.
export function mockApi(routes) {
  const compiled = Object.entries(routes).map(([pattern, handler]) => ({ ...compile(pattern), handler }));
  const calls = [];
  const unmocked = [];

  const impl = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://localhost');
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, path: url.pathname, search: url.search, url: `${url.pathname}${url.search}` });
    const hit = compiled.find((c) => c.method === method && c.re.test(url.pathname));
    if (!hit) {
      unmocked.push(`${method} ${url.pathname}${url.search}`);
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'unmocked in test' }) });
    }
    const out = typeof hit.handler === 'function' ? hit.handler(url, init) : hit.handler;
    const { status = 200, body } = out && typeof out === 'object' && 'body' in out ? out : { body: out };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => structuredClone(body),
      text: async () => JSON.stringify(body),
    });
  };

  globalThis.fetch = vi.fn(impl);
  return { calls, unmocked, fetch: globalThis.fetch };
}

// Fails a test if the page logged an error to the console (React key warnings, thrown render
// errors caught by React, failed prop types). React's own act() warnings are ignored: they
// are about how a test awaits state updates, not about the page.
export function watchConsoleErrors() {
  const seen = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    const text = args.map(String).join(' ');
    if (/not wrapped in act|inside a test was not stubbed/.test(text)) return;
    seen.push(text.slice(0, 300));
  });
  return seen;
}
