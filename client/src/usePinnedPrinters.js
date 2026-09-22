import { useState, useCallback } from 'react';

const STORAGE_KEY = 'fleet.pinnedPrinters';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (_) {
    return new Set();
  }
}

function save(set) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...set])); } catch (_) {}
}

// Per-browser, not per-account: pinning is a personal viewing preference for
// "which printers I want to see without scrolling," not farm state, so it
// deliberately isn't synced through the server the way printer data is.
export default function usePinnedPrinters() {
  const [pinnedIds, setPinnedIds] = useState(load);

  const togglePin = useCallback((printerId) => {
    setPinnedIds(prev => {
      const next = new Set(prev);
      next.has(printerId) ? next.delete(printerId) : next.add(printerId);
      save(next);
      return next;
    });
  }, []);

  return { pinnedIds, togglePin };
}
