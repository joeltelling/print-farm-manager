import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import PollTimer from '../components/PollTimer';
import EmptyState from '../components/EmptyState';
import { useConfirm } from '../useConfirm';
import { useToast } from '../useToast';

const STATUS_COLORS = {
  PRINTING:   { bg: '#1e3a5f', text: '#60a5fa', labelKey: 'common.statusPrinting' },
  UPLOADING:  { bg: '#3b2c69', text: '#a78bfa', labelKey: 'common.statusUploading' },
  IDLE:       { bg: '#1f2937', text: '#6b7280', labelKey: 'common.statusIdle' },
  READY:      { bg: '#1f2937', text: '#94a3b8', labelKey: 'common.statusReady' },
  FINISHED:   { bg: '#14532d', text: '#86efac', labelKey: 'common.statusFinished' },
  STOPPED:    { bg: '#431407', text: '#fb923c', labelKey: 'common.statusStopped' },
  PAUSED:     { bg: '#78350f', text: '#fbbf24', labelKey: 'common.statusPaused' },
  ATTENTION:  { bg: '#78350f', text: '#fbbf24', labelKey: 'common.statusAttention' },
  ERROR:      { bg: '#7f1d1d', text: '#f87171', labelKey: 'common.statusError' },
  OFFLINE:    { bg: '#1f2937', text: '#6b7280', labelKey: 'common.statusOffline' },
  UNKNOWN:    { bg: '#1f2937', text: '#9ca3af', labelKey: 'common.statusUnknown' },
};

const KNOWN_STATUSES = new Set(Object.keys(STATUS_COLORS));

// Mirrors Jobs.jsx's JOB_STATUS labelKey mapping, same job status codes, same keys.
// 'done' is a legacy alias for 'finished' (see DONE_STATUSES in server/routes/dashboard.js).
const JOB_STATUS_LABEL_KEYS = {
  queued:    'jobs.statusQueued',
  uploading: 'common.statusUploading',
  printing:  'common.statusPrinting',
  finished:  'common.statusFinished',
  done:      'common.statusFinished',
  failed:    'jobs.statusFailed',
  cancelled: 'jobs.statusCancelled',
};

function statusStyle(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.UNKNOWN;
}

// What the card should say. The hardware still reports IDLE/FINISHED while the
// scheduler transfers a file, so a healthy in-flight upload displays as UPLOADING.
// Held + uploading is a FAILED upload — that keeps its hardware status so the
// existing confirmation flow renders unchanged. This is display-only; it never
// feeds back into printers.status.
function displayStatus(p) {
  if (p.has_uploading_job === 1 && p.is_held === 0 && p.status !== 'PRINTING') return 'UPLOADING';
  return p.status;
}

