import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

export function useConfirm() {
  const [state, setState] = useState(null);
  const [inputValue, setInputValue] = useState('');

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      setInputValue('');
      setState({ ...options, resolve });
    });
  }, []);

  function handleAction(value) {
    const hasPrompt = state?.prompt !== undefined;
    const result = (hasPrompt && value !== null) ? { value, text: inputValue.trim() } : value;
    state?.resolve(result);
    setState(null);
    setInputValue('');
  }

  useEffect(() => {
    if (!state) return;
    function onKey(e) {
      if (e.key === 'Escape') handleAction(null);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const promptEmpty = state?.promptRequired && !inputValue.trim();

  const modal = state ? createPortal(
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
        backdropFilter: 'blur(3px)',
      }}
      onClick={() => handleAction(null)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={state.title || 'Confirm'}
        style={{
          background: '#232639',
          border: '1px solid #2d3146',
          borderRadius: 10,
          padding: '24px 28px',
          maxWidth: 460,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          animation: 'modalIn 0.15s ease-out',
        }}
        onClick={e => e.stopPropagation()}
      >
        {state.title && (
          <div style={{ fontSize: 16, fontWeight: 700, color: '#f4f4f5', marginBottom: 10 }}>
            {state.title}
          </div>
        )}
        {state.message && (
          <div style={{ fontSize: 14, color: '#a1a1aa', lineHeight: 1.65, marginBottom: state.prompt ? 16 : 24, whiteSpace: 'pre-line' }}>
            {state.message}
          </div>
        )}
        {state.prompt && (
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#71717a', fontWeight: 500, marginBottom: 6 }}>
              {state.prompt}
              {state.promptRequired && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
            </label>
            <textarea
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              rows={3}
              style={{
                width: '100%',
                background: '#141620',
                border: '1px solid #2d3146',
                borderRadius: 6,
                color: '#f4f4f5',
                fontSize: 13,
                padding: '8px 10px',
                resize: 'vertical',
                outline: 'none',
                fontFamily: 'inherit',
                lineHeight: 1.5,
                boxSizing: 'border-box',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = '#8b5cf6'; }}
              onBlur={e => { e.currentTarget.style.borderColor = '#2d3146'; }}
            />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            onClick={() => handleAction(null)}
            style={{
              background: '#181a27', color: '#a1a1aa',
              border: '1px solid #2d3146', borderRadius: 6,
              padding: '8px 18px', fontSize: 13, cursor: 'pointer', fontWeight: 500,
            }}
          >
            {state.cancelLabel || 'Cancel'}
          </button>

          {state.actions
            ? state.actions.map(action => (
              <button
                key={action.value}
                onClick={() => !promptEmpty && handleAction(action.value)}
                disabled={!!promptEmpty}
                style={{
                  background: promptEmpty        ? '#2d3146'
                             : action.variant === 'danger'  ? '#7f1d1d'
                             : action.variant === 'success' ? '#065f46'
                             : '#5b21b6',
                  color: promptEmpty             ? '#71717a'
                       : action.variant === 'danger'  ? '#fca5a5'
                       : action.variant === 'success' ? '#34d399'
                       : '#fff',
                  border: 'none', borderRadius: 6,
                  padding: '8px 18px', fontSize: 13, fontWeight: 600,
                  cursor: promptEmpty ? 'not-allowed' : 'pointer',
                  opacity: promptEmpty ? 0.6 : 1,
                  transition: 'opacity 0.1s, background 0.1s',
                }}
              >
                {action.label}
              </button>
            ))
            : (
              <button
                onClick={() => !promptEmpty && handleAction(true)}
                disabled={!!promptEmpty}
                style={{
                  background: promptEmpty ? '#2d3146' : state.danger ? '#7f1d1d' : '#5b21b6',
                  color: promptEmpty ? '#71717a' : state.danger ? '#fca5a5' : '#fff',
                  border: 'none', borderRadius: 6,
                  padding: '8px 18px', fontSize: 13, fontWeight: 600,
                  cursor: promptEmpty ? 'not-allowed' : 'pointer',
                  opacity: promptEmpty ? 0.6 : 1,
                  transition: 'opacity 0.1s, background 0.1s',
                }}
              >
                {state.confirmLabel || 'Confirm'}
              </button>
            )
          }
        </div>
      </div>
    </div>,
    document.body
  ) : null;

  return [confirm, modal];
}
