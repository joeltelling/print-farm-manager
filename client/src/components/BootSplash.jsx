import { useEffect, useState } from 'react';
import './BootSplash.css';

const SESSION_KEY = 'coma.boot.done';
const READY_AT_MS = 2400;
const LEAVE_AT_MS = 3100;
const UNMOUNT_AT_MS = 3600;

export function shouldShowBootSplash() {
  try {
    return sessionStorage.getItem(SESSION_KEY) !== '1';
  } catch {
    return true;
  }
}

function markBootDone() {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // private mode / blocked storage: splash still dismisses for this mount
  }
}

/**
 * Full-screen boot splash for the first entry of a browser tab session.
 * React Router navigations do not remount App, so they never re-trigger this.
 * A full reload in the same tab skips it via sessionStorage.
 */
export default function BootSplash({ siteName = 'CoMa', onDone }) {
  const [ready, setReady] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const readyAt = reduced ? 400 : READY_AT_MS;
    const leaveAt = reduced ? 700 : LEAVE_AT_MS;
    const unmountAt = reduced ? 750 : UNMOUNT_AT_MS;

    const tReady = setTimeout(() => setReady(true), readyAt);
    const tLeave = setTimeout(() => {
      markBootDone();
      setLeaving(true);
    }, leaveAt);
    const tDone = setTimeout(() => {
      onDone?.();
    }, unmountAt);

    return () => {
      clearTimeout(tReady);
      clearTimeout(tLeave);
      clearTimeout(tDone);
    };
  }, [onDone]);

  const labelLoading = 'Warming the shopfloor';
  const labelReady = 'CoMa is online';
  const statusLabel = ready ? labelReady : labelLoading;

  return (
    <div
      className={`coma-boot${ready ? ' is-ready' : ''}${leaving ? ' is-leaving' : ''}`}
      data-state={ready ? 'ready' : 'loading'}
    >
      <section
        className="coma-boot__card"
        role="status"
        aria-live="polite"
        aria-label={statusLabel}
      >
        <div className="coma-boot__stage" aria-hidden="true">
          <span className="coma-boot__head"><i /><i /></span>
          <span className="coma-boot__pour" />
          <span className="coma-boot__steam" style={{ '--dx': '-.45rem', '--d': '0s' }} />
          <span className="coma-boot__steam" style={{ '--dx': '.3rem', '--d': '1s' }} />
          <span className="coma-boot__steam" style={{ '--dx': '-.05rem', '--d': '2s' }} />
          <span className="coma-boot__cup">
            <span className="coma-boot__liquid" />
            <span className="coma-boot__handle" />
          </span>
          <span className="coma-boot__saucer" />
        </div>

        <div className="coma-boot__copy">
          <p className="coma-boot__label">
            <span className="coma-boot__load">{labelLoading}</span>
            <span className="coma-boot__ready">{labelReady}</span>
          </p>
          <p className="coma-boot__meta">
            {siteName}
            {' '}
            <span aria-hidden="true">·</span>
            {' '}
            CoreManufacturing
            {' '}
            <span aria-hidden="true">·</span>
            {' '}
            ERP + Shopfloor
          </p>
        </div>

        <div
          className="coma-boot__track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ready ? 100 : 62}
          aria-valuetext={ready ? 'Ready' : 'Starting up'}
        >
          <span className="coma-boot__fill" />
        </div>
      </section>
    </div>
  );
}
