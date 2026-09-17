import { useEffect, useState } from 'react';
import Card from '../../components/Card';
import { usd, wac4, marginBadgeColor } from './format';
import {
  ErpShell, Table, theme, INPUT_STYLE, BTN_PRIMARY, labelStyle, formRow, btnSecondary, apiJson,
  useErpFeedback,
} from './shared';

export function SalesHubPage() {
  const [matrix, setMatrix] = useState([]);
  const [history, setHistory] = useState(null);
  const [stock, setStock] = useState([]);
  const { feedbackEl } = useErpFeedback();

  useEffect(() => {
    fetch('/api/erp/sales/reports?page=1&limit=20&sort_by=margin_usd&order=desc')
      .then(r => r.json()).then(d => setMatrix(d.items || [])).catch(() => {});
    fetch('/api/erp/sales/orders/report?page=1&limit=25')
      .then(r => r.json()).then(setHistory).catch(() => {});
    fetch('/api/erp/inventory/stock')
      .then(r => r.json())
      .then(rows => setStock((rows || []).filter(r => String(r.warehouse || '').toLowerCase().includes('fin'))))
      .catch(() => {});
  }, []);

  const topMargin = matrix.slice(0, 8);
  const fgValue = stock.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const fgQty = stock.reduce((s, r) => s + (Number(r.qty_on_hand) || 0), 0);

  return (
    <ErpShell title="Sales Dashboard" subtitle="Revenue, margin, and finished-goods stock at a glance.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 }}>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Revenue (page)</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: theme.lime, marginTop: 6 }}>{usd(history?.total_revenue)}</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Margin (page)</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: theme.teal, marginTop: 6 }}>{usd(history?.total_margin)}</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>FG stock value</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: theme.violetSoft, marginTop: 6 }}>{usd(fgValue)}</div>
          <div style={{ fontSize: 12, color: theme.textDim }}>{wac4(fgQty)} units</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Sales rows</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: theme.orange, marginTop: 6 }}>{history?.total_items ?? '-'}</div>
        </Card>
      </div>

      <Card title="Top margin products">
        <Table
          columns={[
            { key: 'sku', label: 'SKU' },
            { key: 'item_name', label: 'Name' },
            { key: 'cost', label: 'Cost', render: r => wac4(r.cost) },
            { key: 'margin_pct', label: 'Margin %', render: r => (
              <span style={{
                display: 'inline-block', padding: '2px 8px', borderRadius: 6,
                background: `${marginBadgeColor(r.margin_pct)}22`, color: marginBadgeColor(r.margin_pct), fontWeight: 700,
              }}>{wac4(r.margin_pct)}</span>
            ) },
            { key: 'margin_usd', label: 'Margin $', render: r => usd(r.margin_usd ?? r.margin_value) },
            { key: 'selling_price', label: 'Price', render: r => wac4(r.selling_price) },
          ]}
          rows={topMargin}
          rowKey={r => r.item_id}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function SalesConfigPage() {
  const [config, setConfig] = useState([]);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();

  const load = () => fetch('/api/erp/sales/config').then(r => r.json()).then(rows => {
    setConfig(rows);
    setDraft(Object.fromEntries(rows.map(r => [r.code, String(r.value)])));
  });
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    setMsg('');
    const payload = config.map(c => ({ code: c.code, value: Number(draft[c.code] ?? c.value) }));
    try {
      await apiJson('/api/erp/sales/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      setMsg('Saved');
      showToast('Sales defaults saved');
      load();
    } catch (ex) { showToast(`Save failed: ${ex.message}`, 'error'); }
  };

  return (
    <ErpShell title="Sales Config">
      <Card>
        <form onSubmit={save} style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
          {config.map(c => (
            <div key={c.code}>
              <label style={labelStyle}>{c.name} ({c.code})</label>
              <input
                type="number"
                step="any"
                value={draft[c.code] ?? ''}
                onChange={e => setDraft({ ...draft, [c.code]: e.target.value })}
                style={INPUT_STYLE}
              />
            </div>
          ))}
          <button type="submit" style={BTN_PRIMARY}>Save defaults</button>
        </form>
        {msg && <div style={{ color: theme.lime, marginTop: 8 }}>{msg}</div>}
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

function EditablePct({ value, dirty, onDirty, onCommit, onCancel }) {
  return (
    <input
      type="number"
      value={value}
      onChange={e => onDirty(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onBlur={() => onCommit()}
      style={{
        ...INPUT_STYLE,
        width: 80,
        background: dirty ? '#5a4a00' : INPUT_STYLE.background,
      }}
    />
  );
}

export function SalesPricingPage() {
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState({});
  const [err, setErr] = useState('');
  const { showToast, confirm, feedbackEl } = useErpFeedback();

  const load = () => {
    const qs = new URLSearchParams({ page: String(page), search });
    fetch(`/api/erp/sales/pricing?${qs}`).then(r => r.json()).then(d => {
      setRows(d.items || []);
      setTotal(d.total || 0);
      setDrafts({});
    });
  };
  useEffect(() => { load(); }, [page, search]);

  const draftKey = (itemId, field) => `${itemId}:${field}`;
  const displayVal = (r, field, apiField) => {
    const k = draftKey(r.item_id, field);
    return drafts[k] != null ? drafts[k] : String(r[apiField]);
  };
  const isDirty = (r, field) => drafts[draftKey(r.item_id, field)] != null;

  const patch = async (itemId, field, value) => {
    setErr('');
    try {
      await apiJson(`/api/erp/sales/pricing/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value: Number(value) }),
      });
      setDrafts(d => {
        const next = { ...d };
        delete next[draftKey(itemId, field)];
        return next;
      });
      load();
      showToast('Pricing override saved');
    } catch (ex) {
      setErr(ex.message);
      showToast(`Pricing update failed: ${ex.message}`, 'error');
    }
  };

  const commitField = (r, field, apiField) => {
    const k = draftKey(r.item_id, field);
    if (drafts[k] == null) return;
    if (Number(drafts[k]) === Number(r[apiField])) {
      setDrafts(d => { const n = { ...d }; delete n[k]; return n; });
      return;
    }
    patch(r.item_id, field, drafts[k]);
  };

  const cancelField = (r, field, apiField) => {
    setDrafts(d => {
      const next = { ...d };
      next[draftKey(r.item_id, field)] = String(r[apiField]);
      delete next[draftKey(r.item_id, field)];
      return next;
    });
  };

  const reset = async (itemId) => {
    const ok = await confirm({
      title: 'Reset pricing', message: 'Remove all custom pricing values and return to global defaults?',
      confirmLabel: 'Reset pricing', danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/sales/pricing/${itemId}/reset`, { method: 'POST' });
      load();
      showToast('Pricing reset to defaults');
    } catch (ex) { showToast(`Reset failed: ${ex.message}`, 'error'); }
  };

  return (
    <ErpShell title="Sales Pricing">
      <Card>
        <input
          placeholder="Search FG SKU / name"
          value={search}
          onChange={e => { setPage(1); setSearch(e.target.value); }}
          style={{ ...INPUT_STYLE, maxWidth: 320, marginBottom: 12 }}
        />
        {err && <div style={{ color: theme.red, marginBottom: 8 }}>{err}</div>}
        <Table
          columns={[
            { key: 'sku', label: 'SKU' },
            { key: 'name', label: 'Name' },
            { key: 'cost', label: 'Cost', render: r => wac4(r.cost) },
            { key: 'margin_pct', label: 'Margin %', render: r => (
              <EditablePct
                value={displayVal(r, 'custom_margin', 'margin_pct')}
                dirty={isDirty(r, 'custom_margin')}
                onDirty={v => setDrafts(d => ({ ...d, [draftKey(r.item_id, 'custom_margin')]: v }))}
                onCommit={() => commitField(r, 'custom_margin', 'margin_pct')}
                onCancel={() => cancelField(r, 'custom_margin', 'margin_pct')}
              />
            ) },
            { key: 'ads_pct', label: 'Ads %', render: r => (
              <EditablePct
                value={displayVal(r, 'custom_ads', 'ads_pct')}
                dirty={isDirty(r, 'custom_ads')}
                onDirty={v => setDrafts(d => ({ ...d, [draftKey(r.item_id, 'custom_ads')]: v }))}
                onCommit={() => commitField(r, 'custom_ads', 'ads_pct')}
                onCancel={() => cancelField(r, 'custom_ads', 'ads_pct')}
              />
            ) },
            { key: 'fee_pct', label: 'Fee %', render: r => (
              <EditablePct
                value={displayVal(r, 'custom_fee', 'fee_pct')}
                dirty={isDirty(r, 'custom_fee')}
                onDirty={v => setDrafts(d => ({ ...d, [draftKey(r.item_id, 'custom_fee')]: v }))}
                onCommit={() => commitField(r, 'custom_fee', 'fee_pct')}
                onCancel={() => cancelField(r, 'custom_fee', 'fee_pct')}
              />
            ) },
            { key: 'selling_price', label: 'Price', render: r => wac4(r.selling_price) },
            { key: 'reset', label: '', render: r => (
              <button type="button" onClick={() => reset(r.item_id)} style={{ ...btnSecondary, padding: '4px 10px' }}>Reset</button>
            ) },
          ]}
          rows={rows}
          rowKey={r => r.item_id}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={btnSecondary}>Prev</button>
          <span style={{ color: theme.textDim, fontSize: 13 }}>Page {page} / {Math.max(1, Math.ceil(total / 20))} ({total})</span>
          <button type="button" disabled={page * 20 >= total} onClick={() => setPage(p => p + 1)} style={btnSecondary}>Next</button>
        </div>
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function SalesOrderPage() {
  const [catalog, setCatalog] = useState([]);
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState('1');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const { showToast, confirm, feedbackEl } = useErpFeedback();

  const load = () => {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    fetch(`/api/erp/sales/order/items${qs}`).then(r => r.json()).then(setCatalog).catch(() => setCatalog([]));
  };
  useEffect(() => { load(); }, [search]);

  const selected = catalog.find(c => c.sku === sku);
  const total = selected ? Number(selected.selling_price || 0) * Number(qty || 0) : 0;

  const sell = async (e) => {
    e.preventDefault();
    setErr(''); setResult(null);
    const ok = await confirm({
      title: 'Place sales order',
      message: `Sell ${Number(qty)} unit(s) of ${sku}? This removes finished stock.`,
      confirmLabel: 'Place order', danger: true,
    });
    if (!ok) return;
    try {
      const out = await apiJson('/api/erp/sales/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, qty: Number(qty) }),
      });
      setResult(out);
      load();
      showToast('Sales order recorded');
    } catch (ex) {
      setErr(ex.message);
      showToast(`Sales order failed: ${ex.message}`, 'error');
    }
  };

  return (
    <ErpShell title="Sales Order">
      <Card title="Sell finished good">
        <form onSubmit={sell} style={formRow}>
          <div>
            <label style={labelStyle}>SKU</label>
            <input required value={sku} onChange={e => setSku(e.target.value)} list="fg-skus" style={INPUT_STYLE} />
            <datalist id="fg-skus">
              {catalog.map(c => <option key={c.item_id} value={c.sku}>{c.name}</option>)}
            </datalist>
          </div>
          <div>
            <label style={labelStyle}>Qty</label>
            <input required type="number" step="any" min="0.0001" value={qty} onChange={e => setQty(e.target.value)} style={INPUT_STYLE} />
          </div>
          <button type="submit" style={BTN_PRIMARY}>Place order</button>
        </form>
        {selected && (
          <div style={{ marginTop: 12, color: theme.textMuted, fontSize: 13, lineHeight: 1.7 }}>
            Item: <strong style={{ color: theme.text }}>{selected.name}</strong><br />
            Available stock: <strong style={{ color: theme.text }}>{wac4(selected.available_qty)}</strong><br />
            Sell price: <strong style={{ color: theme.text }}>{wac4(selected.selling_price)}</strong><br />
            Total: <strong style={{ color: theme.lime }}>{usd(total)}</strong>
          </div>
        )}
        {err && <div style={{ color: theme.red, marginTop: 8 }}>{err}</div>}
        {result && (
          <div style={{ color: theme.lime, marginTop: 8, fontSize: 13 }}>
            Sold {result.qty} x {result.sku} @ ${wac4(result.unit_price)} (total ${wac4(result.total_price)}). Remaining {wac4(result.remaining_qty)}.
          </div>
        )}
      </Card>
      <Card title="Available FG" style={{ marginTop: 12 }}>
        <input
          placeholder="Filter catalog"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ ...INPUT_STYLE, maxWidth: 280, marginBottom: 10 }}
        />
        <Table
          columns={[
            { key: 'sku', label: 'SKU', render: r => (
              <button type="button" onClick={() => setSku(r.sku)} style={{ background: 'none', border: 'none', color: theme.violetSoft, cursor: 'pointer', padding: 0 }}>{r.sku}</button>
            ) },
            { key: 'name', label: 'Name' },
            { key: 'selling_price', label: 'Price', render: r => wac4(r.selling_price) },
            { key: 'available_qty', label: 'Available', render: r => wac4(r.available_qty) },
          ]}
          rows={catalog}
          rowKey={r => r.item_id}
        />
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}

export function SalesReportsPage() {
  const [matrix, setMatrix] = useState([]);
  const [matrixPage, setMatrixPage] = useState(1);
  const [matrixTotal, setMatrixTotal] = useState(0);
  const [sortBy, setSortBy] = useState('item_name');
  const [order, setOrder] = useState('asc');
  const [history, setHistory] = useState(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [search, setSearch] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [err, setErr] = useState('');
  const { showToast, feedbackEl } = useErpFeedback();

  const loadMatrix = () => {
    const qs = new URLSearchParams({
      page: String(matrixPage), limit: '20', sort_by: sortBy, order,
    });
    if (search) qs.set('search', search);
    fetch(`/api/erp/sales/reports?${qs}`).then(r => r.json()).then(d => {
      setMatrix(d.items || []);
      setMatrixTotal(d.total || 0);
    });
  };
  const loadHistory = async (requestedPage = historyPage, notify = false) => {
    const qs = new URLSearchParams({ page: String(requestedPage), limit: '25' });
    if (start) qs.set('start_date', start);
    if (end) qs.set('end_date', end);
    setErr('');
    try {
      setHistory(await apiJson(`/api/erp/sales/orders/report?${qs}`));
    } catch (ex) {
      setErr(ex.message);
      if (notify) showToast(`Report failed: ${ex.message}`, 'error');
    }
  };
  useEffect(() => { loadMatrix(); }, [search, matrixPage, sortBy, order]);
  useEffect(() => { loadHistory(historyPage); }, [historyPage]);

  const exportUrl = (format) => {
    const qs = new URLSearchParams({ format });
    if (start) qs.set('start_date', start);
    if (end) qs.set('end_date', end);
    return `/api/erp/sales/orders/report?${qs}`;
  };
  const invalidRange = !!(start && end && start > end);
  const guardExport = (e) => {
    if (!invalidRange) return;
    e.preventDefault();
    setErr('start_date must be <= end_date');
    showToast('Report failed: start date must be before end date', 'error');
  };

  const toggleSort = (field) => {
    setMatrixPage(1);
    if (sortBy === field) setOrder(o => (o === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(field); setOrder('desc'); }
  };
  const sortLabel = (field, label) => (
    `${label}${sortBy === field ? (order === 'asc' ? ' ▲' : ' ▼') : ''}`
  );

  return (
    <ErpShell title="Sales Reports">
      <Card title="Price matrix (FIN_GOOD)">
        <input
          placeholder="Search"
          value={search}
          onChange={e => { setMatrixPage(1); setSearch(e.target.value); }}
          style={{ ...INPUT_STYLE, maxWidth: 280, marginBottom: 10 }}
        />
        <div style={{ ...formRow, marginBottom: 10 }}>
          <select value={sortBy} onChange={e => { setMatrixPage(1); setSortBy(e.target.value); }} style={INPUT_STYLE}>
            <option value="item_name">Sort by name</option>
            <option value="margin_pct">Sort by margin %</option>
            <option value="margin_usd">Sort by margin $</option>
            <option value="selling_price">Sort by price</option>
          </select>
          <select value={order} onChange={e => { setMatrixPage(1); setOrder(e.target.value); }} style={INPUT_STYLE}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
        <Table
          columns={[
            { key: 'sku', label: 'SKU' },
            { key: 'item_name', label: 'Name' },
            { key: 'cost', label: 'Cost', render: r => wac4(r.cost) },
            {
              key: 'margin_pct',
              label: sortLabel('margin_pct', 'Margin %'),
              onSort: () => toggleSort('margin_pct'),
              render: r => (
                <span style={{
                  display: 'inline-block', padding: '2px 8px', borderRadius: 6,
                  background: `${marginBadgeColor(r.margin_pct)}22`,
                  color: marginBadgeColor(r.margin_pct),
                  fontWeight: 700,
                }}>{wac4(r.margin_pct)}</span>
              ),
            },
            {
              key: 'margin_usd',
              label: sortLabel('margin_usd', 'Margin $'),
              onSort: () => toggleSort('margin_usd'),
              render: r => usd(r.margin_usd ?? r.margin_value),
            },
            { key: 'ads_pct', label: 'Ads %', render: r => wac4(r.ads_pct) },
            { key: 'fee_pct', label: 'Fee %', render: r => wac4(r.fee_pct) },
            {
              key: 'selling_price',
              label: sortLabel('selling_price', 'Price'),
              onSort: () => toggleSort('selling_price'),
              render: r => wac4(r.selling_price),
            },
            { key: 'fees_usd', label: 'Fees $', render: r => usd(r.fees_usd) },
          ]}
          rows={matrix}
          rowKey={r => r.item_id}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" disabled={matrixPage <= 1} onClick={() => setMatrixPage(p => p - 1)} style={btnSecondary}>Prev</button>
          <span style={{ color: theme.textDim, fontSize: 13 }}>Page {matrixPage} / {Math.max(1, Math.ceil(matrixTotal / 20))}</span>
          <button type="button" disabled={matrixPage * 20 >= matrixTotal} onClick={() => setMatrixPage(p => p + 1)} style={btnSecondary}>Next</button>
        </div>
      </Card>
      <Card title="Sales history" style={{ marginTop: 12 }}>
        <div style={formRow}>
          <div><label style={labelStyle}>Start</label><input type="date" value={start} onChange={e => setStart(e.target.value)} style={INPUT_STYLE} /></div>
          <div><label style={labelStyle}>End</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} style={INPUT_STYLE} /></div>
          <button type="button" onClick={() => { setHistoryPage(1); loadHistory(1, true); }} style={BTN_PRIMARY}>Refresh</button>
          <a href={exportUrl('csv')} onClick={guardExport} style={{ ...btnSecondary, textDecoration: 'none', display: 'inline-block' }}>CSV</a>
          <a href={exportUrl('pdf')} onClick={guardExport} style={{ ...btnSecondary, textDecoration: 'none', display: 'inline-block' }}>PDF</a>
        </div>
        {err && <div style={{ color: theme.red, marginTop: 10, fontSize: 13 }}>{err}</div>}
        {history && (
          <>
            <div style={{ color: theme.textMuted, fontSize: 13, margin: '12px 0' }}>
              Qty {wac4(history.total_qty)} | Revenue {usd(history.total_revenue)} | Margin {usd(history.total_margin)}
            </div>
            <Table
              columns={[
                { key: 'sale_date', label: 'Date' },
                { key: 'sku', label: 'SKU' },
                { key: 'item_name', label: 'Name' },
                { key: 'qty', label: 'Qty', render: r => wac4(r.qty) },
                { key: 'unit_price', label: 'Unit $', render: r => wac4(r.unit_price) },
                { key: 'total_price', label: 'Total $', render: r => usd(r.total_price) },
                { key: 'unit_margin', label: 'Margin/U', render: r => wac4(r.unit_margin) },
              ]}
              rows={history.items || []}
              rowKey={r => `${r.sale_date}-${r.sku}-${r.qty}-${r.total_price}`}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" disabled={historyPage <= 1} onClick={() => setHistoryPage(p => p - 1)} style={btnSecondary}>Prev</button>
              <span style={{ color: theme.textDim, fontSize: 13 }}>Page {historyPage} / {Math.max(1, Math.ceil((history.total_items || 0) / 25))}</span>
              <button type="button" disabled={historyPage * 25 >= (history.total_items || 0)} onClick={() => setHistoryPage(p => p + 1)} style={btnSecondary}>Next</button>
            </div>
          </>
        )}
      </Card>
      {feedbackEl}
    </ErpShell>
  );
}