function formatTimeRemaining(t, secs) {
  if (secs == null || secs < 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return t('fleet.timeRemainingHm', { h, m });
  if (m > 0) return t('fleet.timeRemainingM', { m });
  return t('fleet.timeRemainingLessThanMin');
}

// Wall-clock finish time — "done 3:45 PM", with a day marker if it rolls past midnight
function formatEta(t, secs, language) {
  if (secs == null || secs < 0) return null;
  const eta = new Date(Date.now() + secs * 1000);
  const time = eta.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((eta - new Date(new Date().setHours(0, 0, 0, 0))) / 86400000);
  if (days === 1) return t('fleet.etaTomorrow', { time });
  if (days > 1) return t('fleet.etaDay', { day: eta.toLocaleDateString(language, { weekday: 'short' }), time });
  return t('fleet.etaToday', { time });
}

function PrinterCard({ printer, selected, onToggleSelect, onSetReady, onBadPrint, onUploadFailed, onDecommission, onLinkJob, onOpenDetail }) {
  const { t, i18n } = useTranslation();
  // resolvedLanguage (not language) so the ETA time matches whatever language is actually
  // rendered, not a detected-but-unregistered browser locale (see i18n.js).
  const language = i18n.resolvedLanguage || i18n.language || 'en';
  const shownStatus = displayStatus(printer);
  const style = statusStyle(shownStatus);
  const isUploading = shownStatus === 'UPLOADING';

  // Confirmed-qty input — pre-filled from the last finished job's parts_per_plate.
  // Only shown when is_held and we know how many parts were on the plate.
  // STOPPED means the operator deliberately stopped the print mid-way, so the safe
  // default is 0 good parts — crediting a stopped plate must be an explicit choice.
  const [confirmedQty, setConfirmedQty] = useState(
    printer.status === 'STOPPED' ? '0'
      : printer.last_parts_per_plate != null ? String(printer.last_parts_per_plate) : ''
  );
  useEffect(() => {
    if (printer.status === 'STOPPED') {
      setConfirmedQty('0');
    } else if (printer.last_parts_per_plate != null) {
      setConfirmedQty(String(printer.last_parts_per_plate));
    }
  }, [printer.last_parts_per_plate, printer.status]);

  // Partial failure — operator has reduced the good-qty below the full plate count.
  // Batch set-ready credits full parts_per_plate, so this printer must be confirmed
  // individually. Auto-remove from the batch selection if it was already checked.
  const isPartial = printer.last_parts_per_plate != null
    && !isNaN(parseInt(confirmedQty, 10))
    && parseInt(confirmedQty, 10) < printer.last_parts_per_plate;
  useEffect(() => {
    if (isPartial && selected) onToggleSelect(printer.id);
  }, [isPartial]); // eslint-disable-line react-hooks/exhaustive-deps
  // Show confirmation buttons only when there's something to inspect.
  // A printer that is actively printing is held-in-advance — it will need sign-off
  // when it finishes, but there is nothing to confirm right now.
  // STOPPED is included: some printers (Bambu) latch the stopped state until the next
  // print starts, with nothing to acknowledge on the printer screen — the only way out
  // is confirming here so the farm dispatches a new job.
  const needsConfirmation = printer.is_held === 1
    && (printer.status === 'FINISHED' || printer.status === 'IDLE' || printer.status === 'STOPPED');
  // OFFLINE with an active job: printer dropped off network but job may still be running.
  // Operator can confirm the job is OK (green = resume) or declare it failed (red).
  // If the printer comes back PRINTING on its own, the hold is released automatically.
  const needsOfflineConfirmation = printer.is_held === 1 && printer.status === 'OFFLINE' && printer.has_active_job === 1;
  // Upload stalled: all retries exhausted but printer is not confirmed printing or idle.
  // Operator must check the machine and confirm whether the print is running or not.
  const needsUploadConfirmation = printer.is_held === 1 && printer.has_uploading_job === 1 && printer.status !== 'OFFLINE';
  const isPrinting = printer.status === 'PRINTING';
  const pct = isPrinting && printer.job_progress != null ? Math.round(printer.job_progress) : null;
  const timeLeft = isPrinting ? formatTimeRemaining(t, printer.job_time_remaining) : null;
  const eta      = isPrinting ? formatEta(t, printer.job_time_remaining, language) : null;

  function cardBorder() {
    if (needsOfflineConfirmation || needsUploadConfirmation) return '#92400e';
    if (needsConfirmation) return selected ? '#22c55e' : '#15803d';
    return style.bg;
  }

  return (
    <div
      onClick={(needsConfirmation && !needsUploadConfirmation) ? () => onToggleSelect(printer.id) : () => onOpenDetail(printer.id)}
      title={(needsConfirmation && !needsUploadConfirmation) ? (selected ? t('fleet.clickToDeselect') : t('fleet.clickToSelectBatch')) : t('fleet.clickToOpenDetails')}
      style={{
        background: (needsOfflineConfirmation || needsUploadConfirmation) ? '#2a1f0e' : needsConfirmation ? '#1c2a1c' : '#1e2433',
        border: `${selected ? '2px' : '1px'} solid ${cardBorder()}`,
        borderRadius: 8,
        padding: selected ? '11px 13px' : '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
        cursor: 'pointer',
      }}
    >
      {/* Name + status badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {printer.name}
        </span>
        <span style={{ background: style.bg, color: style.text, borderRadius: 4, padding: '2px 8px', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
          {t(style.labelKey)}
        </span>
      </div>

      {/* Model + group */}
      <div style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ background: '#0f172a', borderRadius: 3, padding: '1px 6px', fontFamily: 'monospace', color: '#64748b' }}>
          {printer.model}
        </span>
        {printer.group_name && <span style={{ color: '#475569' }}>{printer.group_name}</span>}
        {(printer.loaded_material || printer.loaded_color) && (
          <span style={{ color: '#7dd3fc', fontSize: 11 }}>
            {[printer.loaded_material, printer.loaded_color].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      {/* Upload in progress — file is being transferred to the printer */}
      {isUploading && (
        <div style={{ marginTop: 2 }}>
          {printer.uploading_job_name && (
            <div style={{
              fontSize: 11, color: '#94a3b8', fontFamily: 'monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              marginBottom: 5,
            }}>
              {printer.uploading_job_name}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#a78bfa' }}>
            {t('fleet.sendingFile')}
          </div>
        </div>
      )}

      {/* Print job info — only when printing */}
      {isPrinting && (
        <div style={{ marginTop: 2 }}>
          {printer.job_name && (
            <div style={{
              fontSize: 11, color: '#94a3b8', fontFamily: 'monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              marginBottom: 5,
            }}>
              {printer.job_name}
            </div>
          )}
          <div style={{ background: '#0f172a', borderRadius: 3, height: 8, overflow: 'hidden', marginBottom: 4 }}>
            <div style={{
              background: '#3b82f6',
              height: '100%',
              width: `${pct ?? 0}%`,
              borderRadius: 3,
              transition: 'width 0.5s',
            }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#475569' }}>
            <span>{pct != null ? `${pct}%` : '—'}</span>
            {timeLeft && (
              <span>
                {timeLeft}
                {eta && <span style={{ color: '#64748b' }}> · {eta}</span>}
              </span>
            )}
          </div>
        </div>
      )}

      {printer.status === 'STOPPED' && (
        <div style={{ fontSize: 11, color: '#fb923c', marginTop: 4 }}>
          {needsConfirmation
            ? t('fleet.stoppedConfirmPending')
            : t('fleet.stoppedReturnsToService')}
        </div>
      )}

      {needsConfirmation && !needsUploadConfirmation && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          {printer.last_parts_per_plate != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: '#64748b' }}>{t('fleet.goodLabel')}</span>
              <input
                type="number"
                min={0}
                max={printer.last_parts_per_plate}
                value={confirmedQty}
                onChange={e => setConfirmedQty(e.target.value)}
                style={{
                  width: 46, background: '#0f172a', border: '1px solid #2d3748',
                  borderRadius: 3, padding: '2px 5px', color: '#e2e8f0', fontSize: 12,
                  textAlign: 'center',
                }}
              />
              <span style={{ fontSize: 11, color: '#475569' }}>/ {printer.last_parts_per_plate}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => onSetReady(printer.id, printer.last_parts_per_plate != null ? parseInt(confirmedQty, 10) : null)}
              title={t('fleet.setReadyTitle')}
              style={{ flex: 1, background: '#166534', color: '#4ade80', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              ✓ {t('fleet.setReady')}
            </button>
            <button
              onClick={() => onBadPrint(printer.id)}
              title={t('fleet.badPrintTitle')}
              style={{ flex: 1, background: '#7f1d1d', color: '#f87171', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              ✗ {t('fleet.badPrint')}
            </button>
          </div>
        </div>
      )}

      {needsOfflineConfirmation && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 6 }}>
            {t('fleet.offlineWentOffline')}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => onSetReady(printer.id, null)}
              style={{ flex: 1, background: '#166534', color: '#4ade80', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              ✓ {t('fleet.jobOk')}
            </button>
            <button
              onClick={() => onBadPrint(printer.id)}
              style={{ flex: 1, background: '#7f1d1d', color: '#f87171', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              ✗ {t('fleet.jobFailed')}
            </button>
          </div>
        </div>
      )}

      {needsUploadConfirmation && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 6 }}>
            {(printer.status === 'FINISHED' || printer.status === 'IDLE')
              ? t('fleet.uploadFailedButComplete')
              : t('fleet.uploadFailedCheckPrinter')}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => (printer.status === 'FINISHED' || printer.status === 'IDLE')
                ? onSetReady(printer.id, null)
                : onLinkJob(printer.id, true)}
              style={{ flex: 1, background: '#166534', color: '#4ade80', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              {(printer.status === 'FINISHED' || printer.status === 'IDLE') ? `✓ ${t('fleet.setReady')}` : `✓ ${t('fleet.jobRunning')}`}
            </button>
            <button
              onClick={() => onUploadFailed(printer.id)}
              style={{ flex: 1, background: '#7f1d1d', color: '#f87171', border: 'none', borderRadius: 6, padding: '5px 0', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              ✗ {t('fleet.uploadFailedBtn')}
            </button>
          </div>
        </div>
      )}

      {isPrinting && printer.has_printing_job === 0 && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 2 }}>
          <button
            onClick={() => onLinkJob(printer.id, false)}
            title={t('fleet.linkJobTitle')}
            style={{ background: 'none', color: '#60a5fa', border: '1px solid #1e3a5f', borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
          >
            {t('fleet.linkJob')}
          </button>
        </div>
      )}

      {!isPrinting && (
        <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 2 }}>
          <button onClick={() => onDecommission(printer.id, (needsConfirmation && printer.last_parts_per_plate != null) ? parseInt(confirmedQty, 10) : null)} style={{ background: 'none', color: '#475569', border: '1px solid #2d3748', borderRadius: 6, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}>
            {t('fleet.decommission')}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Fleet() {
  const { t }                                 = useTranslation();
  const navigate                              = useNavigate();
  const [confirm, confirmModal]               = useConfirm();
  const [showToast, toastEl]                  = useToast();
  const [printers, setPrinters]               = useState([]);
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState(null);
  const [filter, setFilter]                   = useState('ALL');
  const [search, setSearch]                   = useState('');
  const [selectedForReady, setSelectedForReady] = useState(new Set());
  const [lastPolled, setLastPolled]           = useState(null);
  const [allModels, setAllModels]             = useState([]);
  // { printerId, printerName, jobs, selectedJobId, isHeld }
  const [linkJobModal, setLinkJobModal]       = useState(null);

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setAllModels).catch(() => {});
  }, []);

  const fetchPrinters = useCallback(async () => {
    try {
      const res = await fetch('/api/printers');
      if (!res.ok) throw new Error(t('fleet.fetchFailed'));
      const data = await res.json();
      setPrinters(data);
      setLastPolled(Date.now());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrinters();
    const interval = setInterval(fetchPrinters, 15000);
    return () => clearInterval(interval);
  }, [fetchPrinters]);

  // Printers awaiting operator confirmation — excludes those currently printing (hold is pre-set for when they finish)
  const awaitingConfirmation = printers.filter(p => p.is_held === 1 && (p.status === 'FINISHED' || p.status === 'IDLE') && p.has_uploading_job === 0);
  const awaitingOfflineReview = printers.filter(p => p.is_held === 1 && p.status === 'OFFLINE' && p.has_active_job === 1);
  const awaitingUploadReview = printers.filter(p => p.is_held === 1 && p.has_uploading_job === 1 && p.status !== 'OFFLINE');

  function toggleSelect(printerId) {
    setSelectedForReady(prev => {
      const next = new Set(prev);
      next.has(printerId) ? next.delete(printerId) : next.add(printerId);
      return next;
    });
  }

  function selectAll() {
    setSelectedForReady(new Set(awaitingConfirmation.map(p => p.id)));
  }

  function deselectAll() {
    setSelectedForReady(new Set());
  }

  async function setReady(printerId, confirmedQty) {
    const res = await fetch(`/api/printers/${printerId}/set-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmedQty != null ? { confirmed_qty: confirmedQty } : {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(t('fleet.setReadyFailed', { reason: body.error || res.status }), 'error');
      return;
    }
    setSelectedForReady(prev => { const next = new Set(prev); next.delete(printerId); return next; });
    fetchPrinters();
  }

  async function setReadyForSelected() {
    const res = await fetch('/api/printers/set-ready-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedForReady] }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(t('fleet.batchSetReadyFailed', { reason: body.error || res.status }), 'error');
      return;
    }
    setSelectedForReady(new Set());
    fetchPrinters();
  }

  async function openLinkJobModal(printerId, isHeld) {
    const printer = printers.find(p => p.id === printerId);
    const res = await fetch(`/api/printers/${printerId}/linkable-jobs`);
    const jobs = await res.json();

    // Pre-select this printer's own stalled uploading job if present, otherwise
    // fall back to the only candidate if there's just one.
    const ownStalled = jobs.find(j => j.original_printer_id === printerId && j.status === 'uploading');
    const preselect = ownStalled ? ownStalled.id : (jobs.length === 1 ? jobs[0].id : null);

    setLinkJobModal({
      printerId,
      printerName: printer?.name ?? t('fleet.printerFallbackName', { id: printerId }),
      jobs,
      selectedJobId: preselect,
      isHeld,
    });
  }

  async function submitLinkJob() {
    const { printerId, selectedJobId, isHeld } = linkJobModal;
    setLinkJobModal(null);

    if (selectedJobId) {
      const res = await fetch(`/api/printers/${printerId}/link-job`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: selectedJobId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(t('fleet.linkJobFailed', { reason: body.error || res.status }), 'error');
      }
    } else if (isHeld) {
      // No job selected — just release the hold
      await fetch(`/api/printers/${printerId}/set-ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    }

    fetchPrinters();
  }

  async function decommission(printerId, confirmedQty = null) {
    const printer = printers.find(p => p.id === printerId);

    // A held printer has a print outcome pending sign-off (the green/red "Set Ready /
    // Bad Print" buttons), and a printer with an uploading/printing job has work in
    // flight. Either way the outcome must be resolved before the machine leaves the
    // fleet — a normally-FINISHED printer awaiting confirmation has has_active_job=false
    // (its job is already 'finished'), so the hold is what flags the pending sign-off.
    const awaitingSignoff = printer?.has_active_job || printer?.is_held === 1;

    if (!awaitingSignoff) {
      // No outcome to resolve — just collect a note and decommission directly
      const result = await confirm({
        title: t('fleet.decommissionTitle', { name: printer?.name }),
        message: t('fleet.decommissionMessage'),
        cancelLabel: t('common.cancel'),
        prompt: t('fleet.decommissionReasonPrompt'),
        promptRequired: true,
        actions: [
          { label: t('fleet.decommission'), value: 'decommission', variant: 'danger' },
        ],
      });
      if (!result) return;
      const { text: reason } = result;
      const res = await fetch(`/api/printers/${printerId}/decommission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: reason }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(t('fleet.decommissionFailed', { reason: body.error || res.status }), 'error');
      }
      fetchPrinters();
      return;
    }

    // Print outcome pending (active job or held for sign-off) — resolve it first
    const result = await confirm({
      title: t('fleet.decommissionTitle', { name: printer?.name }),
      message: t('fleet.decommissionSignoffMessage'),
      cancelLabel: t('common.cancel'),
      prompt: t('fleet.decommissionReasonPrompt'),
      promptRequired: true,
      actions: [
        { label: t('fleet.decommissionSuccessAction'), value: 'success', variant: 'success' },
        { label: t('fleet.decommissionFailureAction'), value: 'failure', variant: 'danger'  },
      ],
    });
    if (!result) return;
    const { value: choice, text: reason } = result;

    if (choice === 'failure') {
      const res = await fetch(`/api/printers/${printerId}/mark-job-failure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: reason }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showToast(t('fleet.markFailureFailed', { reason: body.error || res.status }), 'error');
      }
      fetchPrinters();
      return;
    }

    // choice === 'success' — forward the operator's good-part count (if adjusted) so the
    // credit matches what Set Ready would have applied, then decommission instead of re-queue.
    const res = await fetch(`/api/printers/${printerId}/complete-and-decommission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: reason, confirmed_qty: (confirmedQty != null && !isNaN(confirmedQty)) ? confirmedQty : null }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(t('fleet.decommissionFailed', { reason: body.error || res.status }), 'error');
    }
    fetchPrinters();
  }

  async function badPrint(printerId) {
    const printer = printers.find(p => p.id === printerId);
    const result = await confirm({
      title: t('fleet.markBadPrintTitle', { name: printer?.name }),
      message: t('fleet.markBadPrintMessage'),
      confirmLabel: t('fleet.markAsFailed'),
      prompt: t('fleet.reasonForFailure'),
      promptRequired: true,
      danger: true,
    });
    if (!result) return;
    const { text: reason } = result;
    const res = await fetch(`/api/printers/${printerId}/mark-job-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: reason }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(t('fleet.badPrintFailed', { reason: body.error || res.status }), 'error');
    } else {
      setSelectedForReady(prev => { const next = new Set(prev); next.delete(printerId); return next; });
    }
    fetchPrinters();
  }

  async function uploadFailed(printerId) {
    const printer = printers.find(p => p.id === printerId);
    const result = await confirm({
      title: t('fleet.confirmUploadFailureTitle', { name: printer?.name }),
      message: t('fleet.confirmUploadFailureMessage'),
      confirmLabel: t('fleet.confirmUploadFailedLabel'),
      prompt: t('fleet.notesReasonPrompt'),
      promptRequired: true,
      danger: true,
    });
    if (!result) return;
    const { text: reason } = result;
    const res = await fetch(`/api/printers/${printerId}/mark-job-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: reason }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(t('fleet.uploadFailureMarkFailed', { reason: body.error || res.status }), 'error');
    }
    fetchPrinters();
  }

  const counts = printers.reduce((acc, p) => {
    const s = displayStatus(p);
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const hasUnknown = printers.some(p => !KNOWN_STATUSES.has(p.status));

  const filtered = printers.filter((p) => {
    if (filter === 'UNKNOWN') return !KNOWN_STATUSES.has(p.status);
    if (filter !== 'ALL' && displayStatus(p) !== filter) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) &&
        !p.ip.includes(search) && !(p.group_name || '').toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    return true;
  });

  // Group by model — order and labels come from the DB via /api/models
  const modelOrder  = allModels.map(m => m.model_id);
  const MODEL_LABELS = Object.fromEntries(allModels.map(m => [m.model_id, m.label]));
  MODEL_LABELS.other = t('common.other');

  const grouped = modelOrder.reduce((acc, model) => {
    const group = filtered.filter((p) => p.model === model);
    if (group.length > 0) acc[model] = group;
    return acc;
  }, {});
  const otherModels = filtered.filter((p) => !modelOrder.includes(p.model));
  if (otherModels.length > 0) grouped['other'] = otherModels;

  async function sweep() {
    await fetch('/api/scheduler/dispatch', { method: 'POST' });
    fetchPrinters();
  }

  return (
    <div>
      {confirmModal}
      {toastEl}

      {linkJobModal && (
        <div
          onClick={() => setLinkJobModal(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#1e2433', border: '1px solid #2d3748', borderRadius: 8, padding: 24, width: 480, maxWidth: '90vw', maxHeight: '80vh', overflow: 'auto' }}
          >
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{t('fleet.linkJobModalTitle', { name: linkJobModal.printerName })}</div>
            <div style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
              {t('fleet.linkJobModalHint')}
            </div>

            {linkJobModal.jobs.length === 0 ? (
              <div style={{ fontSize: 13, color: '#94a3b8', padding: '12px 0' }}>
                {t('fleet.linkJobModalEmpty')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {linkJobModal.jobs.map(job => (
                  <div
                    key={job.id}
                    onClick={() => setLinkJobModal(m => ({ ...m, selectedJobId: job.id }))}
                    style={{
                      background: linkJobModal.selectedJobId === job.id ? '#1e3a5f' : '#0f172a',
                      border: `1px solid ${linkJobModal.selectedJobId === job.id ? '#3b82f6' : '#2d3748'}`,
                      borderRadius: 6,
                      padding: '10px 12px',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{job.part_name}</div>
                    <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace', marginBottom: 4 }}>{job.gcode_filename}</div>
                    <div style={{ fontSize: 11, color: '#475569' }}>
                      {t('fleet.linkJobRowMeta', { id: job.id, status: t(JOB_STATUS_LABEL_KEYS[job.status] || 'common.statusUnknown') })}
                      {job.original_printer_name ? t('fleet.linkJobRowWasOn', { name: job.original_printer_name }) : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button
                onClick={() => setLinkJobModal(null)}
                style={{ background: '#1e2433', color: '#94a3b8', border: '1px solid #2d3748', borderRadius: 6, padding: '6px 16px', fontSize: 13, cursor: 'pointer' }}
              >
                {t('common.cancel')}
              </button>
              {linkJobModal.isHeld && !linkJobModal.selectedJobId && (
                <button
                  onClick={submitLinkJob}
                  style={{ background: '#166534', color: '#4ade80', border: 'none', borderRadius: 6, padding: '6px 16px', fontSize: 13, cursor: 'pointer' }}
                >
                  {t('fleet.releaseHold')}
                </button>
              )}
              {linkJobModal.selectedJobId && (
                <button
                  onClick={submitLinkJob}
                  style={{ background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                >
                  {t('fleet.linkJob')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{t('fleet.title')}</h1>
          <PollTimer lastPolled={lastPolled} intervalMs={15000} />
        </div>
        <button
          onClick={sweep}
          title={t('fleet.sweepTitle')}
          style={{ background: '#1e2433', color: '#94a3b8', border: '1px solid #2d3748', borderRadius: 6, padding: '5px 14px', fontSize: 13, cursor: 'pointer' }}
        >
          {t('fleet.sweepButton')}
        </button>
      </div>

      {/* Offline-with-job banner */}
      {awaitingOfflineReview.length > 0 && (
        <div style={{
          background: '#292113',
          border: '1px solid #92400e',
          borderRadius: 8,
          padding: '10px 16px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <span style={{ color: '#fbbf24', fontWeight: 600, fontSize: 14 }}>
            {t('fleet.offlineBannerCount', { count: awaitingOfflineReview.length })}
          </span>
          <span style={{ color: '#78350f', fontSize: 13 }}>
            {t('fleet.offlineBannerAutoClear')}
          </span>
        </div>
      )}

      {/* Upload-stalled banner */}
      {awaitingUploadReview.length > 0 && (
        <div style={{
          background: '#292113',
          border: '1px solid #92400e',
          borderRadius: 8,
          padding: '10px 16px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <span style={{ color: '#fbbf24', fontWeight: 600, fontSize: 14 }}>
            {t('fleet.uploadBannerCount', { count: awaitingUploadReview.length })}
          </span>
        </div>
      )}

      {/* Confirmation banner */}
      {awaitingConfirmation.length > 0 && (
        <div style={{
          background: '#14532d',
          border: '1px solid #15803d',
          borderRadius: 8,
          padding: '10px 16px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <span style={{ color: '#86efac', fontWeight: 600, fontSize: 14 }}>
            {t('fleet.awaitingBannerCount', { count: awaitingConfirmation.length })}
          </span>
          <button
            onClick={selectAll}
            style={{ background: '#166534', color: '#4ade80', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            {t('fleet.selectAll')}
          </button>
          {selectedForReady.size > 0 && (
            <>
              <button
                onClick={deselectAll}
                style={{ background: '#1f2937', color: '#9ca3af', border: 'none', borderRadius: 4, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}
              >
                {t('fleet.deselectAll')}
              </button>
              <button
                onClick={setReadyForSelected}
                style={{ background: '#15803d', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
              >
                ✓ {t('fleet.setReadyCount', { count: selectedForReady.size })}
              </button>
            </>
          )}
        </div>
      )}

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {[
          { key: 'ALL',      count: printers.length,        label: t('fleet.filterCount', { label: t('common.all'), count: printers.length }),                          color: '#64748b' },
          { key: 'PRINTING', count: counts.PRINTING || 0,   label: t('fleet.filterCount', { label: t('common.statusPrinting'), count: counts.PRINTING || 0 }),          color: STATUS_COLORS.PRINTING.text },
          { key: 'UPLOADING',count: counts.UPLOADING || 0,  label: t('fleet.filterCount', { label: t('common.statusUploading'), count: counts.UPLOADING || 0 }),        color: STATUS_COLORS.UPLOADING.text },
          { key: 'IDLE',     count: counts.IDLE || 0,       label: t('fleet.filterCount', { label: t('common.statusIdle'), count: counts.IDLE || 0 }),                  color: STATUS_COLORS.IDLE.text },
          { key: 'FINISHED', count: counts.FINISHED || 0,   label: t('fleet.filterCount', { label: t('common.statusFinished'), count: counts.FINISHED || 0 }),          color: STATUS_COLORS.FINISHED.text },
          { key: 'STOPPED',  count: counts.STOPPED || 0,    label: t('fleet.filterCount', { label: t('common.statusStopped'), count: counts.STOPPED || 0 }),            color: STATUS_COLORS.STOPPED.text },
          { key: 'ERROR',    count: counts.ERROR || 0,      label: t('fleet.filterCount', { label: t('common.statusError'), count: counts.ERROR || 0 }),                color: STATUS_COLORS.ERROR.text },
          { key: 'ATTENTION',count: counts.ATTENTION || 0,  label: t('fleet.filterCount', { label: t('common.statusAttention'), count: counts.ATTENTION || 0 }),        color: STATUS_COLORS.ATTENTION.text },
          { key: 'OFFLINE',  count: counts.OFFLINE || 0,    label: t('fleet.filterCount', { label: t('common.statusOffline'), count: counts.OFFLINE || 0 }),            color: STATUS_COLORS.OFFLINE.text },
          ...(hasUnknown ? [{ key: 'UNKNOWN', count: 1, label: t('fleet.filterCount', { label: t('common.statusUnknown'), count: printers.filter(p => !KNOWN_STATUSES.has(p.status)).length }), color: STATUS_COLORS.UNKNOWN.text }] : []),
        // Zero-count chips are noise — hide them unless that filter is currently active
        ].filter(({ key, count }) => key === 'ALL' || count > 0 || filter === key)
         .map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              background: filter === key ? '#1d4ed8' : '#1e2433',
              color: filter === key ? '#fff' : color,
              border: `1px solid ${filter === key ? '#60a5fa' : '#2d3748'}`,
              borderRadius: 20,
              padding: '4px 12px',
              fontSize: 13,
              cursor: 'pointer',
              fontWeight: filter === key ? 700 : 400,
              boxShadow: filter === key ? '0 0 0 1px #3b82f630' : 'none',
            }}
          >
            {label}
          </button>
        ))}
        <input
          type="text"
          placeholder={t('fleet.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: '#1e2433',
            border: '1px solid #2d3748',
            borderRadius: 20,
            padding: '4px 14px',
            color: '#e2e8f0',
            fontSize: 13,
            outline: 'none',
            flex: '1 1 180px',
            maxWidth: 280,
          }}
        />
      </div>

      {loading && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 10,
        }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 100 }} />
          ))}
        </div>
      )}
      {error && <p style={{ color: '#f87171' }}>{t('common.errorPrefix', { message: error })}</p>}
      {!loading && printers.length === 0 && (
        <EmptyState
          title={t('fleet.emptyTitle')}
          hint={t('fleet.emptyHint')}
          actionLabel={t('fleet.emptyActionLabel')}
          actionTo="/settings"
        />
      )}

      {Object.entries(grouped).map(([model, group]) => (
        <div key={model} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
            {MODEL_LABELS[model] || model} <span style={{ fontWeight: 400, color: '#475569' }}>({group.length})</span>
          </h2>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 10,
          }}>
            {group.map((printer) => (
              <PrinterCard
                key={printer.id}
                printer={printer}
                selected={selectedForReady.has(printer.id)}
                onToggleSelect={toggleSelect}
                onSetReady={setReady}
                onBadPrint={badPrint}
                onUploadFailed={uploadFailed}
                onDecommission={decommission}
                onLinkJob={openLinkJobModal}
                onOpenDetail={(id) => navigate(`/printers/${id}`)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
