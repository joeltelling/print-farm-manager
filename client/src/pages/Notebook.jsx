import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { useToast } from '../useToast';
import { useConfirm } from '../useConfirm';
import {
  theme, PANEL_STYLE, INPUT_STYLE, BTN_PRIMARY, BTN_SECONDARY,
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

function wordCount(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function formatDate(ms) {
  if (ms == null) return '';
  return new Date(ms).toLocaleString('es-ES', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function Notebook() {
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();
  const [tab, setTab] = useState('notes'); // notes | trash
  const [pages, setPages] = useState([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [accent, setAccent] = useState('lime');
  const [saveState, setSaveState] = useState('idle'); // idle | dirty | saving | saved
  const [loading, setLoading] = useState(true);
  const [listOpen, setListOpen] = useState(true);
  const saveTimer = useRef(null);
  const selectedIdRef = useRef(null);
  const draftRef = useRef({ title: '', body: '', accent: 'lime' });

  selectedIdRef.current = selectedId;
  draftRef.current = { title, body, accent };

  const loadPages = useCallback(async (opts = {}) => {
    const trashed = (opts.tab ?? tab) === 'trash' ? '1' : '0';
    const q = opts.q !== undefined ? opts.q : query;
    const params = new URLSearchParams({ trashed });
    if (q.trim()) params.set('q', q.trim());
    try {
      const res = await fetch(`/api/notebook/pages?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setPages(data.pages || []);
      setLoading(false);
      return data.pages || [];
    } catch {
      setLoading(false);
      return [];
    }
  }, [tab, query]);

  useEffect(() => {
    loadPages().then(list => {
      if (list.length && selectedIdRef.current == null) {
        selectPage(list[0]);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function selectPage(page) {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      flushSave();
    }
    setSelectedId(page.id);
    setTitle(page.title);
    setBody(page.body || '');
    setAccent(page.accent || 'lime');
    setSaveState('saved');
    setListOpen(false);
  }

  async function flushSave() {
    const id = selectedIdRef.current;
    if (!id || tab === 'trash') return;
    const draft = draftRef.current;
    const t = draft.title.trim();
    if (!t) return;
    setSaveState('saving');
    const res = await fetch(`/api/notebook/pages/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t, body: draft.body, accent: draft.accent }),
    });
    if (!res.ok) {
      setSaveState('dirty');
      showToast('Guardar nota falló: ' + await readError(res), 'error');
      return;
    }
    const updated = await res.json();
    setPages(prev => prev.map(p => (p.id === updated.id ? updated : p)));
    setSaveState('saved');
  }

  function scheduleSave() {
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      flushSave();
    }, 400);
  }

  function onTitleChange(e) {
    setTitle(e.target.value);
    scheduleSave();
  }

  function onBodyChange(e) {
    setBody(e.target.value);
    scheduleSave();
  }

  function onAccentChange(a) {
    setAccent(a);
    draftRef.current = { ...draftRef.current, accent: a };
    setSaveState('dirty');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      flushSave();
    }, 400);
  }

  async function createPage() {
    const res = await fetch('/api/notebook/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Nota nueva', body: '', accent: 'lime' }),
    });
    if (!res.ok) {
      showToast('Crear nota falló: ' + await readError(res), 'error');
      return;
    }
    const page = await res.json();
    setTab('notes');
    const list = await loadPages({ tab: 'notes' });
    const found = list.find(p => p.id === page.id) || page;
    selectPage(found);
  }

  async function trashPage() {
    if (!selectedId) return;
    const ok = await confirm({
      title: 'A la papelera',
      message: `Se moverá "${title}" a la papelera.`,
      confirmLabel: 'A la papelera',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/notebook/pages/${selectedId}/trash`, { method: 'POST' });
    if (!res.ok) {
      showToast('Papelera falló: ' + await readError(res), 'error');
      return;
    }
    setSelectedId(null);
    setTitle('');
    setBody('');
    const list = await loadPages();
    if (list[0]) selectPage(list[0]);
    showToast('Nota en papelera');
  }

  async function restorePage() {
    if (!selectedId) return;
    const res = await fetch(`/api/notebook/pages/${selectedId}/restore`, { method: 'POST' });
    if (!res.ok) {
      showToast('Restaurar falló: ' + await readError(res), 'error');
      return;
    }
    showToast('Nota restaurada');
    setSelectedId(null);
    setTab('notes');
    const list = await loadPages({ tab: 'notes' });
    const restored = list.find(p => p.id === selectedId);
    if (restored) selectPage(restored);
    else if (list[0]) selectPage(list[0]);
  }

  async function permanentDelete() {
    if (!selectedId) return;
    const ok = await confirm({
      title: 'Borrar definitivo',
      message: `Se eliminará "${title}" de forma permanente. Esta acción no se puede deshacer.`,
      confirmLabel: 'Borrar',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/notebook/pages/${selectedId}`, { method: 'DELETE' });
    if (!res.ok) {
      showToast('Borrar falló: ' + await readError(res), 'error');
      return;
    }
    setSelectedId(null);
    setTitle('');
    setBody('');
    await loadPages();
    showToast('Nota eliminada');
  }

  function exportTxt() {
    const blob = new Blob([`${title}\n\n${body}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || 'nota').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function runSearch(e) {
    e.preventDefault();
    loadPages();
  }

  const selected = useMemo(
    () => pages.find(p => p.id === selectedId) || null,
    [pages, selectedId],
  );

  const accentHex = ACCENT_HEX[accent] || theme.lime;
  const words = wordCount(body);
  const chars = (body || '').length;

  const saveLabel = {
    idle: '',
    dirty: 'Sin guardar',
    saving: 'Guardando...',
    saved: 'Guardado',
  }[saveState];

  return (
    <div className="nb-root" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <style>{`
        .nb-layout {
          display: grid;
          grid-template-columns: 280px 1fr;
          gap: 14px;
          flex: 1;
          min-height: 0;
        }
        .nb-list-panel {
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
        }
        .nb-paper {
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
          background:
            linear-gradient(${hexAlpha(theme.lime, 0.06)} 1px, transparent 1px),
            linear-gradient(90deg, ${hexAlpha(theme.lime, 0.06)} 1px, transparent 1px),
            ${theme.panel};
          background-size: 28px 28px, 28px 28px, auto;
          border: 1px solid ${theme.border};
          border-radius: ${theme.radius}px;
          box-shadow: ${theme.shadow};
          position: relative;
        }
        .nb-paper::before {
          content: '';
          position: absolute;
          top: 0;
          right: 22px;
          width: 18px;
          height: 36px;
          background: ${theme.lime};
          border-radius: 0 0 4px 4px;
          box-shadow: ${theme.glowLime};
          opacity: 0.85;
          pointer-events: none;
        }
        .nb-title-input {
          background: transparent;
          border: none;
          border-bottom: 2px solid ${hexAlpha(theme.lime, 0.45)};
          color: ${theme.textBright};
          font-size: 26px;
          font-weight: 800;
          letter-spacing: -0.02em;
          padding: 4px 0 8px;
          width: 100%;
          outline: none;
          font-family: inherit;
        }
        .nb-body-input {
          flex: 1;
          background: transparent;
          border: none;
          color: ${theme.textStrong};
          font-size: 15px;
          line-height: 1.65;
          resize: none;
          outline: none;
          font-family: inherit;
          min-height: 200px;
          width: 100%;
        }
        .nb-body-input::placeholder { color: ${theme.textFaint}; }
        .nb-page-item.is-active {
          background: ${theme.hover};
          border-color: ${theme.borderStrong};
        }
        @media (max-width: 600px) {
          .nb-layout { grid-template-columns: 1fr; }
          .nb-list-panel.is-collapsed { display: none; }
          .nb-paper.is-hidden-mobile { display: none; }
        }
        @media print {
          body * { visibility: hidden !important; }
          .nb-print-area, .nb-print-area * { visibility: visible !important; }
          .nb-print-area {
            position: absolute !important;
            left: 0; top: 0; width: 100%;
            background: white !important;
            color: black !important;
            box-shadow: none !important;
            border: none !important;
          }
          .nb-print-area::before { display: none !important; }
          .nb-no-print { display: none !important; }
        }
      `}</style>

      <div className="nb-no-print">
        <PageHeader
          title="Bloc técnico"
          subtitle="Apuntes del operador con papel cuadriculado CoMa"
          badge="WORKSPACE"
          badgeColor={theme.lime}
          actions={
            <>
              <button
                type="button"
                className="nb-mobile-toggle"
                style={{ ...BTN_SECONDARY, display: 'none' }}
                onClick={() => setListOpen(o => !o)}
              >
                {listOpen ? 'Papel' : 'Lista'}
              </button>
              <style>{`
                @media (max-width: 600px) {
                  .nb-mobile-toggle { display: inline-flex !important; }
                }
              `}</style>
              {tab === 'notes' && (
                <button type="button" style={BTN_PRIMARY} onClick={createPage}>
                  Nota nueva
                </button>
              )}
            </>
          }
        />
      </div>

      <div className="nb-layout">
        <div className={`nb-list-panel nb-no-print${listOpen ? '' : ' is-collapsed'}`} style={{ ...PANEL_STYLE, padding: 12 }}>
          <form onSubmit={runSearch} style={{ marginBottom: 10 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar notas..."
              style={{ ...INPUT_STYLE, fontSize: 12.5 }}
            />
          </form>

          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {[
              { id: 'notes', label: 'Notas' },
              { id: 'trash', label: 'Papelera' },
            ].map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => { setTab(t.id); setSelectedId(null); }}
                style={{
                  flex: 1,
                  padding: '7px 8px',
                  borderRadius: 9,
                  border: `1px solid ${tab === t.id ? 'transparent' : theme.border}`,
                  background: tab === t.id ? theme.lime : theme.cardAlt,
                  color: tab === t.id ? '#0a0a0a' : theme.textMuted,
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loading ? (
              <div style={{ color: theme.textMuted, fontSize: 12 }}>Cargando...</div>
            ) : pages.length === 0 ? (
              <EmptyState
                title={tab === 'trash' ? 'Papelera vacía' : 'Sin notas'}
                hint={tab === 'trash' ? 'Las notas enviadas a papelera aparecen aquí.' : 'Pulsa Nota nueva para empezar.'}
              />
            ) : (
              pages.map(page => {
                const a = ACCENT_HEX[page.accent] || theme.lime;
                return (
                  <button
                    key={page.id}
                    type="button"
                    className={`nb-page-item${selectedId === page.id ? ' is-active' : ''}`}
                    onClick={() => selectPage(page)}
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px',
                      borderRadius: 10,
                      border: `1px solid ${theme.borderSoft}`,
                      background: theme.card,
                      cursor: 'pointer',
                      borderLeft: `3px solid ${a}`,
                      fontFamily: 'inherit',
                    }}
                  >
                    <div style={{
                      fontWeight: 600, fontSize: 13, color: theme.text,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {page.title}
                    </div>
                    <div style={{
                      marginTop: 4, fontFamily: theme.mono, fontSize: 10, color: theme.textDim,
                    }}>
                      {formatDate(page.trashed_at || page.updated_at)}
                    </div>
                    {page.body ? (
                      <div style={{
                        marginTop: 4, fontSize: 11.5, color: theme.textFaint,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {page.body}
                      </div>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className={`nb-paper nb-print-area${!listOpen || selectedId ? '' : ' is-hidden-mobile'}`}>
          {!selectedId ? (
            <div style={{ padding: 28, color: theme.textMuted }}>
              Selecciona o crea una nota.
            </div>
          ) : (
            <>
              <div style={{ padding: '18px 22px 8px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
                <div className="nb-no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {ACCENT_OPTIONS.map(a => (
                      <button
                        key={a}
                        type="button"
                        title={a}
                        disabled={tab === 'trash'}
                        onClick={() => onAccentChange(a)}
                        style={{
                          width: 16, height: 16, borderRadius: 999, padding: 0,
                          background: ACCENT_HEX[a],
                          border: accent === a ? `2px solid ${theme.textBright}` : '2px solid transparent',
                          cursor: tab === 'trash' ? 'default' : 'pointer',
                          opacity: tab === 'trash' ? 0.5 : 1,
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {tab === 'notes' ? (
                      <>
                        <button type="button" style={{ ...BTN_SECONDARY, padding: '6px 10px', fontSize: 11 }} onClick={exportTxt}>
                          .txt
                        </button>
                        <button type="button" style={{ ...BTN_SECONDARY, padding: '6px 10px', fontSize: 11 }} onClick={() => window.print()}>
                          Imprimir
                        </button>
                        <button type="button" style={{ ...BTN_SECONDARY, padding: '6px 10px', fontSize: 11, color: theme.red }} onClick={trashPage}>
                          A la papelera
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" style={{ ...BTN_PRIMARY, padding: '6px 10px', fontSize: 11 }} onClick={restorePage}>
                          Restaurar
                        </button>
                        <button type="button" style={{ ...BTN_SECONDARY, padding: '6px 10px', fontSize: 11, color: theme.red }} onClick={permanentDelete}>
                          Borrar definitivo
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <input
                  className="nb-title-input"
                  value={title}
                  onChange={onTitleChange}
                  disabled={tab === 'trash'}
                  maxLength={120}
                  style={{ borderBottomColor: hexAlpha(accentHex, 0.55) }}
                />

                <textarea
                  className="nb-body-input"
                  value={body}
                  onChange={onBodyChange}
                  disabled={tab === 'trash'}
                  placeholder="Escribe aquí..."
                />
              </div>

              <div
                className="nb-no-print"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 18px',
                  borderTop: `1px solid ${theme.borderSoft}`,
                  background: hexAlpha(theme.shell, 0.55),
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ ...CHIP_STYLE }}>
                  {words} palabras · {chars} caracteres
                </span>
                {tab === 'notes' && saveLabel && (
                  <span style={{ ...CAPTION_STYLE, color: saveState === 'dirty' ? theme.amber : theme.lime }}>
                    {saveLabel}
                  </span>
                )}
                {selected && (
                  <span style={{ marginLeft: 'auto', fontFamily: theme.mono, fontSize: 10, color: theme.textDim }}>
                    {formatDate(selected.updated_at)}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {toastEl}
      {confirmModal}
    </div>
  );
}
