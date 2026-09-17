import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfirm } from '../useConfirm';
import { useToast } from '../useToast';
import PageHeader from '../components/PageHeader';

function formatTimestamp(ms) {
  if (!ms) return 'Unknown';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function Decommissioned() {
  const navigate = useNavigate();
  const [confirm, confirmModal] = useConfirm();
  const [showToast, toastEl]    = useToast();

  const [printers, setPrinters] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [draftNote, setDraftNote] = useState('');
  const [saving, setSaving]       = useState(false);

  const fetchPrinters = useCallback(async () => {
    const res  = await fetch('/api/printers/decommissioned');
    const data = await res.json();
    setPrinters(data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchPrinters(); }, [fetchPrinters]);

  function beginEdit(printer) {
    setEditingId(printer.id);
    setDraftNote(printer.decommission_note || '');
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftNote('');
  }

  async function saveNote() {
    if (editingId == null) return;
    const id = editingId;
    const printer = printers.find(p => p.id === id);
    const trimmed = draftNote.trim();
    // No-op if the draft is unchanged — avoids spurious event-log entries on blur.
    if (printer && draftNote === (printer.decommission_note || '')) {
      setEditingId(null);
      setDraftNote('');
      return;
    }
    setSaving(true);
    try {
      await Promise.all([
        fetch(`/api/printers/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decommission_note: draftNote }),
        }),
        trimmed && fetch(`/api/printers/${id}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: trimmed }),
        }),
      ]);
      // Reflect saved note locally without refetch
      setPrinters(ps => ps.map(p => p.id === id ? { ...p, decommission_note: draftNote } : p));
      setEditingId(null);
      setDraftNote('');
      showToast('Note saved', 'success');
    } catch (err) {
      showToast(`Failed to save note: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function recommission(printer) {
    const result = await confirm({
      title: `Recommission ${printer.name}?`,
      message: 'Only proceed if the machine has been fully inspected and confirmed safe to run. It will return to the active fleet and be eligible to receive jobs immediately.',
      confirmLabel: 'Recommission',
      prompt: 'What was done to fix this printer?',
      promptRequired: true,
    });
    if (!result) return;
    const { text: fixNote } = result;
    await fetch(`/api/printers/${printer.id}/recommission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: fixNote }),
    });
    showToast(`${printer.name} recommissioned`, 'success');
    fetchPrinters();
  }

  if (loading) return <p style={{ color: '#71717a' }}>Loading…</p>;

  return (
    <div>
      <PageHeader
        title="Decommissioned"
        subtitle="Machines removed from the active fleet until an operator recommissions them."
      />

      {printers.length === 0 && (
        <p style={{ color: '#52525b', fontSize: 14 }}>No decommissioned printers.</p>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
        gap: 12,
      }}>
        {printers.map(printer => (
          <DecomCard
            key={printer.id}
            printer={printer}
            isEditing={editingId === printer.id}
            draftNote={draftNote}
            saving={saving && editingId === printer.id}
            onBeginEdit={() => beginEdit(printer)}
            onCancelEdit={cancelEdit}
            onChangeDraft={setDraftNote}
            onSave={saveNote}
            onRecommission={() => recommission(printer)}
            onViewHistory={() => navigate(`/printers/${printer.id}`)}
          />
        ))}
      </div>

      {confirmModal}
      {toastEl}
    </div>
  );
}

function DecomCard({
  printer, isEditing, draftNote, saving,
  onBeginEdit, onCancelEdit, onChangeDraft, onSave,
  onRecommission, onViewHistory,
}) {
  const note = printer.decommission_note || '';
  const textareaRef = useRef(null);

  // Auto-focus + place cursor at end when entering edit mode
  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
  }, [isEditing]);

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelEdit();
    }
  }

  return (
    <div style={{
      background: '#141620',
      border: '1px solid #232639',
      borderRadius: 8,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      position: 'relative',
    }}>
      {/* Header — name + model + actions */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontWeight: 700, fontSize: 14, color: '#f4f4f5',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {printer.name}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginTop: 3,
            flexWrap: 'wrap',
          }}>
            <span style={{
              background: '#12131c', borderRadius: 3, padding: '1px 6px',
              fontFamily: 'monospace', fontSize: 11, color: '#71717a',
            }}>
              {printer.model}
            </span>
            <span style={{ fontSize: 11, color: '#52525b', fontFamily: 'monospace' }}>{printer.ip}</span>
            {printer.group_name && (
              <span style={{ fontSize: 11, color: '#52525b' }}>{printer.group_name}</span>
            )}
          </div>
        </div>

        {/* Icon-style action buttons */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            onClick={onRecommission}
            title="Recommission"
            style={iconBtn('#818cf8', '#1e1f45')}
          >
            ↩
          </button>
          <button
            onClick={onViewHistory}
            title="View history"
            style={iconBtn('#a1a1aa', '#2d3146')}
          >
            ⋯
          </button>
        </div>
      </div>

      {/* Decommission timestamp */}
      <div style={{ fontSize: 11, color: '#52525b' }}>
        Removed {formatTimestamp(printer.decommissioned_at)}
      </div>

      {/* Note — view or edit */}
      {isEditing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <textarea
            ref={textareaRef}
            value={draftNote}
            onChange={e => onChangeDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={onSave}
            placeholder="Describe the issue, what was inspected, and any findings…"
            rows={3}
            style={{
              background: '#232639',
              border: '1px solid #8b5cf6',
              borderRadius: 5,
              color: '#f4f4f5',
              fontSize: 13,
              padding: '6px 10px',
              resize: 'vertical',
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.5,
            }}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 10, color: '#52525b',
          }}>
            <span>Enter saves · Shift+Enter newline · Esc cancels</span>
            {saving && <span style={{ color: '#818cf8' }}>Saving…</span>}
          </div>
        </div>
      ) : (
        <button
          onClick={onBeginEdit}
          title="Click to edit note"
          style={{
            background: 'transparent',
            border: '1px dashed #232639',
            borderRadius: 5,
            padding: '8px 10px',
            color: note ? '#d4d4d8' : '#52525b',
            fontSize: 13,
            lineHeight: 1.5,
            cursor: 'text',
            textAlign: 'left',
            fontFamily: 'inherit',
            minHeight: 38,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = '#2d3146'}
          onMouseLeave={e => e.currentTarget.style.borderColor = '#232639'}
        >
          {note || 'Add investigation note…'}
        </button>
      )}
    </div>
  );
}

function iconBtn(color, border) {
  return {
    background: 'none',
    color,
    border: `1px solid ${border}`,
    borderRadius: 5,
    width: 28, height: 28,
    fontSize: 14, fontWeight: 700,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    lineHeight: 1,
    padding: 0,
  };
}
