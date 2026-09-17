import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Card from '../../components/Card';
import { usd } from './format';
import {
  ErpShell, Table, theme, INPUT_STYLE, BTN_PRIMARY, labelStyle, formRow, btnSecondary, apiJson,
  useErpFeedback,
} from './shared';

// Presupuesto (quote) -> Albaran (delivery note) -> Factura (invoice). Simple-docs
// scope: sequential PRE-/ALB-/FAC- numbering, per-line tax_rate, no VeriFactu/SII.
// See docs/erp/README.md "Sales documents" and server/erp/salesDocs.js.

const STATUS_COLOR = {
  draft: theme.textMuted,
  confirmed: theme.lime,
  cancelled: theme.red,
};

const NEXT_TYPE = { quote: 'delivery', delivery: 'invoice' };
const TYPE_LABEL = { quote: 'Presupuesto', delivery: 'Albaran', invoice: 'Factura' };
const TYPE_PATH = { quote: '/erp/quotes', delivery: '/erp/delivery-notes', invoice: '/erp/invoices' };

function StatusBadge({ status }) {
  return (
    <span style={{
      fontFamily: theme.mono, fontSize: 11, fontWeight: 700, padding: '2px 8px',
      borderRadius: 6, color: STATUS_COLOR[status] || theme.textMuted,
      background: `${STATUS_COLOR[status] || theme.textMuted}22`,
    }}>
      {status}
    </span>
  );
}

// ---------- Customers ----------

const emptyCustomer = { name: '', tax_id: '', email: '', phone: '', address: '', city: '', postal_code: '', country: '', notes: '' };

