import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

// Circular progress ring that fills up between polls, giving the operator
// a visual countdown to the next refresh.
export default function PollTimer({ lastPolled, intervalMs = 15000, size = 20, stroke = '#3b82f6', track = '#2d3748' }) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (lastPolled == null) return;
    setElapsed(0);
    // 500ms is plenty for a 15s ring — 100ms redrew 10×/s for no visible gain
    const id = setInterval(() => setElapsed(Date.now() - lastPolled), 500);
    return () => clearInterval(id);
  }, [lastPolled]);

  const strokeWidth = Math.max(2, Math.round(size / 8));
  const r = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * r;
  const progress = Math.min(elapsed / intervalMs, 1);
  const offset = circumference * (1 - progress);

  return (
    <svg
      width={size}
      height={size}
      style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}
      title={t('common.lastRefresh', { seconds: Math.round(elapsed / 1000) })}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
}
