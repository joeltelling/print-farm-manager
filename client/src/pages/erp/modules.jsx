import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Card from '../../components/Card';
import BarChart from '../../components/BarChart';
import DonutChart from '../../components/DonutChart';
import { theme as appTheme } from '../../theme';
import { qrSvgDataUrl } from './qr';
import DualBarChart from './DualBarChart';
import { usd, qty6, wac4, min3, fmtQty } from './format';
import {
  ErpShell, Table, theme, INPUT_STYLE, BTN_PRIMARY, labelStyle, formRow, btnSecondary, apiJson,
  useErpFeedback,
} from './shared';

export function Dashboard() {
  const [data, setData] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [err, setErr] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();

  const load = () => {
    fetch('/api/erp/dashboard')
      .then(r => r.json())
      .then(setData)
      .catch(() => setErr('Dashboard failed to load'));
  };
  useEffect(() => { load(); }, []);

  const sync = async () => {
    setSyncing(true);
    setErr('');
    try {
      await apiJson('/api/erp/sync', { method: 'POST' });
      load();
      showToast('Shopfloor sync completed');
    } catch (ex) {
      setErr(ex.message);
      showToast(`Sync failed: ${ex.message}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const c = data?.counts || {};
  const inv = data?.inventory || {};
  const sf = data?.shopfloor || {};
  const attention = data?.sync?.needs_attention || [];

  return (
    <ErpShell title="ERP Dashboard" subtitle="Live production ERP wired to shopfloor printers, projects, and parts.">
      <div style={{ marginBottom: 14 }}>
        <button type="button" onClick={sync} disabled={syncing} style={BTN_PRIMARY}>
          {syncing ? 'Syncing...' : 'Sync from shopfloor'}
        </button>
      </div>
      {err && <div style={{ color: theme.red, marginBottom: 10, fontSize: 13 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'Products', sub: '= projects', value: c.products ?? '-', color: theme.lime },
          { label: 'Components', sub: '= parts', value: c.components ?? '-', color: theme.violetSoft },
          { label: 'Raw materials', sub: 'filaments + buys', value: c.raw ?? '-', color: theme.teal },
          { label: 'Manufactured', sub: 'sourcing', value: c.manufactured ?? '-', color: theme.accent },
          { label: 'Outsource', sub: 'sourcing', value: c.outsource ?? '-', color: theme.orange },
          { label: 'Machines', sub: `${c.printers_linked || 0} printers linked`, value: c.machines ?? '-', color: theme.lime },
          { label: 'Open WOs', sub: 'shopfloor + ERP', value: c.open_wo ?? '-', color: theme.orange },
          { label: 'Pending postings', sub: 'awaiting confirm', value: c.pending_postings ?? 0, color: theme.orange, to: '/erp/postings' },
          { label: 'Stock value', sub: `${inv.sku_lines || 0} lines`, value: inv.total_value != null ? usd(inv.total_value) : '-', color: theme.teal },
          { label: 'Sales today', sub: 'orders', value: c.sales_today ?? '-', color: theme.violetSoft },
        ].map(k => (
          <Card key={k.label}>
            {k.to ? (
              <Link to={k.to} style={{ textDecoration: 'none' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: theme.textFaint, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{k.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: k.color, marginTop: 6 }}>{k.value}</div>
                <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>{k.sub}</div>
              </Link>
            ) : (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: theme.textFaint, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{k.label}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: k.color, marginTop: 6 }}>{k.value}</div>
                <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>{k.sub}</div>
              </>
            )}
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 12 }}>
        <Card title="Shopfloor link">
          <div style={{ color: theme.textMuted, fontSize: 13, lineHeight: 1.7 }}>
            Projects: <strong style={{ color: theme.text }}>{sf.projects ?? '-'}</strong> (ERP products)<br />
            Parts: <strong style={{ color: theme.text }}>{sf.parts ?? '-'}</strong> (ERP components)<br />
            Printers: <strong style={{ color: theme.text }}>{sf.active_printers ?? '-'}</strong> active / {sf.printers ?? '-'} total<br />
            Last sync created: machines {data?.sync?.created?.machines || 0}, products {data?.sync?.created?.products || 0},
            components {data?.sync?.created?.components || 0}, raw {data?.sync?.created?.raw_materials || 0}
          </div>
        </Card>
        <Card title="Needs ERP data">
          {attention.length === 0 ? (
            <div style={{ color: theme.textDim, fontSize: 13 }}>All linked masters look complete.</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, color: theme.textMuted, fontSize: 13, lineHeight: 1.55 }}>
              {attention.slice(0, 12).map((a, i) => (
                <li key={`${a.kind}-${a.id || a.sku}-${i}`}>
                  <strong style={{ color: theme.orange }}>{a.kind}</strong> {a.name || a.sku}: {a.reason}
                </li>
              ))}
            </ul>
          )}
          {attention.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Link to="/erp/items" style={{ color: theme.violetSoft, fontSize: 13 }}>Complete on Products & components</Link>
              {' · '}
              <Link to="/erp/machines" style={{ color: theme.violetSoft, fontSize: 13 }}>Machine rates</Link>
            </div>
          )}
        </Card>
      </div>
      {feedbackEl}
    </ErpShell>
  );
}

export function ManufacturingDashboard() {
  const [erpDash, setErpDash] = useState(null);
  const [fleet, setFleet] = useState(null);
  const [machines, setMachines] = useState([]);
  const [openWo, setOpenWo] = useState([]);
  const { feedbackEl } = useErpFeedback();

  useEffect(() => {
    fetch('/api/erp/dashboard').then(r => r.json()).then(setErpDash).catch(() => {});
    fetch('/api/dashboard').then(r => r.json()).then(setFleet).catch(() => {});
    fetch('/api/erp/mfg/machines').then(r => r.json()).then(setMachines).catch(() => {});
    fetch('/api/erp/wo?limit=50').then(r => r.json()).then(rows => {
      setOpenWo((rows || []).filter(w => w.status === 'open'));
    }).catch(() => {});
  }, []);

  const statusCounts = fleet?.status_counts || fleet?.by_status || {};
  const printing = Number(statusCounts.PRINTING || statusCounts.printing || 0);
  const idle = Number(statusCounts.IDLE || statusCounts.idle || 0);
  const totalActive = printing + idle + Number(statusCounts.PAUSED || 0) + Number(statusCounts.FINISHED || 0);
  const utilPct = totalActive > 0 ? Math.round((printing / totalActive) * 100) : 0;
  const needsRate = machines.filter(m => m.needs_erp_data || Number(m.hourly_rate) <= 0);

  const utilSegments = [
    { label: 'Printing', value: printing, color: appTheme.lime },
    { label: 'Idle', value: idle, color: appTheme.violetSoft },
    { label: 'Other', value: Math.max(0, totalActive - printing - idle), color: appTheme.orange },
  ];

  return (
    <ErpShell title="Manufacturing Dashboard" subtitle="Printer utilization crossed with machine rates, open WOs, and costing readiness.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Utilization</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: theme.lime, marginTop: 6 }}>{utilPct}%</div>
          <div style={{ fontSize: 12, color: theme.textDim }}>{printing} printing / {totalActive || '-'} active</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Open WOs</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: theme.orange, marginTop: 6 }}>{erpDash?.counts?.open_wo ?? openWo.length}</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Machines</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: theme.violetSoft, marginTop: 6 }}>{machines.length}</div>
          <div style={{ fontSize: 12, color: theme.textDim }}>{needsRate.length} need hourly rate</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>BOMs</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: theme.teal, marginTop: 6 }}>{erpDash?.counts?.boms ?? '-'}</div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 12 }}>
        <Card title="Fleet utilization">
          <DonutChart
            segments={utilSegments}
            size={160}
            centerLabel="util"
            centerValue={`${utilPct}%`}
          />
        </Card>
        <Card title="Machine rates">
          <Table
            columns={[
              { key: 'machine', label: 'Machine' },
              { key: 'rate_mode', label: 'Mode', render: r => r.rate_mode || 'manual' },
              {
                key: 'hourly_rate',
                label: 'USD/h',
                render: r => (
                  <span style={{ fontWeight: 700, color: Number(r.hourly_rate) > 0 ? theme.lime : theme.orange }}>
                    {wac4(r.hourly_rate)}
                  </span>
                ),
              },
              {
                key: 'printer',
                label: 'Printer',
                render: r => r.printer_name || (r.printer_id != null ? `#${r.printer_id}` : '-'),
              },
              { key: 'needs', label: 'Needs rate', render: r => (r.needs_erp_data || Number(r.hourly_rate) <= 0 ? 'yes' : '') },
            ]}
            rows={machines.slice(0, 12)}
          />
          {needsRate.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <Link to="/erp/machines" style={{ color: theme.violetSoft, fontSize: 13 }}>Set missing rates</Link>
            </div>
          )}
        </Card>
      </div>

      <Card title="Open work orders">
        <Table
          columns={[
            { key: 'id', label: 'ID' },
            { key: 'item_sku', label: 'SKU' },
            { key: 'item_name', label: 'Name' },
            { key: 'warehouse_code', label: 'Warehouse' },
            { key: 'qty_planned', label: 'Planned' },
            { key: 'status', label: 'Status' },
          ]}
          rows={openWo.slice(0, 20)}
        />
        <div style={{ marginTop: 10 }}>
          <Link to="/erp/wo" style={{ color: theme.violetSoft, fontSize: 13 }}>All work orders</Link>
        </div>
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function PostingsPage() {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('pending');
  const [err, setErr] = useState('');
  const { showToast, confirm, feedbackEl } = useErpFeedback();

  const load = () => {
    const qs = filter ? `?status=${encodeURIComponent(filter)}` : '';
    fetch(`/api/erp/postings${qs}`).then(r => r.json()).then(setRows).catch(() => setErr('Failed to load postings'));
  };
  useEffect(() => { load(); }, [filter]);

  const confirmOne = async (row, acknowledgeShortage = false) => {
    setErr('');
    const ok = await confirm({
      title: acknowledgeShortage ? 'Confirm with shortage' : 'Confirm ERP posting',
      message: acknowledgeShortage
        ? `Stock is short for ${row.erp_sku || 'this SKU'}, but the plastic was already used on the printer. Confirm to post inventory anyway (qty_on_hand may go negative)?`
        : `Post inventory for ${row.qty} x ${row.erp_sku || 'SKU'} from job #${row.job_id ?? '-'}? This consumes raw material and receives the component.`,
      confirmLabel: acknowledgeShortage ? 'Post with shortage' : 'Confirm posting',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/postings/${row.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledge_shortage: acknowledgeShortage }),
      });
      showToast(`Posting #${row.id} confirmed`);
      load();
    } catch (ex) {
      if (ex.status === 409 && ex.body?.acknowledge_required) {
        const again = await confirm({
          title: 'Material shortage',
          message: `Missing: ${(ex.body.missing || []).map(m => `${m.sku} need ${m.required} have ${m.available}`).join('; ')}. Acknowledge shortage and post anyway?`,
          confirmLabel: 'Acknowledge shortage',
          danger: true,
        });
        if (again) return confirmOne(row, true);
      }
      setErr(ex.message);
      showToast(`Confirm failed: ${ex.message}`, 'error');
    }
  };

  const dismissOne = async (row) => {
    const ok = await confirm({
      title: 'Dismiss posting',
      message: `Dismiss pending posting #${row.id} without moving stock?`,
      confirmLabel: 'Dismiss',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/postings/${row.id}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'dismissed from UI' }),
      });
      showToast(`Posting #${row.id} dismissed`);
      load();
    } catch (ex) {
      showToast(`Dismiss failed: ${ex.message}`, 'error');
    }
  };

  return (
    <ErpShell title="Shopfloor Postings" subtitle="Set Ready creates a pending row. Confirm here to move ERP stock. completed_qty is never changed by this queue.">
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ ...labelStyle, marginBottom: 0 }} htmlFor="posting-status-filter">Status</label>
          <select
            id="posting-status-filter"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ ...INPUT_STYLE, maxWidth: 220 }}
          >
            <option value="pending">Pending</option>
            <option value="posted">Posted</option>
            <option value="dismissed">Dismissed</option>
            <option value="">All</option>
          </select>
        </div>
      </Card>
      {err && <div style={{ color: theme.red, marginBottom: 8, fontSize: 13 }}>{err}</div>}
      <Card>
        <Table
          columns={[
            { key: 'id', label: 'ID' },
            { key: 'job_id', label: 'Job' },
            { key: 'erp_sku', label: 'SKU' },
            { key: 'qty', label: 'Qty', render: r => wac4(r.qty) },
            { key: 'status', label: 'Status' },
            { key: 'shortage', label: 'Shortage', render: r => (r.shortage?.length ? `${r.shortage.length} SKU(s)` : '') },
            { key: 'created_at', label: 'Created', render: r => (r.created_at ? new Date(r.created_at).toLocaleString() : '') },
            { key: 'actions', label: '', render: r => r.status === 'pending' ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => confirmOne(r)} style={{ ...BTN_PRIMARY, padding: '5px 12px' }}>Confirm</button>
                <button type="button" onClick={() => dismissOne(r)} style={{ ...btnSecondary, padding: '5px 12px', color: theme.red }}>Dismiss</button>
              </div>
            ) : '-' },
          ]}
          rows={rows}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function ItemsPage() {
  const [items, setItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [uoms, setUoms] = useState([]);
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState({
    sku: '', name: '', dimension: 'COUNT', display_uom_code: 'EA', purchase_uom_code: 'EA',
    warehouse_id: '', item_role: 'product', sourcing: 'manufactured', project_id: '',
  });
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();

  const load = () => {
    const qs = q ? `?search=${encodeURIComponent(q)}&limit=200` : '?limit=200';
    fetch(`/api/erp/items${qs}`).then(r => r.json()).then(rows => {
      setItems(roleFilter ? rows.filter(r => r.item_role === roleFilter) : rows);
    });
  };
  useEffect(() => { load(); }, [q, roleFilter]);
  useEffect(() => {
    fetch('/api/erp/warehouses').then(r => r.json()).then(setWarehouses);
    fetch('/api/erp/uom').then(r => r.json()).then(setUoms);
    fetch('/api/projects').then(r => r.json()).then(d => setProjects(Array.isArray(d) ? d : (d.projects || []))).catch(() => {});
  }, []);

  const create = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await apiJson('/api/erp/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          warehouse_id: form.warehouse_id ? Number(form.warehouse_id) : null,
          project_id: form.project_id ? Number(form.project_id) : null,
        }),
      });
      setForm({
        sku: '', name: '', dimension: 'COUNT', display_uom_code: 'EA', purchase_uom_code: 'EA',
        warehouse_id: '', item_role: 'product', sourcing: 'manufactured', project_id: '',
      });
      load();
      showToast('Item created');
    } catch (ex) {
      setErr(ex.message);
      showToast(`Create failed: ${ex.message}`, 'error');
    }
  };

  const setSourcing = async (id, sourcing) => {
    try {
      await apiJson(`/api/erp/items/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcing }),
      });
      load();
      showToast('Sourcing updated');
    } catch (ex) {
      showToast(`Update failed: ${ex.message}`, 'error');
    }
  };

  return (
    <ErpShell title="Products & Components" subtitle="Product = shopfloor project. Component = part (pieza). Each is manufactured or outsource.">
      <Card title="Filters">
        <div style={formRow}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="SKU or name" style={{ ...INPUT_STYLE, maxWidth: 280 }} />
          <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} style={INPUT_STYLE}>
            <option value="">All roles</option>
            <option value="product">Products (projects)</option>
            <option value="component">Components (parts)</option>
            <option value="raw">Raw materials</option>
          </select>
        </div>
      </Card>
      <Card title="New item (ERP fields required)" style={{ marginTop: 12 }}>
        <form onSubmit={create} style={formRow}>
          {['sku', 'name'].map(k => (
            <div key={k}>
              <label style={labelStyle}>{k}</label>
              <input required value={form[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} style={INPUT_STYLE} />
            </div>
          ))}
          <div>
            <label style={labelStyle}>Role</label>
            <select value={form.item_role} onChange={e => setForm({ ...form, item_role: e.target.value })} style={INPUT_STYLE}>
              <option value="product">Product (project)</option>
              <option value="component">Component (part)</option>
              <option value="raw">Raw material</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Sourcing</label>
            <select required value={form.sourcing} onChange={e => setForm({ ...form, sourcing: e.target.value })} style={INPUT_STYLE}>
              <option value="manufactured">Manufactured</option>
              <option value="outsource">Outsource</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Link project</label>
            <select value={form.project_id} onChange={e => setForm({ ...form, project_id: e.target.value })} style={INPUT_STYLE}>
              <option value="">(optional)</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>dimension</label>
            <select value={form.dimension} onChange={e => setForm({ ...form, dimension: e.target.value })} style={INPUT_STYLE}>
              {['COUNT', 'WEIGHT', 'LENGTH', 'VOLUME'].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>display UOM</label>
            <select value={form.display_uom_code} onChange={e => setForm({ ...form, display_uom_code: e.target.value })} style={INPUT_STYLE}>
              {uoms.map(u => <option key={u.code} value={u.code}>{u.code}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>purchase UOM</label>
            <select value={form.purchase_uom_code} onChange={e => setForm({ ...form, purchase_uom_code: e.target.value })} style={INPUT_STYLE}>
              {uoms.map(u => <option key={u.code} value={u.code}>{u.code}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>warehouse</label>
            <select value={form.warehouse_id} onChange={e => setForm({ ...form, warehouse_id: e.target.value })} style={INPUT_STYLE}>
              <option value="">(none)</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.code}</option>)}
            </select>
          </div>
          <button type="submit" style={BTN_PRIMARY}>Create</button>
        </form>
        {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{err}</div>}
      </Card>
      <Card title="Catalog" style={{ marginTop: 12 }}>
        <Table
          columns={[
            { key: 'sku', label: 'SKU' },
            { key: 'name', label: 'Name' },
            { key: 'warehouse_code', label: 'Warehouse' },
            { key: 'display_uom_code', label: 'Consumption UOM' },
            { key: 'purchase_uom_code', label: 'Purchasing UOM' },
            { key: 'item_role', label: 'Role' },
            { key: 'sourcing', label: 'Sourcing', render: r => (
              <select
                value={r.sourcing || 'manufactured'}
                onChange={e => setSourcing(r.id, e.target.value)}
                style={{ ...INPUT_STYLE, width: 140 }}
              >
                <option value="manufactured">manufactured</option>
                <option value="outsource">outsource</option>
              </select>
            ) },
            { key: 'project_id', label: 'Project' },
            { key: 'part_id', label: 'Part' },
            { key: 'needs_erp_data', label: 'Needs data', render: r => (r.needs_erp_data ? 'yes' : '') },
            { key: 'is_active', label: 'Active', render: r => (r.is_active ? 'yes' : 'no') },
          ]}
          rows={items}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function LocationsPage() {
  const [warehouses, setWarehouses] = useState([]);
  const [locations, setLocations] = useState([]);
  const [form, setForm] = useState({ warehouse_id: '', code: '' });
  const [whForm, setWhForm] = useState({ code: '', name: '' });
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();

  const load = () => {
    fetch('/api/erp/warehouses').then(r => r.json()).then(ws => {
      setWarehouses(ws);
      if (!form.warehouse_id && ws[0]) setForm(f => ({ ...f, warehouse_id: String(ws[0].id) }));
    });
    fetch('/api/erp/locations').then(r => r.json()).then(setLocations);
  };
  useEffect(() => { load(); }, []);

  const addWh = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await apiJson('/api/erp/warehouses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(whForm),
      });
      setWhForm({ code: '', name: '' });
      load();
      showToast('Warehouse added');
    } catch (ex) {
      setErr(ex.message);
      showToast(`Warehouse failed: ${ex.message}`, 'error');
    }
  };

  const addLoc = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await apiJson('/api/erp/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ warehouse_id: Number(form.warehouse_id), code: form.code }),
      });
      setForm(f => ({ ...f, code: '' }));
      load();
      showToast('Location added');
    } catch (ex) {
      setErr(ex.message);
      showToast(`Location failed: ${ex.message}`, 'error');
    }
  };

  return (
    <ErpShell title="Warehouses & Locations">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <Card title="New warehouse">
          <form onSubmit={addWh} style={{ display: 'grid', gap: 8 }}>
            <input required placeholder="code" value={whForm.code} onChange={e => setWhForm({ ...whForm, code: e.target.value })} style={INPUT_STYLE} />
            <input required placeholder="name" value={whForm.name} onChange={e => setWhForm({ ...whForm, name: e.target.value })} style={INPUT_STYLE} />
            <button type="submit" style={BTN_PRIMARY}>Add warehouse</button>
          </form>
        </Card>
        <Card title="New location">
          <form onSubmit={addLoc} style={{ display: 'grid', gap: 8 }}>
            <select value={form.warehouse_id} onChange={e => setForm({ ...form, warehouse_id: e.target.value })} style={INPUT_STYLE}>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.code} - {w.name}</option>)}
            </select>
            <input required pattern="[0-9]{2}[A-Za-z][0-9]{2}" placeholder="01A01" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} style={INPUT_STYLE} />
            <button type="submit" style={BTN_PRIMARY}>Add location</button>
          </form>
        </Card>
      </div>
      {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{err}</div>}
      <Card title="Warehouses" style={{ marginTop: 12 }}>
        <Table columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'id', label: 'ID' }]} rows={warehouses} />
      </Card>
      <Card title="Locations" style={{ marginTop: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value.toUpperCase())} placeholder="Filter location code" style={{ ...INPUT_STYLE, maxWidth: 260, marginBottom: 10 }} />
        <Table
          columns={[
            { key: 'warehouse_code', label: 'Warehouse' },
            { key: 'code', label: 'Location' },
            { key: 'id', label: 'ID' },
          ]}
          rows={locations.filter(l => !q || l.code.includes(q))}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function InventoryPage() {
  const [stock, setStock] = useState([]);
  const [dash, setDash] = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [locations, setLocations] = useState([]);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({
    sku: '', warehouse_id: '', location_id: '', qty: '', unit_cost: '', note: '', trans_date: '',
  });
  const [err, setErr] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();

  const load = () => {
    fetch('/api/erp/inventory/stock').then(r => r.json()).then(setStock);
    fetch('/api/erp/inventory/dashboard').then(r => r.json()).then(setDash);
  };
  useEffect(() => {
    load();
    fetch('/api/erp/warehouses').then(r => r.json()).then(ws => {
      setWarehouses(ws);
      if (ws[0]) setForm(f => ({ ...f, warehouse_id: String(ws[0].id) }));
    });
    fetch('/api/erp/locations').then(r => r.json()).then(setLocations);
    fetch('/api/erp/items?limit=200').then(r => r.json()).then(setItems);
  }, []);

  const receive = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await apiJson('/api/erp/inventory/receive_by_sku', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: form.sku,
          warehouse_id: Number(form.warehouse_id),
          location_id: form.location_id ? Number(form.location_id) : null,
          qty: Number(form.qty),
          unit_cost: Number(form.unit_cost),
          note: form.note || null,
          trans_date: form.trans_date || null,
          idem_key: `receive-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        }),
      });
      showToast('Inventory received');
      setForm(f => ({ ...f, sku: '', location_id: '', qty: '', unit_cost: '', note: '', trans_date: '' }));
      load();
    } catch (ex) {
      setErr(ex.message);
      showToast(`Receive failed: ${ex.message}`, 'error');
    }
  };

  const selectedItem = items.find(i => i.sku === form.sku);
  const warehouseLocations = locations.filter(l => String(l.warehouse_id) === String(form.warehouse_id));
  const snapTotal = stock.reduce((s, r) => s + (Number(r.value) || 0), 0);

  const valueByWh = useMemo(() => {
    const map = {};
    for (const r of stock) {
      const wh = r.warehouse || 'unknown';
      if (!map[wh]) map[wh] = 0;
      map[wh] += Number(r.value) || 0;
    }
    return Object.entries(map).map(([label, value]) => ({ label, value }));
  }, [stock]);

  const byWarehouseSkus = useMemo(() => {
    const groups = {};
    for (const r of stock) {
      const wh = r.warehouse || 'unknown';
      if (!groups[wh]) groups[wh] = [];
      groups[wh].push({
        label: r.sku,
        qty: Number(r.qty_on_hand) || 0,
        value: Number(r.value) || 0,
      });
    }
    return Object.entries(groups).map(([warehouse, rows]) => ({
      warehouse,
      items: rows.sort((a, b) => b.value - a.value).slice(0, 24),
    }));
  }, [stock]);

  const donutSegments = valueByWh.map((w, i) => ({
    label: w.label,
    value: Math.round(w.value * 100) / 100,
    color: [appTheme.lime, appTheme.violetSoft, appTheme.teal, appTheme.orange, appTheme.accent][i % 5],
  }));

  return (
    <ErpShell title="Inventory">
      {dash && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
          <Card><div style={{ color: theme.textFaint, fontSize: 11 }}>SKU lines</div><div style={{ fontSize: 22, fontWeight: 800, color: theme.lime }}>{dash.sku_lines}</div></Card>
          <Card><div style={{ color: theme.textFaint, fontSize: 11 }}>Total qty</div><div style={{ fontSize: 22, fontWeight: 800, color: theme.violetSoft }}>{qty6(dash.total_qty)}</div></Card>
          <Card><div style={{ color: theme.textFaint, fontSize: 11 }}>Total value</div><div style={{ fontSize: 22, fontWeight: 800, color: theme.teal }}>{usd(dash.total_value)}</div></Card>
        </div>
      )}

      {(valueByWh.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 12 }}>
          <Card title="Value by warehouse">
            <DonutChart
              segments={donutSegments}
              size={160}
              centerLabel="total"
              centerValue={usd(snapTotal)}
            />
            <div style={{ marginTop: 12, height: 120 }}>
              <BarChart items={valueByWh} height={120} barColor={appTheme.violet} />
            </div>
          </Card>
        </div>
      )}

      {byWarehouseSkus.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 12 }}>
          {byWarehouseSkus.map(g => (
            <Card key={g.warehouse} title={`${g.warehouse} (top ${g.items.length})`}>
              <DualBarChart items={g.items} height={130} />
            </Card>
          ))}
        </div>
      )}

      <Card title="Receive by SKU">
        <form onSubmit={receive} style={formRow}>
          <div>
            <label style={labelStyle}>SKU</label>
            <input required list="erp-receive-skus" value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} style={INPUT_STYLE} />
            <datalist id="erp-receive-skus">{items.map(i => <option key={i.id} value={i.sku}>{i.name}</option>)}</datalist>
            {selectedItem && <div style={{ ...labelStyle, marginTop: 4 }}>{selectedItem.name} ({selectedItem.purchase_uom_code})</div>}
          </div>
          <div>
            <label style={labelStyle}>Warehouse</label>
            <select value={form.warehouse_id} onChange={e => setForm({ ...form, warehouse_id: e.target.value, location_id: '' })} style={INPUT_STYLE}>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.code}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Location</label>
            <select value={form.location_id} onChange={e => setForm({ ...form, location_id: e.target.value })} style={INPUT_STYLE}>
              <option value="">(none)</option>
              {warehouseLocations.map(l => <option key={l.id} value={l.id}>{l.code}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Qty</label><input required type="number" step="any" value={form.qty} onChange={e => setForm({ ...form, qty: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Unit cost</label><input required type="number" step="any" value={form.unit_cost} onChange={e => setForm({ ...form, unit_cost: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Transaction date</label><input type="date" value={form.trans_date} onChange={e => setForm({ ...form, trans_date: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Note</label><input value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} style={INPUT_STYLE} /></div>
          <button type="submit" style={BTN_PRIMARY}>Receive</button>
        </form>
        {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{err}</div>}
      </Card>
      <Card title="On hand" style={{ marginTop: 12 }}>
        <Table
          columns={[
            { key: 'sku', label: 'SKU' },
            { key: 'name', label: 'Name' },
            { key: 'warehouse', label: 'Warehouse' },
            { key: 'qty_on_hand', label: 'Qty', render: r => qty6(r.qty_on_hand) },
            { key: 'wac', label: 'WAC', render: r => wac4(r.wac) },
            { key: 'value', label: 'Value', render: r => usd(r.value) },
          ]}
          rows={stock}
          rowKey={r => `${r.sku}-${r.warehouse}`}
        />
        <div style={{ marginTop: 12, textAlign: 'right', color: theme.text, fontWeight: 700, fontSize: 14 }}>
          Total value: {usd(snapTotal)}
        </div>
      </Card>
      {dash?.by_warehouse?.length > 0 && (
        <Card title="By warehouse" style={{ marginTop: 12 }}>
          <Table
            columns={[
              { key: 'warehouse', label: 'Warehouse' },
              { key: 'lines', label: 'Lines' },
              { key: 'qty', label: 'Qty', render: r => qty6(r.qty) },
              { key: 'value', label: 'Value', render: r => usd(r.value) },
            ]}
            rows={dash.by_warehouse}
          />
        </Card>
      )}
      {feedbackEl}
    </ErpShell>
  );
}

export function MachinesPage() {
  const emptyForm = {
    machine: '',
    rate_mode: 'manual',
    hourly_rate: '',
    maintenance_rate: '',
    power_kw: '',
  };
  const [rows, setRows] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [elecPrice, setElecPrice] = useState('0');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();

  const load = () => fetch('/api/erp/mfg/machines?limit=1000').then(r => r.json()).then(list => {
    setRows(list || []);
    return list || [];
  });

  const loadEnergy = () => fetch('/api/erp/mfg/energy').then(r => r.json()).then(cfg => {
    setElecPrice(String(cfg?.electricity_price_per_kwh ?? 0));
  }).catch(() => {});

  useEffect(() => {
    loadEnergy();
    load().then(async (machines) => {
      const names = new Set((machines || []).map(m => m.machine).filter(Boolean));
      try {
        const comps = await fetch('/api/erp/mfg/components?limit=1000').then(r => r.json());
        for (const c of comps || []) if (c.machine) names.add(c.machine);
      } catch (_) { /* optional */ }
      setCandidates([...names].sort((a, b) => a.localeCompare(b)));
    });
  }, []);

  const elecNum = Number(elecPrice) || 0;
  const previewRate = form.rate_mode === 'calculated'
    ? (Number(form.maintenance_rate) || 0) + (Number(form.power_kw) || 0) * elecNum
    : Number(form.hourly_rate) || 0;

  const saveEnergy = async (e) => {
    e.preventDefault();
    try {
      const out = await apiJson('/api/erp/mfg/energy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electricity_price_per_kwh: Number(elecPrice) }),
      });
      setElecPrice(String(out.electricity_price_per_kwh));
      await load();
      showToast(
        out.recalculated_machines
          ? `Electricity saved; recalculated ${out.recalculated_machines} machine(s)`
          : 'Electricity price saved'
      );
    } catch (ex) {
      showToast(`Energy save failed: ${ex.message}`, 'error');
    }
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      const body = {
        machine: form.machine,
        rate_mode: form.rate_mode,
        hourly_rate: Number(form.hourly_rate) || 0,
        maintenance_rate: Number(form.maintenance_rate) || 0,
        power_kw: Number(form.power_kw) || 0,
      };
      await apiJson('/api/erp/mfg/machines', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setForm(emptyForm);
      const list = await load();
      const names = new Set((list || []).map(m => m.machine).filter(Boolean));
      for (const c of candidates) names.add(c);
      setCandidates([...names].sort((a, b) => a.localeCompare(b)));
      showToast('Machine rate saved');
    } catch (ex) { showToast(`Save failed: ${ex.message}`, 'error'); }
  };

  const sync = async () => {
    setMsg('');
    try {
      const out = await apiJson('/api/erp/sync', { method: 'POST' });
      setMsg(`Linked printers: created ${out.created?.machines || 0} machine rows`);
      await load();
      showToast('Printers synced');
    } catch (ex) {
      showToast(`Sync failed: ${ex.message}`, 'error');
    }
  };

  const editRow = (r) => {
    setForm({
      machine: r.machine || '',
      rate_mode: r.rate_mode === 'calculated' ? 'calculated' : 'manual',
      hourly_rate: String(r.hourly_rate ?? ''),
      maintenance_rate: String(r.maintenance_rate ?? ''),
      power_kw: String(r.power_kw ?? ''),
    });
  };

  const filtered = rows.filter(r => {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      String(r.machine || '').toLowerCase().includes(needle)
      || String(r.printer_name || '').toLowerCase().includes(needle)
      || String(r.printer_model || '').toLowerCase().includes(needle)
    );
  });

  return (
    <ErpShell
      title="Machine Rates"
      subtitle="Per machine: manual USD/h, or calculated from maintenance USD/h + kW x electricity USD/kWh. LABOR is the BOM labor rate."
    >
      <div style={{ marginBottom: 12 }}>
        <button type="button" onClick={sync} style={btnSecondary}>Sync printers from shopfloor</button>
        {msg && <span style={{ marginLeft: 10, color: theme.lime, fontSize: 13 }}>{msg}</span>}
      </div>

      <Card title="Electricity price (site-wide)">
        <form onSubmit={saveEnergy} style={formRow}>
          <div>
            <label style={labelStyle}>USD / kWh</label>
            <input
              required
              type="number"
              step="0.0001"
              min="0"
              value={elecPrice}
              onChange={e => setElecPrice(e.target.value)}
              style={INPUT_STYLE}
            />
          </div>
          <button type="submit" style={BTN_PRIMARY}>Save electricity</button>
        </form>
        <div style={{ marginTop: 8, fontSize: 12, color: theme.textDim }}>
          Changing this recalculates every machine in calculated mode.
        </div>
      </Card>

      <Card title="New / Update rate" style={{ marginTop: 12 }}>
        <form onSubmit={save} style={formRow}>
          <div>
            <label style={labelStyle}>Machine</label>
            <input
              required
              list="erp-machine-candidates"
              value={form.machine}
              onChange={e => setForm({ ...form, machine: e.target.value })}
              placeholder="Printer name or LABOR"
              style={INPUT_STYLE}
            />
            <datalist id="erp-machine-candidates">
              {candidates.map(name => <option key={name} value={name} />)}
            </datalist>
          </div>
          <div>
            <label style={labelStyle}>Rate mode</label>
            <select
              value={form.rate_mode}
              onChange={e => setForm({ ...form, rate_mode: e.target.value })}
              style={INPUT_STYLE}
            >
              <option value="manual">Manual (enter USD/h)</option>
              <option value="calculated">Calculated (maintenance + power)</option>
            </select>
          </div>
          {form.rate_mode === 'manual' ? (
            <div>
              <label style={labelStyle}>Hourly rate (USD/h)</label>
              <input
                required
                type="number"
                step="0.0001"
                min="0"
                value={form.hourly_rate}
                onChange={e => setForm({ ...form, hourly_rate: e.target.value })}
                placeholder="0.0000"
                style={INPUT_STYLE}
              />
            </div>
          ) : (
            <>
              <div>
                <label style={labelStyle}>Maintenance (USD/h)</label>
                <input
                  required
                  type="number"
                  step="0.0001"
                  min="0"
                  value={form.maintenance_rate}
                  onChange={e => setForm({ ...form, maintenance_rate: e.target.value })}
                  placeholder="0.0000"
                  style={INPUT_STYLE}
                />
              </div>
              <div>
                <label style={labelStyle}>Power draw (kW)</label>
                <input
                  required
                  type="number"
                  step="0.001"
                  min="0"
                  value={form.power_kw}
                  onChange={e => setForm({ ...form, power_kw: e.target.value })}
                  placeholder="e.g. 0.35"
                  style={INPUT_STYLE}
                />
              </div>
            </>
          )}
          <div>
            <label style={labelStyle}>Effective USD/h</label>
            <div style={{
              ...INPUT_STYLE,
              display: 'flex',
              alignItems: 'center',
              fontWeight: 700,
              color: previewRate > 0 ? theme.lime : theme.orange,
            }}>
              {wac4(previewRate)}
            </div>
          </div>
          <button type="submit" style={BTN_PRIMARY}>Save</button>
        </form>
        {form.rate_mode === 'calculated' && (
          <div style={{ marginTop: 8, fontSize: 12, color: theme.textDim }}>
            Formula: maintenance + (kW x {wac4(elecNum)} USD/kWh) = {wac4(previewRate)} USD/h
          </div>
        )}
      </Card>

      <Card title="Rates" style={{ marginTop: 12 }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Filter by machine, printer, or model"
          style={{ ...INPUT_STYLE, maxWidth: 320, marginBottom: 10 }}
        />
        <Table
          columns={[
            { key: 'machine', label: 'Machine' },
            { key: 'rate_mode', label: 'Mode' },
            {
              key: 'hourly_rate',
              label: 'USD/h',
              render: r => (
                <span style={{ fontWeight: 700, color: Number(r.hourly_rate) > 0 ? theme.lime : theme.orange }}>
                  {wac4(r.hourly_rate)}
                </span>
              ),
            },
            {
              key: 'maintenance_rate',
              label: 'Maint $/h',
              render: r => (r.rate_mode === 'calculated' ? wac4(r.maintenance_rate) : '-'),
            },
            {
              key: 'power_kw',
              label: 'kW',
              render: r => (r.rate_mode === 'calculated' ? wac4(r.power_kw) : '-'),
            },
            {
              key: 'energy_rate',
              label: 'Energy $/h',
              render: r => (r.rate_mode === 'calculated' ? wac4(r.energy_rate) : '-'),
            },
            {
              key: 'printer',
              label: 'Linked printer',
              render: r => (r.printer_name
                ? `${r.printer_name}${r.printer_model ? ` (${r.printer_model})` : ''}`
                : (r.printer_id != null ? `#${r.printer_id}` : '-')),
            },
            {
              key: 'needs_erp_data',
              label: 'Needs rate',
              render: r => (r.needs_erp_data || Number(r.hourly_rate) <= 0 ? 'yes' : ''),
            },
            {
              key: 'edit',
              label: '',
              render: r => (
                <button
                  type="button"
                  onClick={() => editRow(r)}
                  style={{ ...btnSecondary, padding: '4px 10px' }}
                >
                  Edit
                </button>
              ),
            },
          ]}
          rows={filtered}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: theme.textDim }}>
          Costing uses effective USD/h x (std minutes / 60).
        </div>
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function ComponentsPage() {
  const [rows, setRows] = useState([]);
  const [costs, setCosts] = useState({});
  const [items, setItems] = useState([]);
  const [machines, setMachines] = useState([]);
  const [decimals, setDecimals] = useState(2);
  const [cost, setCost] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();
  const [form, setForm] = useState({
    sku: '', name: '', machine: '', std_minutes: '', raw_item_id: '', raw_qty_per_unit: '', scrap_pct: '0', is_active: true,
  });

  const loadCosts = async (list) => {
    const next = {};
    await Promise.all((list || []).map(async (r) => {
      try {
        const out = await apiJson('/api/erp/mfg/calculate-component-cost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            raw_sku: r.raw_sku || '',
            raw_qty_per_unit: Number(r.raw_qty_per_unit),
            scrap_pct: Number(r.scrap_pct),
            std_minutes: Number(r.std_minutes),
            machine: r.machine || null,
          }),
        });
        next[r.id] = out;
      } catch (_) { /* leave blank */ }
    }));
    setCosts(next);
  };

  const load = () => fetch('/api/erp/mfg/components').then(r => r.json()).then(list => {
    setRows(list);
    loadCosts(list);
  });
  useEffect(() => {
    load();
    fetch('/api/erp/items?limit=200').then(r => r.json()).then(setItems);
    fetch('/api/erp/mfg/machines').then(r => r.json()).then(setMachines);
    fetch('/api/erp/config/ui').then(r => r.json()).then(c => {
      if (c?.decimals_display != null) setDecimals(Number(c.decimals_display) || 2);
    }).catch(() => {});
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await apiJson('/api/erp/mfg/components', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          raw_item_id: Number(form.raw_item_id),
          std_minutes: Number(form.std_minutes),
          raw_qty_per_unit: Number(form.raw_qty_per_unit),
          scrap_pct: Number(form.scrap_pct),
        }),
      });
      load();
      showToast('Manufacturing component saved');
    } catch (ex) {
      setErr(ex.message);
      showToast(`Save failed: ${ex.message}`, 'error');
    }
  };

  const calc = async () => {
    setErr('');
    try {
      const raw = items.find(i => String(i.id) === String(form.raw_item_id));
      const out = await apiJson('/api/erp/mfg/calculate-component-cost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw_sku: raw?.sku || '',
          raw_qty_per_unit: Number(form.raw_qty_per_unit),
          scrap_pct: Number(form.scrap_pct),
          std_minutes: Number(form.std_minutes),
          machine: form.machine || null,
        }),
      });
      setCost(out);
    } catch (ex) {
      setErr(ex.message);
      showToast(`Cost estimate failed: ${ex.message}`, 'error');
    }
  };

  return (
    <ErpShell title="Manufacturing Components">
      <Card title="Upsert component">
        <form onSubmit={save} style={formRow}>
          <div><label style={labelStyle}>SKU</label><input required value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Name</label><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={INPUT_STYLE} /></div>
          <div>
            <label style={labelStyle}>Machine</label>
            <select value={form.machine} onChange={e => setForm({ ...form, machine: e.target.value })} style={INPUT_STYLE}>
              <option value="">(none)</option>
              {machines.map(m => <option key={m.id} value={m.machine}>{m.machine}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Std minutes</label><input type="number" step="any" value={form.std_minutes} onChange={e => setForm({ ...form, std_minutes: e.target.value })} style={INPUT_STYLE} /></div>
          <div>
            <label style={labelStyle}>Raw item</label>
            <select required value={form.raw_item_id} onChange={e => setForm({ ...form, raw_item_id: e.target.value })} style={INPUT_STYLE}>
              <option value="">Select raw...</option>
              {items.filter(i => i.item_role === 'raw').map(i => <option key={i.id} value={i.id}>{i.sku} - {i.name}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Raw qty / unit</label><input required type="number" step="any" value={form.raw_qty_per_unit} onChange={e => setForm({ ...form, raw_qty_per_unit: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Scrap %</label><input type="number" step="any" value={form.scrap_pct} onChange={e => setForm({ ...form, scrap_pct: e.target.value })} style={INPUT_STYLE} /></div>
          <button type="submit" style={BTN_PRIMARY}>Save</button>
          <button type="button" onClick={calc} style={btnSecondary}>Estimate cost</button>
        </form>
        {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{err}</div>}
        {cost && (
          <div style={{ marginTop: 10, color: theme.textMuted, fontSize: 13 }}>
            Material {usd(cost.material_cost_per_unit)} + time {usd(cost.time_cost_per_unit)}
            (WAC display {wac4(cost.unit_cost_display)})
          </div>
        )}
      </Card>
      <Card title="Components" style={{ marginTop: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter SKU or name" style={{ ...INPUT_STYLE, maxWidth: 280, marginBottom: 10 }} />
        <Table
          columns={[
            { key: 'sku', label: 'SKU' },
            { key: 'name', label: 'Name' },
            { key: 'machine', label: 'Machine' },
            { key: 'std_minutes', label: 'Min', render: r => min3(r.std_minutes) },
            { key: 'raw_sku', label: 'Raw' },
            { key: 'raw_qty_per_unit', label: 'Raw qty', render: r => fmtQty(r.raw_qty_per_unit, decimals) },
            { key: 'scrap_pct', label: 'Scrap %' },
            { key: 'mat', label: 'Mat $/unit', render: r => (costs[r.id] ? wac4(costs[r.id].material_cost_per_unit) : '-') },
            { key: 'time', label: 'Time $/unit', render: r => (costs[r.id] ? wac4(costs[r.id].time_cost_per_unit) : '-') },
            { key: 'is_active', label: 'Active', render: r => (r.is_active ? 'yes' : 'no') },
            { key: 'edit', label: '', render: r => (
              <button type="button" onClick={() => setForm({
                sku: r.sku, name: r.name, machine: r.machine || '', std_minutes: String(r.std_minutes),
                raw_item_id: String(r.raw_item_id), raw_qty_per_unit: String(r.raw_qty_per_unit),
                scrap_pct: String(r.scrap_pct), is_active: !!r.is_active,
              })} style={{ ...btnSecondary, padding: '4px 10px' }}>Edit</button>
            ) },
          ]}
          rows={rows.filter(r => !q || `${r.sku} ${r.name}`.toLowerCase().includes(q.toLowerCase()))}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function BomPage() {
  const [boms, setBoms] = useState([]);
  const [items, setItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [selected, setSelected] = useState(null);
  const [cost, setCost] = useState(null);
  const [hdr, setHdr] = useState({ item_id: '', name: '', labor_hours_per_unit: '0' });
  const [newProduct, setNewProduct] = useState({ sku: '', name: '', labor_hours_per_unit: '0' });
  const [line, setLine] = useState({ component_item_id: '', qty: '1' });
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const { showToast, confirm, feedbackEl } = useErpFeedback();

  const load = () => fetch('/api/erp/bom').then(r => r.json()).then(setBoms);
  useEffect(() => {
    load();
    fetch('/api/erp/items?limit=200').then(r => r.json()).then(setItems);
    fetch('/api/erp/warehouses').then(r => r.json()).then(setWarehouses);
  }, []);

  const openBom = async (id) => {
    try {
      const [bom, costDetail] = await Promise.all([
        apiJson(`/api/erp/bom/${id}`),
        apiJson(`/api/erp/bom/${id}/calculate-cost`),
      ]);
      setSelected(bom);
      setHdr({
        item_id: String(bom.item_id), name: bom.name || '',
        labor_hours_per_unit: String(bom.labor_hours_per_unit || 0),
      });
      setCost(costDetail);
    } catch (ex) {
      setErr(ex.message);
      showToast(`BOM load failed: ${ex.message}`, 'error');
    }
  };

  const createBom = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const row = await apiJson('/api/erp/bom', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: Number(hdr.item_id),
          name: hdr.name || null,
          labor_hours_per_unit: Number(hdr.labor_hours_per_unit),
        }),
      });
      load();
      openBom(row.id);
      showToast('BOM header saved');
    } catch (ex) {
      setErr(ex.message);
      showToast(`BOM save failed: ${ex.message}`, 'error');
    }
  };

  const createProductAndBom = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const fin = warehouses.find(w => w.code.toLowerCase() === 'fin_good');
      if (!fin) throw new Error('FIN_GOOD warehouse not found');
      const product = await apiJson('/api/erp/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: newProduct.sku, name: newProduct.name || newProduct.sku,
          warehouse_id: fin.id, dimension: 'COUNT', display_uom_code: 'EA', purchase_uom_code: 'EA',
          item_role: 'product', sourcing: 'manufactured',
        }),
      });
      const bom = await apiJson('/api/erp/bom', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: product.id, name: `${product.name} BOM`,
          labor_hours_per_unit: Number(newProduct.labor_hours_per_unit),
        }),
      });
      const allItems = await fetch('/api/erp/items?limit=200').then(r => r.json());
      setItems(allItems);
      setNewProduct({ sku: '', name: '', labor_hours_per_unit: '0' });
      load();
      openBom(bom.id);
      showToast('Product and BOM created');
    } catch (ex) {
      setErr(ex.message);
      showToast(`Product creation failed: ${ex.message}`, 'error');
    }
  };

  const addLine = async (e) => {
    e.preventDefault();
    if (!selected) return;
    try {
      await apiJson(`/api/erp/bom/${selected.id}/line`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ component_item_id: Number(line.component_item_id), qty: Number(line.qty) }),
      });
      openBom(selected.id);
      showToast('BOM line saved');
    } catch (ex) {
      showToast(`BOM line failed: ${ex.message}`, 'error');
    }
  };

  const saveInlineQty = async (lineRow, qty) => {
    try {
      await apiJson(`/api/erp/bom/${selected.id}/line`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ component_item_id: Number(lineRow.component_item_id), qty: Number(qty) }),
      });
      openBom(selected.id);
      showToast('Qty updated');
    } catch (ex) {
      showToast(`Qty update failed: ${ex.message}`, 'error');
    }
  };

  const delLine = async (lineId) => {
    const ok = await confirm({
      title: 'Delete BOM line', message: 'This component will be removed from the BOM.',
      confirmLabel: 'Delete line', danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/bom/${selected.id}/line/${lineId}`, { method: 'DELETE' });
      openBom(selected.id);
      showToast('BOM line deleted');
    } catch (ex) { showToast(`Delete failed: ${ex.message}`, 'error'); }
  };

  const calcCost = async () => {
    if (!selected) return;
    const c = await fetch(`/api/erp/bom/${selected.id}/calculate-cost`).then(r => r.json());
    setCost(c);
  };

  const deleteBom = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: 'Delete BOM', message: `Delete the complete BOM for ${selected.item_sku}?`,
      confirmLabel: 'Delete BOM', danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/bom/${selected.id}`, { method: 'DELETE' });
      setSelected(null);
      setCost(null);
      load();
      showToast('BOM deleted');
    } catch (ex) { showToast(`Delete failed: ${ex.message}`, 'error'); }
  };

  const lineCost = (lineId) => cost?.lines?.find(c => c.line_id === lineId);

  return (
    <ErpShell title="BOM">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <Card title="BOMs">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter finished SKU or name" style={{ ...INPUT_STYLE, marginBottom: 10 }} />
          <Table
            columns={[
              { key: 'item_sku', label: 'FG SKU' },
              { key: 'item_name', label: 'Name' },
              { key: 'material_cost', label: 'Material $', render: r => wac4(r.material_cost) },
              { key: 'labor_cost', label: 'Labor $', render: r => wac4(r.labor_cost) },
              { key: 'total_cost', label: 'Total $', render: r => wac4(r.total_cost) },
              { key: 'open', label: '', render: r => (
                <button type="button" onClick={() => openBom(r.id)} style={{ ...btnSecondary, padding: '4px 10px' }}>Open</button>
              ) },
            ]}
            rows={boms.filter(b => !q || `${b.item_sku} ${b.item_name}`.toLowerCase().includes(q.toLowerCase()))}
          />
        </Card>
        <Card title="Create / update header">
          <form onSubmit={createBom} style={{ display: 'grid', gap: 8 }}>
            <select required value={hdr.item_id} onChange={e => setHdr({ ...hdr, item_id: e.target.value })} style={INPUT_STYLE}>
              <option value="">Finished item...</option>
              {items.filter(i => i.item_role === 'product').map(i => <option key={i.id} value={i.id}>{i.sku} - {i.name}</option>)}
            </select>
            <input placeholder="BOM name" value={hdr.name} onChange={e => setHdr({ ...hdr, name: e.target.value })} style={INPUT_STYLE} />
            <input type="number" step="any" placeholder="labor hours / unit" value={hdr.labor_hours_per_unit} onChange={e => setHdr({ ...hdr, labor_hours_per_unit: e.target.value })} style={INPUT_STYLE} />
            <button type="submit" style={BTN_PRIMARY}>Save BOM</button>
          </form>
          {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{err}</div>}
        </Card>
      </div>
      <Card title="Create product and BOM" style={{ marginTop: 12 }}>
        <form onSubmit={createProductAndBom} style={formRow}>
          <div><label style={labelStyle}>Finished SKU</label><input required value={newProduct.sku} onChange={e => setNewProduct({ ...newProduct, sku: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Product name</label><input required value={newProduct.name} onChange={e => setNewProduct({ ...newProduct, name: e.target.value })} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>Labor hours / unit</label><input type="number" step="any" value={newProduct.labor_hours_per_unit} onChange={e => setNewProduct({ ...newProduct, labor_hours_per_unit: e.target.value })} style={INPUT_STYLE} /></div>
          <button type="submit" style={BTN_PRIMARY}>Create product + BOM</button>
        </form>
      </Card>
      {selected && (
        <Card title={`${selected.item_sku} lines`} style={{ marginTop: 12 }}>
          <Table
            columns={[
              { key: 'sku', label: 'Component' },
              { key: 'name', label: 'Name' },
              { key: 'qty', label: 'Qty', render: r => (
                <input
                  type="number"
                  step="any"
                  defaultValue={r.qty}
                  key={`${r.id}-${r.qty}`}
                  onBlur={e => {
                    if (Number(e.target.value) !== Number(r.qty)) saveInlineQty(r, e.target.value);
                  }}
                  style={{ ...INPUT_STYLE, width: 90 }}
                />
              ) },
              { key: 'unit_cost', label: 'Unit $', render: r => {
                const lc = lineCost(r.id);
                if (!lc) return '-';
                return `${wac4(lc.unit_cost)}${lc.is_estimate ? '*' : ''}`;
              } },
              { key: 'subtotal', label: 'Subtotal $', render: r => {
                const lc = lineCost(r.id);
                return lc ? wac4(lc.subtotal) : '-';
              } },
              { key: 'del', label: '', render: r => (
                <button type="button" onClick={() => delLine(r.id)} style={{ ...btnSecondary, padding: '4px 10px', color: theme.red }}>Delete</button>
              ) },
            ]}
            rows={selected.lines || []}
          />
          <form onSubmit={addLine} style={{ ...formRow, marginTop: 12 }}>
            <select required value={line.component_item_id} onChange={e => setLine({ ...line, component_item_id: e.target.value })} style={INPUT_STYLE}>
              <option value="">Component...</option>
              {items.filter(i => i.item_role !== 'product').map(i => <option key={i.id} value={i.id}>{i.sku}</option>)}
            </select>
            <input type="number" step="any" value={line.qty} onChange={e => setLine({ ...line, qty: e.target.value })} style={INPUT_STYLE} />
            <button type="submit" style={BTN_PRIMARY}>Add line</button>
            <button type="button" onClick={calcCost} style={btnSecondary}>Calculate cost</button>
            <button type="button" onClick={deleteBom} style={{ ...btnSecondary, color: theme.red }}>Delete BOM</button>
          </form>
          {cost && (
            <div style={{ marginTop: 14, color: theme.textMuted, fontSize: 13, lineHeight: 1.8 }}>
              <div>Components subtotal: <strong style={{ color: theme.text }}>{usd(cost.material_cost)}</strong></div>
              <div>Assembly labor ($/unit): <strong style={{ color: theme.text }}>{usd(cost.labor_cost)}</strong> ({wac4(cost.labor_hours)} h @ {wac4(cost.labor_rate)}/h)</div>
              <div style={{ fontSize: 15, marginTop: 4 }}>GRAND TOTAL: <strong style={{ color: theme.lime }}>{usd(cost.total_cost)}</strong></div>
              <div style={{ fontSize: 11, color: theme.textFaint }}>* estimate from manufacturing component recipe (no WAC yet)</div>
            </div>
          )}
        </Card>
      )}
      {feedbackEl}
    </ErpShell>
  );
}

export function WoPage() {
  const [rows, setRows] = useState([]);
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [boms, setBoms] = useState([]);
  const [q, setQ] = useState('');
  const [completionQty, setCompletionQty] = useState({});
  const [form, setForm] = useState({ item_id: '', qty_planned: '1', warehouse_code: 'fin_good', location_code: '' });
  const [err, setErr] = useState('');
  const { showToast, confirm, feedbackEl } = useErpFeedback();

  const load = () => {
    const qs = q ? `?q=${encodeURIComponent(q)}&limit=500` : '?limit=500';
    fetch(`/api/erp/wo${qs}`).then(r => r.json()).then(setRows);
  };
  useEffect(() => {
    load();
    fetch('/api/erp/items?limit=200').then(r => r.json()).then(setItems);
    fetch('/api/erp/locations').then(r => r.json()).then(setLocations);
    fetch('/api/erp/warehouses').then(r => r.json()).then(setWarehouses);
    fetch('/api/erp/bom?limit=1000').then(r => r.json()).then(setBoms);
  }, []);
  useEffect(() => { load(); }, [q]);

  const create = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await apiJson('/api/erp/wo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: Number(form.item_id),
          qty_planned: Number(form.qty_planned),
          warehouse_code: form.warehouse_code,
          location_code: form.location_code || null,
        }),
      });
      load();
      showToast('Work order created');
    } catch (ex) {
      setErr(ex.message);
      showToast(`WO creation failed: ${ex.message}`, 'error');
    }
  };

  const complete = async (id, qty) => {
    setErr('');
    const ok = await confirm({
      title: 'Complete work order',
      message: 'This consumes material stock and receives finished goods. It cannot be undone here.',
      confirmLabel: 'Complete WO', danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/wo/${id}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(qty != null ? { qty_completed: qty } : {}),
      });
      load();
      showToast(`Work order #${id} completed`);
    } catch (ex) {
      const message = ex.body?.missing ? `${ex.message}: ${JSON.stringify(ex.body.missing)}` : ex.message;
      setErr(message);
      showToast(`WO completion failed: ${message}`, 'error');
    }
  };

  const printPickList = async (wo) => {
    const popup = window.open('', '_blank');
    if (!popup) return showToast('Allow popups to print the pick list', 'warning');
    try {
      const bomHeader = boms.find(b => Number(b.item_id) === Number(wo.item_id));
      if (!bomHeader) throw new Error('No BOM found for this work order');
      const bom = await apiJson(`/api/erp/bom/${bomHeader.id}`);
      const item = items.find(i => Number(i.id) === Number(wo.item_id));
      const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[ch]));
      const completionUrl = `${window.location.origin}/erp/qr?wo=${wo.id}`;
      const qrUrl = qrSvgDataUrl(completionUrl);
      const lines = (bom.lines || []).map((lineRow, index) => (
        `<tr><td>${index + 1}</td><td>${esc(lineRow.sku)} - ${esc(lineRow.name)}</td><td>${Number(lineRow.qty)}</td><td>${Number(lineRow.qty) * Number(wo.qty_planned)}</td></tr>`
      )).join('');
      popup.document.write(`<!doctype html><html><head><title>Pick List WO ${wo.id}</title><style>body{font-family:Arial,sans-serif;margin:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:7px;text-align:left}.complete{margin-top:24px;padding-top:16px;border-top:2px solid #bbb;text-align:center;word-break:break-all}.complete img{width:225px;height:225px;display:block;margin:0 auto 8px}</style></head><body><h1>Pick List WO ${wo.id}</h1><p>${esc(item?.sku)} - ${esc(item?.name)}</p><p>Planned quantity: ${Number(wo.qty_planned)}</p><table><thead><tr><th>#</th><th>Component</th><th>Per unit</th><th>Total</th></tr></thead><tbody>${lines}</tbody></table><div class="complete"><img src="${qrUrl}" alt="QR to complete WO"><strong>Scan to complete WO</strong><br>${esc(completionUrl)}</div></body></html>`);
      popup.document.close();
      popup.focus();
      popup.print();
    } catch (ex) {
      popup.close();
      showToast(`Pick list failed: ${ex.message}`, 'error');
    }
  };

  const bomItemIds = new Set(boms.map(b => Number(b.item_id)));

  return (
    <ErpShell title="Work Orders">
      <Card title="Create WO">
        <form onSubmit={create} style={formRow}>
          <select required value={form.item_id} onChange={e => setForm({ ...form, item_id: e.target.value })} style={INPUT_STYLE}>
            <option value="">Finished SKU...</option>
            {items.filter(i => bomItemIds.has(Number(i.id))).map(i => <option key={i.id} value={i.id}>{i.sku}</option>)}
          </select>
          <input type="number" min="1" value={form.qty_planned} onChange={e => setForm({ ...form, qty_planned: e.target.value })} style={INPUT_STYLE} />
          <select value={form.warehouse_code} onChange={e => setForm({ ...form, warehouse_code: e.target.value, location_code: '' })} style={INPUT_STYLE}>
            {warehouses.map(w => <option key={w.id} value={w.code}>{w.code}</option>)}
          </select>
          <select value={form.location_code} onChange={e => setForm({ ...form, location_code: e.target.value })} style={INPUT_STYLE}>
            <option value="">(no location)</option>
            {locations.filter(l => l.warehouse_code === form.warehouse_code).map(l => <option key={l.id} value={l.code}>{l.warehouse_code}/{l.code}</option>)}
          </select>
          <button type="submit" style={BTN_PRIMARY}>Create</button>
        </form>
        {err && <div style={{ color: theme.red, marginTop: 8, fontSize: 13 }}>{String(err)}</div>}
      </Card>
      <Card title="Orders" style={{ marginTop: 12 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter SKU or name" style={{ ...INPUT_STYLE, maxWidth: 280, marginBottom: 10 }} />
        <Table
          columns={[
            { key: 'id', label: 'ID' },
            { key: 'warehouse_code', label: 'Warehouse' },
            { key: 'item_sku', label: 'SKU' },
            { key: 'item_name', label: 'Name' },
            { key: 'qty_planned', label: 'Planned' },
            { key: 'qty_completed', label: 'Done' },
            { key: 'status', label: 'Status' },
            { key: 'complete_qty', label: 'Complete qty', render: r => r.status === 'open' ? (
              <input type="number" min="0.0001" step="any" value={completionQty[r.id] ?? r.qty_planned} onChange={e => setCompletionQty({ ...completionQty, [r.id]: e.target.value })} style={{ ...INPUT_STYLE, width: 100 }} />
            ) : '-' },
            { key: 'qr', label: 'QR', render: r => (
              <Link to={`/erp/qr?wo=${r.id}`} style={{ color: theme.violetSoft }}>Open</Link>
            ) },
            { key: 'actions', label: '', render: r => (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {r.status === 'open' && <button type="button" onClick={() => complete(r.id, Number(completionQty[r.id] ?? r.qty_planned))} style={{ ...BTN_PRIMARY, padding: '5px 12px' }}>Complete</button>}
                <button type="button" onClick={() => printPickList(r)} style={{ ...btnSecondary, padding: '5px 12px' }}>Pick list</button>
              </div>
            ) },
          ]}
          rows={rows}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function QrCompletePage() {
  const [params] = useSearchParams();
  const woId = params.get('wo');
  const [wo, setWo] = useState(null);
  const [qty, setQty] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const { showToast, confirm, feedbackEl } = useErpFeedback();

  useEffect(() => {
    if (!woId) return;
    fetch(`/api/erp/wo/${woId}`).then(r => r.json()).then(w => {
      setWo(w);
      setQty(String(w.qty_planned || ''));
    }).catch(() => setErr('WO not found'));
  }, [woId]);

  const complete = async (all) => {
    setErr(''); setMsg('');
    const ok = await confirm({
      title: 'Complete work order',
      message: 'This consumes inventory and closes the work order.',
      confirmLabel: 'Complete WO', danger: true,
    });
    if (!ok) return;
    try {
      const body = all ? {} : { qty_completed: Number(qty) };
      const out = await apiJson(`/api/erp/wo/${woId}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      setWo(out);
      setMsg(`WO #${out.id} closed (${out.qty_completed} units)`);
      showToast(`Work order #${out.id} completed`);
    } catch (ex) {
      const message = ex.body?.missing ? `${ex.message}: ${JSON.stringify(ex.body.missing)}` : ex.message;
      setErr(message);
      showToast(`WO completion failed: ${message}`, 'error');
    }
  };

  return (
    <ErpShell title="QR Complete">
      <Card>
        {!woId && <div style={{ color: theme.textDim }}>Add ?wo=ID to the URL (from work order QR link).</div>}
        {wo && (
          <>
            <h2 style={{ margin: '0 0 8px', color: theme.text }}>WO #{wo.id} - {wo.item_sku}</h2>
            <p style={{ color: theme.textMuted, marginTop: 0 }}>
              Planned {wo.qty_planned} | Status {wo.status}
            </p>
            {wo.status === 'open' ? (
              <div style={{ display: 'grid', gap: 10, maxWidth: 360 }}>
                <button type="button" onClick={() => complete(true)} style={BTN_PRIMARY}>All finished</button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="number" value={qty} onChange={e => setQty(e.target.value)} style={INPUT_STYLE} />
                  <button type="button" onClick={() => complete(false)} style={btnSecondary}>Complete qty</button>
                </div>
              </div>
            ) : (
              <div style={{ color: theme.lime }}>Already closed.</div>
            )}
          </>
        )}
        {err && <div style={{ color: theme.red, marginTop: 12 }}>{err}</div>}
        {msg && <div style={{ color: theme.lime, marginTop: 12 }}>{msg}</div>}
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}