export function CustomersPage() {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(emptyCustomer);
  const [editingId, setEditingId] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();

  const load = () => {
    const qs = q ? `?search=${encodeURIComponent(q)}` : '';
    fetch(`/api/erp/customers${qs}`).then(r => r.json()).then(setRows).catch(() => setErr('Failed to load customers'));
  };
  useEffect(() => { load(); }, [q]);

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      if (editingId) {
        await apiJson(`/api/erp/customers/${editingId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
        });
        showToast('Cliente actualizado');
      } else {
        await apiJson('/api/erp/customers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
        });
        showToast('Cliente creado');
      }
      setForm(emptyCustomer);
      setEditingId(null);
      load();
    } catch (ex) {
      setErr(ex.message);
      showToast(`Error: ${ex.message}`, 'error');
    }
  };

  const editRow = (r) => {
    setEditingId(r.id);
    setForm({
      name: r.name || '', tax_id: r.tax_id || '', email: r.email || '', phone: r.phone || '',
      address: r.address || '', city: r.city || '', postal_code: r.postal_code || '', country: r.country || '', notes: r.notes || '',
    });
  };

  return (
    <ErpShell title="Clientes" subtitle="Base de clientes para presupuestos, albaranes y facturas.">
      <Card title={editingId ? `Editar cliente #${editingId}` : 'Nuevo cliente'}>
        <form onSubmit={save} style={formRow}>
          <div><label style={labelStyle}>Nombre</label><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>NIF/CIF</label><input value={form.tax_id} onChange={e => setForm({ ...form, tax_id: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Email</label><input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Telefono</label><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Direccion</label><input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Ciudad</label><input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>C.P.</label><input value={form.postal_code} onChange={e => setForm({ ...form, postal_code: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Pais</label><input value={form.country} onChange={e => setForm({ ...form, country: e.target.value })} style={INPUT_STYLE} /></div>
          <button type="submit" style={BTN_PRIMARY}>{editingId ? 'Guardar' : 'Crear'}</button>
          {editingId && <button type="button" onClick={() => { setEditingId(null); setForm(emptyCustomer); }} style={btnSecondary}>Cancelar</button>}
        </form>
        {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{err}</div>}
      </Card>
      <Card title="Listado" style={{ marginTop: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nombre o NIF" style={{ ...INPUT_STYLE, maxWidth: 280, marginBottom: 10 }} />
        <Table
          columns={[
            { key: 'name', label: 'Nombre' },
            { key: 'tax_id', label: 'NIF/CIF' },
            { key: 'email', label: 'Email' },
            { key: 'city', label: 'Ciudad' },
            { key: 'edit', label: '', render: r => <button type="button" onClick={() => editRow(r)} style={{ ...btnSecondary, padding: '4px 10px' }}>Editar</button> },
          ]}
          rows={rows}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

// ---------- Sales document lists (Presupuestos / Albaranes / Facturas) ----------

function SalesDocList({ docType, title, subtitle }) {
  const [rows, setRows] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [newCustomerId, setNewCustomerId] = useState('');
  const [err, setErr] = useState('');
  const navigate = useNavigate();
  const { showToast, feedbackEl } = useErpFeedback();

  const load = () => {
    const qs = new URLSearchParams({ doc_type: docType, ...(statusFilter ? { status: statusFilter } : {}) });
    fetch(`/api/erp/sales-docs?${qs}`).then(r => r.json()).then(setRows).catch(() => setErr('Failed to load'));
  };
  useEffect(() => { load(); }, [docType, statusFilter]);
  useEffect(() => { fetch('/api/erp/customers').then(r => r.json()).then(setCustomers).catch(() => {}); }, []);

  const createNew = async () => {
    if (!newCustomerId) return showToast('Elige un cliente primero', 'warning');
    setErr('');
    try {
      const created = await apiJson('/api/erp/sales-docs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doc_type: docType,
          customer_id: Number(newCustomerId),
          lines: [{ description: 'Nueva linea', qty: 1, unit_price: 0, tax_rate: 21 }],
        }),
      });
      navigate(`/erp/sales-docs/${created.id}`);
    } catch (ex) {
      setErr(ex.message);
      showToast(`Error: ${ex.message}`, 'error');
    }
  };

  return (
    <ErpShell title={title} subtitle={subtitle}>
      <Card title="Nuevo">
        <div style={formRow}>
          <div>
            <label style={labelStyle}>Cliente</label>
            <select value={newCustomerId} onChange={e => setNewCustomerId(e.target.value)} style={INPUT_STYLE}>
              <option value="">Selecciona cliente...</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <button type="button" onClick={createNew} style={BTN_PRIMARY}>Crear borrador</button>
        </div>
        {customers.length === 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: theme.textDim }}>
            No hay clientes todavia. <Link to="/erp/customers" style={{ color: theme.violetSoft }}>Crea uno primero.</Link>
          </div>
        )}
        {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{err}</div>}
      </Card>
      <Card title="Filtro" style={{ marginTop: 12 }}>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ ...INPUT_STYLE, maxWidth: 220 }}>
          <option value="">Todos los estados</option>
          <option value="draft">Borrador</option>
          <option value="confirmed">Confirmado</option>
          <option value="cancelled">Cancelado</option>
        </select>
      </Card>
      <Card title="Listado" style={{ marginTop: 12 }}>
        <Table
          columns={[
            { key: 'doc_number', label: 'Numero', render: r => <Link to={`/erp/sales-docs/${r.id}`} style={{ color: theme.violetSoft }}>{r.doc_number}</Link> },
            { key: 'customer_name', label: 'Cliente' },
            { key: 'issue_date', label: 'Fecha' },
            { key: 'status', label: 'Estado', render: r => <StatusBadge status={r.status} /> },
            { key: 'total', label: 'Total', render: r => usd(r.total) },
            { key: 'open', label: '', render: r => <Link to={`/erp/sales-docs/${r.id}`} style={{ ...btnSecondary, padding: '4px 10px', textDecoration: 'none', display: 'inline-block' }}>Abrir</Link> },
          ]}
          rows={rows}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function QuotesPage() {
  return <SalesDocList docType="quote" title="Presupuestos" subtitle="Ofertas a clientes. Al confirmar, se pueden convertir en Albaran." />;
}
export function DeliveryNotesPage() {
  return <SalesDocList docType="delivery" title="Albaranes" subtitle="Entregas a clientes. Al confirmar, se pueden convertir en Factura." />;
}
export function InvoicesPage() {
  return <SalesDocList docType="invoice" title="Facturas" subtitle="Documentos de cobro. Numeracion secuencial simple (sin VeriFactu/SII)." />;
}

// ---------- Sales document detail (edit lines, confirm, convert, cancel, PDF) ----------

const emptyLine = { description: '', sku: '', qty: 1, unit_price: 0, tax_rate: 21 };

export function SalesDocDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [doc, setDoc] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [lines, setLines] = useState([]);
  const [notes, setNotes] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [err, setErr] = useState('');
  const { showToast, confirm, feedbackEl } = useErpFeedback();

  const load = () => {
    fetch(`/api/erp/sales-docs/${id}`).then(r => r.json()).then(d => {
      setDoc(d);
      setLines(d.lines || []);
      setNotes(d.notes || '');
      setCustomerId(String(d.customer_id || ''));
      setIssueDate(d.issue_date || '');
    }).catch(() => setErr('Failed to load document'));
  };
  useEffect(() => { load(); }, [id]);
  useEffect(() => { fetch('/api/erp/customers').then(r => r.json()).then(setCustomers).catch(() => {}); }, []);

  if (!doc) return <ErpShell title="Documento">{err && <div style={{ color: theme.red }}>{err}</div>}</ErpShell>;

  const isDraft = doc.status === 'draft';
  const nextType = NEXT_TYPE[doc.doc_type];

  const setLineField = (i, field, value) => {
    setLines(ls => ls.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  };
  const addLine = () => setLines(ls => [...ls, { ...emptyLine }]);
  const removeLine = (i) => setLines(ls => ls.filter((_, idx) => idx !== i));

  const previewTotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_price) || 0) * (1 + (Number(l.tax_rate) || 0) / 100), 0);

  const save = async () => {
    setErr('');
    try {
      await apiJson(`/api/erp/sales-docs/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId ? Number(customerId) : undefined,
          issue_date: issueDate || undefined,
          notes,
          lines: lines.map(l => ({
            description: l.description, sku: l.sku || null, qty: Number(l.qty), unit_price: Number(l.unit_price),
            tax_rate: Number(l.tax_rate), job_id: l.job_id, posting_id: l.posting_id,
          })),
        }),
      });
      showToast('Guardado');
      load();
    } catch (ex) {
      setErr(ex.message);
      showToast(`Error al guardar: ${ex.message}`, 'error');
    }
  };

  const doConfirm = async () => {
    const ok = await confirm({
      title: 'Confirmar documento',
      message: `Confirmar ${TYPE_LABEL[doc.doc_type]} ${doc.doc_number}? Ya no se podra editar.`,
      confirmLabel: 'Confirmar',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/sales-docs/${id}/confirm`, { method: 'POST' });
      showToast('Documento confirmado');
      load();
    } catch (ex) {
      showToast(`Error: ${ex.message}`, 'error');
    }
  };

  const doCancel = async () => {
    const ok = await confirm({
      title: 'Cancelar documento',
      message: `Cancelar ${TYPE_LABEL[doc.doc_type]} ${doc.doc_number}? Esta accion no se puede revertir.`,
      confirmLabel: 'Cancelar documento',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/sales-docs/${id}/cancel`, { method: 'POST' });
      showToast('Documento cancelado');
      load();
    } catch (ex) {
      showToast(`Error: ${ex.message}`, 'error');
    }
  };

  const doConvert = async () => {
    if (!nextType) return;
    try {
      const created = await apiJson(`/api/erp/sales-docs/${id}/convert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: nextType }),
      });
      showToast(`${TYPE_LABEL[nextType]} ${created.doc_number} creado`);
      navigate(`/erp/sales-docs/${created.id}`);
    } catch (ex) {
      showToast(`Error al convertir: ${ex.message}`, 'error');
    }
  };

  return (
    <ErpShell
      title={`${TYPE_LABEL[doc.doc_type]} ${doc.doc_number}`}
      badge={<StatusBadge status={doc.status} />}
      subtitle={doc.source_doc_id ? `Generado a partir del documento #${doc.source_doc_id}` : undefined}
      actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href={`/api/erp/sales-docs/${id}/pdf`} target="_blank" rel="noreferrer" style={{ ...btnSecondary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Descargar PDF</a>
          {isDraft && <button type="button" onClick={save} style={BTN_PRIMARY}>Guardar</button>}
          {isDraft && <button type="button" onClick={doConfirm} style={{ ...btnSecondary, color: theme.lime }}>Confirmar</button>}
          {doc.status === 'confirmed' && nextType && (
            <button type="button" onClick={doConvert} style={BTN_PRIMARY}>Convertir a {TYPE_LABEL[nextType]}</button>
          )}
          {doc.status !== 'cancelled' && <button type="button" onClick={doCancel} style={{ ...btnSecondary, color: theme.red }}>Cancelar</button>}
        </div>
      }
    >
      <Card title="Cabecera">
        <div style={formRow}>
          <div>
            <label style={labelStyle}>Cliente</label>
            <select disabled={!isDraft} value={customerId} onChange={e => setCustomerId(e.target.value)} style={INPUT_STYLE}>
              <option value="">-</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Fecha</label>
            <input disabled={!isDraft} type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={INPUT_STYLE} />
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <label style={labelStyle}>Notas</label>
            <input disabled={!isDraft} value={notes} onChange={e => setNotes(e.target.value)} style={INPUT_STYLE} />
          </div>
        </div>
      </Card>

      <Card title="Lineas" style={{ marginTop: 12 }}>
        <Table
          columns={[
            { key: 'description', label: 'Descripcion', render: (r, i) => isDraft
              ? <input value={r.description} onChange={e => setLineField(i, 'description', e.target.value)} style={{ ...INPUT_STYLE, width: 220 }} />
              : r.description },
            { key: 'sku', label: 'SKU', render: (r, i) => isDraft
              ? <input value={r.sku || ''} onChange={e => setLineField(i, 'sku', e.target.value)} style={{ ...INPUT_STYLE, width: 110 }} />
              : (r.sku || '-') },
            { key: 'qty', label: 'Cantidad', render: (r, i) => isDraft
              ? <input type="number" step="any" value={r.qty} onChange={e => setLineField(i, 'qty', e.target.value)} style={{ ...INPUT_STYLE, width: 80 }} />
              : r.qty },
            { key: 'unit_price', label: 'Precio', render: (r, i) => isDraft
              ? <input type="number" step="any" value={r.unit_price} onChange={e => setLineField(i, 'unit_price', e.target.value)} style={{ ...INPUT_STYLE, width: 90 }} />
              : usd(r.unit_price) },
            { key: 'tax_rate', label: 'IVA %', render: (r, i) => isDraft
              ? <input type="number" step="any" value={r.tax_rate} onChange={e => setLineField(i, 'tax_rate', e.target.value)} style={{ ...INPUT_STYLE, width: 70 }} />
              : `${r.tax_rate}%` },
            { key: 'line_total', label: 'Subtotal', render: r => usd((Number(r.qty) || 0) * (Number(r.unit_price) || 0)) },
            { key: 'del', label: '', render: (r, i) => isDraft
              ? <button type="button" onClick={() => removeLine(i)} style={{ ...btnSecondary, padding: '4px 10px', color: theme.red }}>Quitar</button>
              : null },
          ]}
          rows={lines}
          rowKey={(r, i) => r.id ?? i}
        />
        {isDraft && (
          <button type="button" onClick={addLine} style={{ ...btnSecondary, marginTop: 10 }}>+ Anadir linea</button>
        )}
        <div style={{ marginTop: 14, textAlign: 'right', color: theme.textMuted, fontSize: 13, lineHeight: 1.8 }}>
          {isDraft ? (
            <div>Total estimado (guarda para confirmar): <strong style={{ color: theme.lime, fontSize: 16 }}>{usd(previewTotal)}</strong></div>
          ) : (
            <>
              <div>Subtotal: {usd(doc.subtotal)}</div>
              <div>IVA: {usd(doc.tax_total)}</div>
              <div style={{ fontSize: 16 }}>Total: <strong style={{ color: theme.lime }}>{usd(doc.total)}</strong></div>
            </>
          )}
        </div>
      </Card>
      {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{err}</div>}
      <div style={{ marginTop: 10 }}>
        <Link to={TYPE_PATH[doc.doc_type] || '/erp/sales'} style={{ color: theme.textDim, fontSize: 12.5 }}>&larr; Volver al listado</Link>
      </div>
      {feedbackEl}
    </ErpShell>
  );
}
