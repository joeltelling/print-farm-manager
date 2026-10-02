// Cross-page signal that the forward schedule's inputs just changed.
//
// The Schedule page also polls a server-side fingerprint, so it will notice any change on
// its own within a few seconds. This event exists to make the common case immediate: when
// an operator edits a print-time estimate and switches to the Schedule tab, the page should
// already be recalculating rather than showing numbers computed from the old estimate.
//
// Window CustomEvent rather than shared state, following the farmNameChanged pattern in
// App.jsx: this client has no providers, no context, and no state library.

export const SCHEDULE_DIRTY_EVENT = 'scheduleDirty';

export function signalScheduleDirty() {
  window.dispatchEvent(new CustomEvent(SCHEDULE_DIRTY_EVENT));
}
