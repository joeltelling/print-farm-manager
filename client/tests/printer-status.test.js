import { describe, it, expect } from 'vitest';
import {
  isAwaitingSignoff,
  isBatchReleasable,
  displayPrinterStatus,
  displayJobStatus,
  dashboardCellStatus,
} from '../src/lib/printer-status.js';

// Every canonical printer status (CLAUDE.md, docs/driver-authoring.md).
const ALL_STATUSES = ['IDLE', 'PRINTING', 'PAUSED', 'FINISHED', 'STOPPED', 'ERROR', 'OFFLINE', 'READY', 'UNKNOWN'];

const printer = (over = {}) => ({ is_held: 1, status: 'FINISHED', has_uploading_job: 0, has_active_job: 0, ...over });

describe('isAwaitingSignoff', () => {
  it.each(['FINISHED', 'IDLE', 'STOPPED'])('is true for a held %s printer', (status) => {
    expect(isAwaitingSignoff(printer({ status }))).toBe(true);
  });

  it.each(ALL_STATUSES.filter((s) => !['FINISHED', 'IDLE', 'STOPPED'].includes(s)))(
    'is false for a held %s printer (nothing to sign off yet)',
    (status) => {
      expect(isAwaitingSignoff(printer({ status }))).toBe(false);
    },
  );

  it.each(ALL_STATUSES)('is false for an unheld %s printer', (status) => {
    expect(isAwaitingSignoff(printer({ status, is_held: 0 }))).toBe(false);
  });

  it('only treats is_held === 1 as held', () => {
    expect(isAwaitingSignoff(printer({ is_held: true }))).toBe(false);
    expect(isAwaitingSignoff(printer({ is_held: '1' }))).toBe(false);
    expect(isAwaitingSignoff(printer({ is_held: undefined }))).toBe(false);
  });
});

describe('isBatchReleasable', () => {
  it.each(['FINISHED', 'IDLE'])('is true for a held %s printer with no uploading job', (status) => {
    expect(isBatchReleasable(printer({ status }))).toBe(true);
  });

  it('excludes STOPPED on purpose: a stopped plate must be confirmed per printer, with an explicit good-part count', () => {
    expect(isBatchReleasable(printer({ status: 'STOPPED' }))).toBe(false);
    // ...even though the same printer is awaiting sign-off and shows its own confirm button.
    expect(isAwaitingSignoff(printer({ status: 'STOPPED' }))).toBe(true);
  });

  it('excludes a printer with an uploading job (it belongs to the upload review queue)', () => {
    expect(isBatchReleasable(printer({ has_uploading_job: 1 }))).toBe(false);
    expect(isBatchReleasable(printer({ has_uploading_job: undefined }))).toBe(false);
  });

  it('excludes unheld printers', () => {
    expect(isBatchReleasable(printer({ is_held: 0 }))).toBe(false);
  });

  it.each(ALL_STATUSES)('never releases a %s printer that is not awaiting sign-off (subset invariant)', (status) => {
    for (const is_held of [0, 1]) {
      for (const has_uploading_job of [0, 1]) {
        const p = printer({ status, is_held, has_uploading_job });
        if (isBatchReleasable(p)) expect(isAwaitingSignoff(p)).toBe(true);
      }
    }
  });
});

describe('displayPrinterStatus', () => {
  it('shows UPLOADING for an unheld printer mid-upload that the hardware does not report as printing', () => {
    expect(displayPrinterStatus({ status: 'IDLE', is_held: 0, has_uploading_job: 1 })).toBe('UPLOADING');
    expect(displayPrinterStatus({ status: 'FINISHED', is_held: 0, has_uploading_job: 1 })).toBe('UPLOADING');
  });

  it('keeps the hardware status for a held printer with an uploading job (a failed upload)', () => {
    expect(displayPrinterStatus({ status: 'IDLE', is_held: 1, has_uploading_job: 1 })).toBe('IDLE');
  });

  it('keeps PRINTING once the printer itself reports it', () => {
    expect(displayPrinterStatus({ status: 'PRINTING', is_held: 0, has_uploading_job: 1 })).toBe('PRINTING');
  });

  it('passes the status through when there is no uploading job', () => {
    for (const status of ALL_STATUSES) {
      expect(displayPrinterStatus({ status, is_held: 0, has_uploading_job: 0 })).toBe(status);
    }
  });
});

describe('displayJobStatus', () => {
  it("shows 'awaiting' for a printing job whose printer is held and no longer PRINTING", () => {
    expect(displayJobStatus({ status: 'printing', printer_is_held: 1, printer_status: 'IDLE' })).toBe('awaiting');
    expect(displayJobStatus({ status: 'printing', printer_is_held: 1, printer_status: 'OFFLINE' })).toBe('awaiting');
  });

  it('leaves a printing job alone while the printer is still PRINTING or not held', () => {
    expect(displayJobStatus({ status: 'printing', printer_is_held: 1, printer_status: 'PRINTING' })).toBe('printing');
    expect(displayJobStatus({ status: 'printing', printer_is_held: 0, printer_status: 'IDLE' })).toBe('printing');
  });

  it("never rewrites any status other than 'printing'", () => {
    for (const status of ['queued', 'uploading', 'finished', 'failed', 'cancelled']) {
      expect(displayJobStatus({ status, printer_is_held: 1, printer_status: 'IDLE' })).toBe(status);
    }
  });
});

describe('dashboardCellStatus', () => {
  it('draws an awaiting printer as FINISHED whatever its real status', () => {
    for (const status of ['FINISHED', 'IDLE', 'STOPPED']) {
      expect(dashboardCellStatus(printer({ status }))).toBe('FINISHED');
    }
  });

  it('uses the real status for everything else', () => {
    expect(dashboardCellStatus(printer({ status: 'PRINTING' }))).toBe('PRINTING');
    expect(dashboardCellStatus(printer({ status: 'STOPPED', is_held: 0 }))).toBe('STOPPED');
    expect(dashboardCellStatus(printer({ status: 'OFFLINE' }))).toBe('OFFLINE');
  });
});
