// Pure helpers that derive what the operator sees from a printer or job row. Display only:
// none of these are ever written back to printers.status or jobs.status. Unit tested in
// client/tests/printer-status.test.js.

// A held printer that is waiting on a human to look at a finished, idle, or stopped machine.
// Dashboard, Printers, and the Fleet cards all use this one definition (it used to be
// copy-pasted, see CLAUDE.md). STOPPED is included: some printers (Bambu) latch the stopped
// state until the next print starts, with nothing to acknowledge on the printer screen, so
// confirming in the app is the only way out.
export function isAwaitingSignoff(printer) {
  return printer.is_held === 1
    && (printer.status === 'FINISHED' || printer.status === 'IDLE' || printer.status === 'STOPPED');
}

// The subset of awaiting printers Fleet lets an operator release in one click ("Set Ready (N)").
// This is deliberately narrower than isAwaitingSignoff:
//   - STOPPED is excluded. A stopped plate defaults to 0 good parts and crediting it must be an
//     explicit per-printer choice, and POST /api/printers/set-ready-batch only clears the hold:
//     it does not resolve the stopped job the way the single-printer set-ready does.
//   - A printer with an uploading job is excluded. It is handled by the separate upload
//     review queue, which keeps the three review lists disjoint.
export function isBatchReleasable(printer) {
  return printer.is_held === 1
    && (printer.status === 'FINISHED' || printer.status === 'IDLE')
    && printer.has_uploading_job === 0;
}

// What a Fleet card should say. The hardware still reports IDLE or FINISHED while the
// scheduler transfers a file, so a healthy in-flight upload displays as UPLOADING. A held
// printer with an uploading job is a FAILED upload: it keeps its hardware status so the
// existing confirmation flow renders unchanged, and it is never shown as UPLOADING while
// the printer itself reports PRINTING. Display only: never feeds back into printers.status.
export function displayPrinterStatus(p) {
  if (p.has_uploading_job === 1 && p.is_held === 0 && p.status !== 'PRINTING') return 'UPLOADING';
  return p.status;
}

// Jobs table. The printer can be held (awaiting operator sign-off) while the job row is still
// 'printing', for example when a printer goes PRINTING to IDLE directly between polls with no
// observable FINISHED or STOPPED tick. The scheduler correctly holds the printer but has
// nothing to resolve the job against yet, so the row stays 'printing' until Set Ready or Bad
// Print is used; meanwhile it is shown as 'awaiting'. Display only: never written back as
// jobs.status.
export function displayJobStatus(job) {
  if (job.status === 'printing' && job.printer_is_held === 1 && job.printer_status !== 'PRINTING') {
    return 'awaiting';
  }
  return job.status;
}

// Dashboard fleet grid: an awaiting printer is drawn with the FINISHED (green) colors
// regardless of its real status; everything else uses its own status.
export function dashboardCellStatus(printer) {
  return isAwaitingSignoff(printer) ? 'FINISHED' : printer.status;
}
