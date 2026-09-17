import { useState, useCallback } from 'react';

const VARIANTS = {
  success: { bg: '#065f46', border: '#10b98140', text: '#34d399', icon: '✓' },
  error:   { bg: '#7f1d1d', border: '#ef444440', text: '#fca5a5', icon: '✕' },
  warning: { bg: '#78350f', border: '#f59e0b40', text: '#fbbf24', icon: '⚠' },
};

export function useToast(duration = 2500) {
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, variant = 'success', customDuration) => {
    const id = Date.now();
    const d = customDuration ?? (variant === 'warning' ? 4500 : duration);
    setToast({ message, id, variant });
    setTimeout(() => setToast(t => t?.id === id ? null : t), d);
  }, [duration]);

  const v = VARIANTS[toast?.variant] || VARIANTS.success;

  const toastEl = toast ? (
    <div style={{
      position: 'fixed',
      bottom: 24,
      right: 24,
      background: v.bg,
      border: `1px solid ${v.border}`,
      borderRadius: 8,
      padding: '10px 18px',
      color: v.text,
      fontSize: 13,
      fontWeight: 600,
      zIndex: 9999,
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      pointerEvents: 'none',
    }}>
      <span>{v.icon}</span>
      {toast.message}
    </div>
  ) : null;

  return [showToast, toastEl];
}
