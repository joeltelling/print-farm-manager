import { useState, useEffect, useCallback } from 'react';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';
import {
  theme, CARD_STYLE, PANEL_STYLE, INPUT_STYLE, BTN_PRIMARY, BTN_SECONDARY,
  CAPTION_STYLE, CHIP_STYLE, hexAlpha,
} from '../theme';

const ACCENT_HEX = {
  lime: theme.lime,
  violet: theme.violet,
  cyan: theme.cyan,
  amber: theme.amber,
  red: theme.red,
  indigo: theme.indigo,
};

const ACCENT_OPTIONS = Object.keys(ACCENT_HEX);

async function readError(res) {
  const body = await res.json().catch(() => ({}));
  return body.error || res.status;
}

export default function WorkspaceBoard() {
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();
  const [columns, setColumns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newCardTitle, setNewCardTitle] = useState({});
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnTitle, setNewColumnTitle] = useState('');
  const [newColumnAccent, setNewColumnAccent] = useState('violet');

  // Card edit modal
  const [editCard, setEditCard] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [saving, setSaving] = useState(false);

  // Column rename inline
  const [renamingId, setRenamingId] = useState(null);
  const [renameTitle, setRenameTitle] = useState('');

  // Drag state
  const [dragCard, setDragCard] = useState(null);
  const [dragOver, setDragOver] = useState(null); // { columnId, index } or { columnId, type: 'column' }
  const [dragColId, setDragColId] = useState(null);

  const load = useCallback(() => {
    return fetch('/api/workspace')
      .then(r => r.json())
      .then(data => {
        setColumns(data.columns || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createCard(columnId) {
    const title = (newCardTitle[columnId] || '').trim();
    if (!title) return;
    const res = await fetch('/api/workspace/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column_id: columnId, title }),
    });
    if (!res.ok) {
      showToast('Create card failed: ' + await readError(res), 'error');
      return;
    }
    setNewCardTitle(t => ({ ...t, [columnId]: '' }));
    await load();
  }

  async function createColumn(e) {
    e.preventDefault();
    const title = newColumnTitle.trim();
    if (!title) return;
    const res = await fetch('/api/workspace/columns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, accent: newColumnAccent }),
    });
    if (!res.ok) {
      showToast('Create column failed: ' + await readError(res), 'error');
      return;
    }
    setNewColumnTitle('');
    setAddingColumn(false);
    await load();
  }

  async function saveColumnRename(id) {
    const title = renameTitle.trim();
    if (!title) {
      setRenamingId(null);
      return;
    }
    const res = await fetch(`/api/workspace/columns/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      showToast('Rename column failed: ' + await readError(res), 'error');
      return;
    }
    setRenamingId(null);
    await load();
  }

  async function deleteColumn(col) {
    const ok = await confirm({
      title: 'Delete column',
      message: `"${col.title}" and all its cards will be deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/workspace/columns/${col.id}`, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Delete column failed: ' + await readError(res), 'error');
      return;
    }
    showToast('Column deleted');
    await load();
  }

  function openCard(card) {
    setEditCard(card);
    setEditTitle(card.title);
    setEditBody(card.body || '');
  }

  async function saveCard(e) {
    e.preventDefault();
    if (!editCard) return;
    const title = editTitle.trim();
    if (!title) {
      showToast('Title is required', 'error');
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/workspace/cards/${editCard.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: editBody }),
    });
    setSaving(false);
    if (!res.ok) {
      showToast('Save card failed: ' + await readError(res), 'error');
      return;
    }
    setEditCard(null);
    await load();
  }

  async function deleteCard() {
    if (!editCard) return;
    const ok = await confirm({
      title: 'Delete card',
      message: `"${editCard.title}" will be deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/workspace/cards/${editCard.id}`, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Delete card failed: ' + await readError(res), 'error');
      return;
    }
    setEditCard(null);
    showToast('Card deleted');
    await load();
  }

  async function persistCardOrder(nextColumns) {
    const cards = [];
    for (const col of nextColumns) {
      col.cards.forEach((card, i) => {
        cards.push({ id: card.id, column_id: col.id, sort_order: i });
      });
    }
    if (cards.length === 0) return;
    const res = await fetch('/api/workspace/cards/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards }),
    });
    if (!res.ok) {
      showToast('Reorder failed: ' + await readError(res), 'error');
      await load();
      return;
    }
    const data = await res.json();
    setColumns(data.columns || []);
  }

  async function persistColumnOrder(orderIds) {
    const res = await fetch('/api/workspace/columns/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: orderIds }),
    });
    if (!res.ok) {
      showToast('Reorder columns failed: ' + await readError(res), 'error');
      await load();
      return;
    }
    const data = await res.json();
    setColumns(data.columns || []);
  }

  function onCardDragStart(card, columnId) {
    setDragCard({ id: card.id, fromColumnId: columnId });
  }

  function onCardDrop(targetColumnId, targetIndex) {
    if (!dragCard) return;
    setDragOver(null);

    const next = columns.map(c => ({ ...c, cards: [...c.cards] }));
    const fromCol = next.find(c => c.id === dragCard.fromColumnId);
    const toCol = next.find(c => c.id === targetColumnId);
    if (!fromCol || !toCol) {
      setDragCard(null);
      return;
    }

    const fromIdx = fromCol.cards.findIndex(c => c.id === dragCard.id);
    if (fromIdx < 0) {
      setDragCard(null);
      return;
    }
    const [moved] = fromCol.cards.splice(fromIdx, 1);
    let insertAt = targetIndex;
    if (dragCard.fromColumnId === targetColumnId && fromIdx < targetIndex) {
      insertAt = Math.max(0, targetIndex - 1);
    }
    insertAt = Math.min(insertAt, toCol.cards.length);
    toCol.cards.splice(insertAt, 0, moved);

    setColumns(next);
    setDragCard(null);
    persistCardOrder(next);
  }

  function onColumnDrop(targetColId) {
    if (!dragColId || dragColId === targetColId) {
      setDragColId(null);
      setDragOver(null);
      return;
    }
    const ids = columns.map(c => c.id);
    const from = ids.indexOf(dragColId);
    const to = ids.indexOf(targetColId);
    if (from < 0 || to < 0) {
      setDragColId(null);
      return;
    }
    ids.splice(from, 1);
    ids.splice(to, 0, dragColId);
    setDragColId(null);
    setDragOver(null);
    const reordered = ids.map(id => columns.find(c => c.id === id)).filter(Boolean);
    setColumns(reordered);
    persistColumnOrder(ids);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <style>{`
        .ws-board-scroll {
          display: flex;
          gap: 14px;
          overflow-x: auto;
          overflow-y: hidden;
          padding-bottom: 12px;
          flex: 1;
          min-height: 0;
          align-items: stretch;
        }
        .ws-col {
          width: 280px;
          min-width: 280px;
          max-width: 280px;
          display: flex;
          flex-direction: column;
          max-height: 100%;
        }
        .ws-col-cards {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 4px 2px 8px;
          min-height: 48px;
        }
        .ws-card-drop {
          height: 6px;
          border-radius: 4px;
          transition: background 0.1s, height 0.1s;
        }
        .ws-card-drop.is-over {
          height: 28px;
          background: ${hexAlpha(theme.lime, 0.2)};
          border: 1px dashed ${theme.lime};
        }
        @media (max-width: 600px) {
          .ws-col { width: 260px; min-width: 260px; max-width: 260px; }
        }
      `}</style>

      <PageHeader
        title="Board"
        subtitle="Task flow and operator notes"
        badge="WORKSPACE"
        badgeColor={theme.violet}
        actions={
          !addingColumn ? (
            <button type="button" style={BTN_SECONDARY} onClick={() => setAddingColumn(true)}>
              New column
            </button>
          ) : null
        }
      />

      {addingColumn && (
        <form
          onSubmit={createColumn}
          style={{
            ...CARD_STYLE,
            padding: 14,
            marginBottom: 14,
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <input
            autoFocus
            value={newColumnTitle}
            onChange={e => setNewColumnTitle(e.target.value)}
            placeholder="Column name"
            style={{ ...INPUT_STYLE, maxWidth: 220 }}
            maxLength={80}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            {ACCENT_OPTIONS.map(a => (
              <button
                key={a}
                type="button"
                title={a}
                onClick={() => setNewColumnAccent(a)}
                style={{
                  width: 18, height: 18, borderRadius: 999, padding: 0,
                  background: ACCENT_HEX[a],
                  border: newColumnAccent === a ? `2px solid ${theme.textBright}` : '2px solid transparent',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
          <button type="submit" style={BTN_PRIMARY}>Add</button>
          <button type="button" style={BTN_SECONDARY} onClick={() => { setAddingColumn(false); setNewColumnTitle(''); }}>
            Cancel
          </button>
        </form>
      )}

      {loading ? (
        <div style={{ color: theme.textMuted, fontSize: 13 }}>Loading board...</div>
      ) : columns.length === 0 ? (
        <EmptyState title="No columns" hint="Click New column to get started." />
      ) : (
        <div className="ws-board-scroll">
          {columns.map(col => {
            const accent = ACCENT_HEX[col.accent] || theme.violet;
            const isColOver = dragOver?.type === 'column' && dragOver.columnId === col.id;
            return (
              <div
                key={col.id}
                className="ws-col"
                style={{
                  ...PANEL_STYLE,
                  borderColor: isColOver ? accent : theme.border,
                  boxShadow: isColOver ? `0 0 0 1px ${accent}` : PANEL_STYLE.boxShadow,
                }}
                onDragOver={e => {
                  e.preventDefault();
                  if (dragColId) setDragOver({ type: 'column', columnId: col.id });
                }}
                onDrop={e => {
                  e.preventDefault();
                  if (dragColId) onColumnDrop(col.id);
                  else if (dragCard) onCardDrop(col.id, col.cards.length);
                }}
              >
                <div
                  draggable
                  onDragStart={() => setDragColId(col.id)}
                  onDragEnd={() => { setDragColId(null); setDragOver(null); }}
                  style={{
                    padding: '12px 12px 8px',
                    borderBottom: `1px solid ${theme.borderSoft}`,
                    borderTop: `3px solid ${accent}`,
                    borderTopLeftRadius: theme.radius,
                    borderTopRightRadius: theme.radius,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'grab',
                    opacity: dragColId === col.id ? 0.45 : 1,
                  }}
                >
                  {renamingId === col.id ? (
                    <input
                      autoFocus
                      value={renameTitle}
                      onChange={e => setRenameTitle(e.target.value)}
                      onBlur={() => saveColumnRename(col.id)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); saveColumnRename(col.id); }
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      style={{ ...INPUT_STYLE, flex: 1, padding: '4px 8px', fontSize: 12 }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setRenamingId(col.id); setRenameTitle(col.title); }}
                      style={{
                        ...CAPTION_STYLE,
                        background: 'transparent',
                        border: 'none',
                        color: theme.textStrong,
                        cursor: 'text',
                        padding: 0,
                        flex: 1,
                        textAlign: 'left',
                        fontSize: 11.5,
                      }}
                    >
                      {col.title}
                    </button>
                  )}
                  <span style={{ ...CHIP_STYLE, color: accent }}>{col.cards.length}</span>
                  <button
                    type="button"
                    title="Delete column"
                    onClick={() => deleteColumn(col)}
                    style={{
                      background: 'transparent', border: 'none', color: theme.textFaint,
                      cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>

                <div className="ws-col-cards">
                  <div
                    className={`ws-card-drop${dragOver?.columnId === col.id && dragOver.index === 0 && dragOver.type !== 'column' ? ' is-over' : ''}`}
                    onDragOver={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragCard) setDragOver({ columnId: col.id, index: 0 });
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      onCardDrop(col.id, 0);
                    }}
                  />
                  {col.cards.map((card, idx) => (
                    <div key={card.id}>
                      <div
                        draggable
                        onDragStart={() => onCardDragStart(card, col.id)}
                        onDragEnd={() => { setDragCard(null); setDragOver(null); }}
                        onClick={() => openCard(card)}
                        style={{
                          ...CARD_STYLE,
                          padding: '10px 12px',
                          cursor: 'grab',
                          opacity: dragCard?.id === card.id ? 0.4 : 1,
                          borderLeft: `3px solid ${accent}`,
                        }}
                      >
                        <div style={{
                          fontWeight: 600, fontSize: 13, color: theme.text,
                          marginBottom: card.body ? 4 : 0,
                        }}>
                          {card.title}
                        </div>
                        {card.body ? (
                          <div style={{
                            fontSize: 11.5, color: theme.textDim, lineHeight: 1.35,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}>
                            {card.body}
                          </div>
                        ) : null}
                      </div>
                      <div
                        className={`ws-card-drop${dragOver?.columnId === col.id && dragOver.index === idx + 1 && dragOver.type !== 'column' ? ' is-over' : ''}`}
                        onDragOver={e => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (dragCard) setDragOver({ columnId: col.id, index: idx + 1 });
                        }}
                        onDrop={e => {
                          e.preventDefault();
                          e.stopPropagation();
                          onCardDrop(col.id, idx + 1);
                        }}
                      />
                    </div>
                  ))}
                </div>

                <div style={{ padding: '8px 10px 12px', borderTop: `1px solid ${theme.borderSoft}` }}>
                  <form
                    onSubmit={e => { e.preventDefault(); createCard(col.id); }}
                    style={{ display: 'flex', gap: 6 }}
                  >
                    <input
                      value={newCardTitle[col.id] || ''}
                      onChange={e => setNewCardTitle(t => ({ ...t, [col.id]: e.target.value }))}
                      placeholder="New card"
                      style={{ ...INPUT_STYLE, flex: 1, padding: '6px 10px', fontSize: 12 }}
                      maxLength={120}
                    />
                    <button type="submit" style={{ ...BTN_PRIMARY, padding: '6px 10px', fontSize: 11 }}>
                      +
                    </button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editCard && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 80, padding: 16,
          }}
          onClick={() => setEditCard(null)}
        >
          <form
            onSubmit={saveCard}
            onClick={e => e.stopPropagation()}
            style={{
              ...CARD_STYLE,
              width: '100%', maxWidth: 440, padding: 20,
              display: 'flex', flexDirection: 'column', gap: 12,
            }}
          >
            <div style={{ ...CAPTION_STYLE, color: theme.violet }}>Card</div>
            <label style={{ fontSize: 11, color: theme.textDim }}>Title</label>
            <input
              autoFocus
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              style={INPUT_STYLE}
              maxLength={120}
              required
            />
            <label style={{ fontSize: 11, color: theme.textDim }}>Notes</label>
            <textarea
              value={editBody}
              onChange={e => setEditBody(e.target.value)}
              style={{ ...INPUT_STYLE, minHeight: 120, resize: 'vertical', lineHeight: 1.45 }}
              placeholder="Details, a short checklist, links..."
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <button type="button" style={{ ...BTN_SECONDARY, color: theme.red, borderColor: theme.redDeep }} onClick={deleteCard}>
                Delete
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" style={BTN_SECONDARY} onClick={() => setEditCard(null)}>Cancel</button>
                <button type="submit" style={BTN_PRIMARY} disabled={saving}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {toastEl}
      {confirmModal}
    </div>
  );
}
