import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';
import { theme, CARD_STYLE, INPUT_STYLE, BTN_PRIMARY, BTN_SECONDARY } from '../theme';

const EVENT_TYPE_COLORS = {
  stock_arrival:       { bg: 'rgba(45, 212, 191, 0.18)', text: theme.teal, border: theme.tealDeep },
  shipment:            { bg: 'rgba(129, 140, 248, 0.18)', text: theme.indigo, border: '#6366f1' },
  deadline:            { bg: 'rgba(245, 158, 11, 0.18)', text: theme.orange, border: theme.orangeDeep },
  production_closure:  { bg: 'rgba(248, 113, 113, 0.18)', text: theme.red, border: theme.redDeep },
  note:                { bg: 'rgba(161, 161, 170, 0.14)', text: theme.textMuted, border: theme.borderStrong },
  derived:             { bg: 'rgba(163, 230, 53, 0.12)', text: theme.lime, border: theme.limeDeep },
  _fallback:           { bg: 'rgba(139, 92, 246, 0.16)', text: theme.violet, border: theme.accent },
};

const EVENT_TYPE_LABELS = {
  stock_arrival: 'Stock arrival',
  shipment: 'Shipment',
  deadline: 'Deadline',
  production_closure: 'Production closure',
  note: 'Note',
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function monthLabel(d) {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseLocalDateInput(value) {
  // YYYY-MM-DD as local midnight, not UTC.
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function endOfLocalDateInput(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function toDateInputValue(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildMonthCells(cursor) {
  const first = startOfMonth(cursor);
  // Monday-based week: JS getDay() is 0=Sun ... 6=Sat
  const mondayOffset = (first.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset + i);
    cells.push(d);
  }
  return cells;
}

function eventColors(type) {
  return EVENT_TYPE_COLORS[type] || EVENT_TYPE_COLORS._fallback;
}

function emptyForm(prefillDay) {
  const day = prefillDay || toDateInputValue(Date.now());
  return {
    event_type: 'stock_arrival',
    title: '',
    notes: '',
    start_date: day,
    end_date: day,
    all_day: true,
    status: 'planned',
    blocks_dispatch: false,
    item_sku: '',
  };
}

export default function Calendar() {
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [events, setEvents] = useState([]);
  const [derived, setDerived] = useState([]);
  const [block, setBlock] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(() => emptyForm());
  const [selectedDay, setSelectedDay] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const range = useMemo(() => {
    const cells = buildMonthCells(cursor);
    const from = new Date(cells[0].getFullYear(), cells[0].getMonth(), cells[0].getDate()).getTime();
    const last = cells[cells.length - 1];
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999).getTime();
    return { from, to };
  }, [cursor]);

  const fetchAll = useCallback(async () => {
    try {
      const qs = `from=${range.from}&to=${range.to}`;
      const [evRes, ovRes, blRes] = await Promise.all([
        fetch(`/api/calendar/events?${qs}`),
        fetch(`/api/calendar/overview?${qs}`),
        fetch('/api/calendar/dispatch-block'),
      ]);
      if (evRes.ok) setEvents(await evRes.json());
      if (ovRes.ok) {
        const body = await ovRes.json();
        setDerived(body.items || []);
      }
      if (blRes.ok) {
        const body = await blRes.json();
        setBlock(body.active ? body.block : null);
      }
    } catch (_) {
      // Background refresh: swallow. Mutations toast separately.
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => {
    setLoading(true);
    fetchAll();
  }, [fetchAll]);

  const cells = useMemo(() => buildMonthCells(cursor), [cursor]);
  const todayKey = dayKey(new Date());

  const eventsByDay = useMemo(() => {
    const map = {};
    const bump = (key, item) => {
      if (!map[key]) map[key] = [];
      map[key].push(item);
    };
    for (const e of events) {
      const start = new Date(e.start_at);
      const end = new Date(e.end_at != null ? e.end_at : e.start_at);
      const cursorDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      while (cursorDay <= last) {
        bump(dayKey(cursorDay), { kind: 'planned', ...e });
        cursorDay.setDate(cursorDay.getDate() + 1);
      }
    }
    for (const d of derived) {
      if (d.start_at == null) continue;
      bump(dayKey(new Date(d.start_at)), { kind: 'derived', event_type: 'derived', ...d });
    }
    return map;
  }, [events, derived]);

  const selectedKey = selectedDay ? dayKey(selectedDay) : null;
  const selectedItems = selectedKey ? (eventsByDay[selectedKey] || []) : [];

  function openCreate(day) {
    const key = dayKey(day);
    setSelectedDay(day);
    setEditingId(null);
    setForm(emptyForm(key));
    setShowForm(true);
  }

  function openEdit(ev) {
    setEditingId(ev.id);
    setForm({
      event_type: ev.event_type,
      title: ev.title || '',
      notes: ev.notes || '',
      start_date: toDateInputValue(ev.start_at),
      end_date: toDateInputValue(ev.end_at != null ? ev.end_at : ev.start_at),
      all_day: ev.all_day !== 0,
      status: ev.status || 'planned',
      blocks_dispatch: ev.blocks_dispatch === 1,
      item_sku: ev.item_sku || '',
    });
    setShowForm(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const isClosure = form.event_type === 'production_closure';
      const payload = {
        event_type: form.event_type,
        title: form.title.trim(),
        notes: form.notes.trim() || null,
        start_at: parseLocalDateInput(form.start_date),
        end_at: form.end_date ? endOfLocalDateInput(form.end_date) : null,
        all_day: form.all_day ? 1 : 0,
        status: form.status,
        blocks_dispatch: (isClosure || form.blocks_dispatch) ? 1 : 0,
        item_sku: form.item_sku.trim() || null,
      };
      const url = editingId ? `/api/calendar/events/${editingId}` : '/api/calendar/events';
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast('Save failed: ' + (body.error || res.status), 'error');
        return;
      }
      showToast(editingId ? 'Event updated' : 'Event created');
      setShowForm(false);
      setEditingId(null);
      await fetchAll();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(ev) {
    const ok = await confirm({
      title: 'Delete event',
      message: `Delete "${ev.title}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/calendar/events/${ev.id}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast('Delete failed: ' + (body.error || res.status), 'error');
      return;
    }
    showToast('Event deleted');
    await fetchAll();
  }

  async function markDone(ev) {
    const res = await fetch(`/api/calendar/events/${ev.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast('Update failed: ' + (body.error || res.status), 'error');
      return;
    }
    showToast('Marked done');
    await fetchAll();
  }

  return (
    <div>
      {toastEl}
      {confirmModal}
      <style>{`
        .cal-grid {
          display: grid;
          grid-template-columns: repeat(7, minmax(0, 1fr));
          gap: 4px;
        }
        .cal-day {
          min-height: 92px;
          padding: 6px;
          border-radius: 10px;
          border: 1px solid ${theme.border};
          background: ${theme.card};
          cursor: pointer;
          text-align: left;
          overflow: hidden;
        }
        .cal-day:hover { border-color: ${theme.borderStrong}; background: ${theme.hover}; }
        .cal-layout {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 16px;
          align-items: start;
        }
        @media (max-width: 600px) {
          .cal-layout { grid-template-columns: 1fr; }
          .cal-day { min-height: 64px; padding: 4px; }
          .cal-chip-label { display: none; }
        }
      `}</style>

      <PageHeader
        title="Calendar"
        subtitle="Planned stock arrivals, shipments, deadlines, and production closures. Closures block new job dispatch."
        badge={block ? 'CLOSURE ACTIVE' : null}
        badgeColor={theme.red}
        actions={(
          <button
            type="button"
            style={BTN_PRIMARY}
            onClick={() => openCreate(selectedDay || new Date())}
          >
            New event
          </button>
        )}
      />

      {block && (
        <div style={{
          ...CARD_STYLE,
          marginBottom: 16,
          padding: '12px 16px',
          borderColor: theme.redDeep,
          background: 'rgba(248, 113, 113, 0.08)',
          color: theme.red,
          fontSize: 13,
        }}>
          Production closure active: <strong style={{ color: theme.text }}>{block.title}</strong>
          {block.end_at
            ? ` - no new jobs until ${new Date(block.end_at).toLocaleString()}`
            : ' - no new jobs until further notice'}
          . Uploads and prints already in progress continue.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <button type="button" style={BTN_SECONDARY} onClick={() => setCursor(c => addMonths(c, -1))}>Prev</button>
        <div style={{ fontWeight: 700, color: theme.text, minWidth: 160, textAlign: 'center' }}>
          {monthLabel(cursor)}
        </div>
        <button type="button" style={BTN_SECONDARY} onClick={() => setCursor(c => addMonths(c, 1))}>Next</button>
        <button type="button" style={BTN_SECONDARY} onClick={() => setCursor(startOfMonth(new Date()))}>Today</button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: theme.textDim }}>
          {Object.entries(EVENT_TYPE_LABELS).map(([k, label]) => {
            const c = eventColors(k);
            return (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: c.text }} />
                {label}
              </span>
            );
          })}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: theme.lime }} />
            History (ERP / jobs)
          </span>
        </div>
      </div>

      {loading ? (
        <div style={{ color: theme.textFaint, padding: 40, textAlign: 'center' }}>Loading…</div>
      ) : (
        <div className="cal-layout">
          <div>
            <div className="cal-grid" style={{ marginBottom: 4 }}>
              {WEEKDAYS.map(d => (
                <div key={d} style={{
                  fontSize: 11, fontWeight: 600, color: theme.textDim,
                  textAlign: 'center', padding: '4px 0',
                }}>{d}</div>
              ))}
            </div>
            <div className="cal-grid">
              {cells.map((day) => {
                const key = dayKey(day);
                const inMonth = day.getMonth() === cursor.getMonth();
                const isToday = key === todayKey;
                const isSelected = selectedKey === key;
                const dayEvents = eventsByDay[key] || [];
                return (
                  <button
                    key={key}
                    type="button"
                    className="cal-day"
                    onClick={() => { setSelectedDay(day); setShowForm(false); }}
                    onDoubleClick={() => openCreate(day)}
                    style={{
                      opacity: inMonth ? 1 : 0.45,
                      outline: isSelected ? `1px solid ${theme.accent}` : 'none',
                      boxShadow: isToday ? `inset 0 0 0 1px ${theme.lime}` : undefined,
                    }}
                  >
                    <div style={{
                      fontSize: 12,
                      fontWeight: isToday ? 800 : 600,
                      color: isToday ? theme.lime : theme.textMuted,
                      marginBottom: 4,
                    }}>
                      {day.getDate()}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {dayEvents.slice(0, 3).map((ev, i) => {
                        const c = eventColors(ev.event_type);
                        return (
                          <div
                            key={`${ev.kind}-${ev.id}-${i}`}
                            className="cal-chip"
                            style={{
                              fontSize: 10,
                              lineHeight: 1.2,
                              padding: '2px 4px',
                              borderRadius: 4,
                              background: c.bg,
                              color: c.text,
                              borderLeft: `2px solid ${c.border}`,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                            title={ev.title}
                          >
                            <span className="cal-chip-label">{ev.title}</span>
                          </div>
                        );
                      })}
                      {dayEvents.length > 3 && (
                        <div style={{ fontSize: 10, color: theme.textFaint }}>+{dayEvents.length - 3} more</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ ...CARD_STYLE, padding: 16 }}>
            <div style={{ fontWeight: 700, color: theme.text, marginBottom: 8, fontSize: 14 }}>
              {selectedDay
                ? selectedDay.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
                : 'Select a day'}
            </div>

            {showForm ? (
              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 2 }}>
                  {editingId ? 'Edit event' : 'New event'}
                </div>
                <label style={{ fontSize: 11, color: theme.textDim }}>Type</label>
                <select
                  value={form.event_type}
                  onChange={e => {
                    const event_type = e.target.value;
                    setForm(f => ({
                      ...f,
                      event_type,
                      blocks_dispatch: event_type === 'production_closure' ? true : f.blocks_dispatch,
                    }));
                  }}
                  style={INPUT_STYLE}
                >
                  {Object.entries(EVENT_TYPE_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
                <label style={{ fontSize: 11, color: theme.textDim }}>Title</label>
                <input
                  required
                  value={form.title}
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                  style={INPUT_STYLE}
                  maxLength={120}
                />
                <label style={{ fontSize: 11, color: theme.textDim }}>Start</label>
                <input
                  type="date"
                  required
                  value={form.start_date}
                  onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                  style={INPUT_STYLE}
                />
                <label style={{ fontSize: 11, color: theme.textDim }}>End</label>
                <input
                  type="date"
                  required={form.event_type === 'production_closure' || form.blocks_dispatch}
                  value={form.end_date}
                  onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                  style={INPUT_STYLE}
                />
                <label style={{ fontSize: 11, color: theme.textDim }}>SKU (optional)</label>
                <input
                  value={form.item_sku}
                  onChange={e => setForm(f => ({ ...f, item_sku: e.target.value }))}
                  style={INPUT_STYLE}
                  placeholder="Matches ERP item SKU when relevant"
                />
                <label style={{ fontSize: 11, color: theme.textDim }}>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  style={{ ...INPUT_STYLE, minHeight: 64, resize: 'vertical' }}
                />
                <label style={{ fontSize: 11, color: theme.textDim }}>Status</label>
                <select
                  value={form.status}
                  onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  style={INPUT_STYLE}
                >
                  <option value="planned">Planned</option>
                  <option value="done">Done</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                {(form.event_type === 'production_closure' || form.blocks_dispatch) && (
                  <div style={{ fontSize: 11, color: theme.red, lineHeight: 1.4 }}>
                    This event blocks new job dispatch for its date range. Prints already
                    running are not cancelled.
                  </div>
                )}
                {form.event_type !== 'production_closure' && (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: theme.textMuted }}>
                    <input
                      type="checkbox"
                      checked={form.blocks_dispatch}
                      onChange={e => setForm(f => ({ ...f, blocks_dispatch: e.target.checked }))}
                    />
                    Also block dispatch (rare)
                  </label>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button type="submit" disabled={submitting} style={{ ...BTN_PRIMARY, flex: 1 }}>
                    {submitting ? 'Saving…' : (editingId ? 'Save' : 'Create')}
                  </button>
                  <button
                    type="button"
                    style={BTN_SECONDARY}
                    onClick={() => { setShowForm(false); setEditingId(null); }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : !selectedDay ? (
              <EmptyState
                title="Pick a day"
                hint="Click a cell to see events, or double-click to create one."
              />
            ) : selectedItems.length === 0 ? (
              <EmptyState
                title="Nothing on this day"
                hint="Create a planned event, or wait for ERP/job history to appear here."
                actionLabel="New event"
              >
                <button type="button" style={{ ...BTN_PRIMARY, marginTop: 10 }} onClick={() => openCreate(selectedDay)}>
                  New event
                </button>
              </EmptyState>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {selectedItems.map((ev, i) => {
                  const c = eventColors(ev.event_type);
                  const planned = ev.kind === 'planned';
                  return (
                    <div
                      key={`${ev.kind}-${ev.id}-${i}`}
                      style={{
                        border: `1px solid ${theme.border}`,
                        borderRadius: 10,
                        padding: 10,
                        background: theme.panel,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                          color: c.text, textTransform: 'uppercase',
                        }}>
                          {planned ? (EVENT_TYPE_LABELS[ev.event_type] || ev.event_type) : (ev.source || 'history')}
                        </span>
                        {planned && (
                          <span style={{ fontSize: 10, color: theme.textFaint }}>{ev.status}</span>
                        )}
                      </div>
                      <div style={{ color: theme.text, fontWeight: 600, fontSize: 13, marginTop: 4 }}>
                        {ev.title}
                      </div>
                      {ev.notes && (
                        <div style={{ color: theme.textDim, fontSize: 12, marginTop: 4 }}>{ev.notes}</div>
                      )}
                      {planned && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          <button type="button" style={{ ...BTN_SECONDARY, padding: '4px 10px' }} onClick={() => openEdit(ev)}>
                            Edit
                          </button>
                          {ev.status === 'planned' && (
                            <button type="button" style={{ ...BTN_SECONDARY, padding: '4px 10px' }} onClick={() => markDone(ev)}>
                              Mark done
                            </button>
                          )}
                          <button
                            type="button"
                            style={{ ...BTN_SECONDARY, padding: '4px 10px', color: theme.red }}
                            onClick={() => handleDelete(ev)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" style={{ ...BTN_SECONDARY, marginTop: 4 }} onClick={() => openCreate(selectedDay)}>
                  Add event this day
                </button>
              </div>
            )}

            <div style={{ marginTop: 16, fontSize: 11, color: theme.textFaint, lineHeight: 1.4 }}>
              History chips come from jobs, sales, stock receipts, and work orders.
              They are read-only. Manage inventory and sales in the{' '}
              <Link to="/erp" style={{ color: theme.indigo }}>ERP</Link>.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
