import { useEffect, useState, useCallback } from 'react';
import Card from '../../components/Card';
import {
  ErpShell, Table, theme, INPUT_STYLE, BTN_PRIMARY, labelStyle, formRow, btnSecondary, apiJson,
  useErpFeedback,
} from './shared';

const cardGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 14 };
const sectionGap = { marginBottom: 14 };

export function EbayPage() {
  const { showToast, confirm, feedbackEl } = useErpFeedback();
  const [status, setStatus] = useState(null);
  const [creds, setCreds] = useState(null);
  const [draft, setDraft] = useState({});
  const [listings, setListings] = useState([]);
  const [pending, setPending] = useState([]);
  const [orders, setOrders] = useState([]);
  const [items, setItems] = useState([]);
  const [newListing, setNewListing] = useState({ item_id: '', ebay_sku: '', offer_id: '' });
  const [traffic, setTraffic] = useState(null);
  const [standards, setStandards] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadCore = useCallback(() => {
    Promise.all([
      fetch('/api/erp/ebay/status').then(r => r.json()),
      fetch('/api/erp/ebay/credentials').then(r => r.json()),
      fetch('/api/erp/ebay/listings').then(r => r.json()),
      fetch('/api/erp/ebay/pending').then(r => r.json()),
      fetch('/api/erp/ebay/orders?limit=25').then(r => r.json()),
      fetch('/api/erp/items?limit=200').then(r => r.json()).catch(() => ({ items: [] })),
    ]).then(([st, cr, li, pe, or, it]) => {
      setStatus(st);
      setCreds(cr);
      setDraft({
        environment: cr.environment || 'sandbox',
        marketplace_id: cr.marketplace_id || 'EBAY_US',
        auto_post: cr.auto_post !== 0,
        client_id: '',
        client_secret: '',
        refresh_token: '',
      });
      setListings(li.listings || []);
      setPending(pe.lines || []);
      setOrders(or.orders || []);
      setItems(it.items || it || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { loadCore(); }, [loadCore]);

  useEffect(() => {
    if (!creds?.configured) return;
    fetch('/api/erp/ebay/analytics/traffic')
      .then(r => r.json()).then(d => { if (d.ok !== false) setTraffic(d); }).catch(() => {});
    fetch('/api/erp/ebay/analytics/seller-standards')
      .then(r => r.json()).then(d => { if (d.ok !== false) setStandards(d); }).catch(() => {});
  }, [creds?.configured]);

  async function saveCredentials() {
    setBusy(true);
    try {
      const body = {
        environment: draft.environment,
        marketplace_id: draft.marketplace_id,
        auto_post: draft.auto_post ? 1 : 0,
      };
      if (draft.client_id) body.client_id = draft.client_id;
      if (draft.client_secret) body.client_secret = draft.client_secret;
      if (draft.refresh_token) body.refresh_token = draft.refresh_token;
      const updated = await apiJson('/api/erp/ebay/credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setCreds(updated);
      showToast('eBay credentials saved');
      loadCore();
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    try {
      const result = await apiJson('/api/erp/ebay/test-connection', { method: 'POST' });
      showToast(`Connected (${result.environment})`);
      loadCore();
    } catch (err) {
      showToast('Connection failed: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function syncOrders() {
    setBusy(true);
    try {
      const result = await apiJson('/api/erp/ebay/orders/sync', { method: 'POST' });
      showToast(`Synced ${result.fetched} order(s), auto ${result.auto_posted}, queued ${result.queued}`);
      loadCore();
    } catch (err) {
      showToast('Order sync failed: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function pushInventory() {
    setBusy(true);
    try {
      const result = await apiJson('/api/erp/ebay/inventory/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      showToast(`Push ok ${result.ok_count}, fail ${result.fail_count}`);
      loadCore();
    } catch (err) {
      showToast('Inventory push failed: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addListing() {
    setBusy(true);
    try {
      await apiJson('/api/erp/ebay/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_id: Number(newListing.item_id),
          ebay_sku: newListing.ebay_sku.trim(),
          offer_id: newListing.offer_id.trim() || null,
        }),
      });
      showToast('Listing mapped');
      setNewListing({ item_id: '', ebay_sku: '', offer_id: '' });
      loadCore();
    } catch (err) {
      showToast('Map failed: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeListing(id) {
    const ok = await confirm({
      title: 'Remove mapping',
      message: 'Remove this eBay SKU mapping? Offers on eBay are not deleted.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/ebay/listings/${id}`, { method: 'DELETE' });
      showToast('Mapping removed');
      loadCore();
    } catch (err) {
      showToast('Remove failed: ' + err.message, 'error');
    }
  }

  async function confirmPending(line, acknowledgeShortage) {
    if (acknowledgeShortage) {
      const ok = await confirm({
        title: 'Confirm with shortage',
        message: 'Stock is short. Confirm anyway? qty_on_hand may go negative.',
        confirmLabel: 'Confirm shortage',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await apiJson(`/api/erp/ebay/pending/${line.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledge_shortage: !!acknowledgeShortage }),
      });
      showToast('Line posted to ERP');
      loadCore();
    } catch (err) {
      if (err.status === 409 && err.body?.acknowledge_required) {
        showToast('Shortage: confirm again with acknowledge', 'warning');
        loadCore();
      } else {
        showToast('Confirm failed: ' + err.message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function dismissPending(line) {
    const ok = await confirm({
      title: 'Dismiss line',
      message: 'Dismiss this eBay order line without creating a sales order?',
      confirmLabel: 'Dismiss',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiJson(`/api/erp/ebay/pending/${line.id}/dismiss`, { method: 'POST' });
      showToast('Line dismissed');
      loadCore();
    } catch (err) {
      showToast('Dismiss failed: ' + err.message, 'error');
    }
  }

  if (loading) {
    return (
      <ErpShell title="eBay" subtitle="Sell APIs: orders, inventory push, analytics.">
        <div style={{ color: theme.textDim }}>Loading...</div>
      </ErpShell>
    );
  }

  return (
    <ErpShell
      title="eBay"
      subtitle="Import paid orders, push price/qty to existing offers, view seller analytics. Sandbox-first."
      actions={(
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={btnSecondary} disabled={busy} onClick={testConnection}>Test connection</button>
          <button type="button" style={btnSecondary} disabled={busy} onClick={syncOrders}>Sync orders</button>
          <button type="button" style={BTN_PRIMARY} disabled={busy} onClick={pushInventory}>Push inventory</button>
        </div>
      )}
    >
      <style>{`
        @media (max-width: 600px) {
          .ebay-form-row { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div style={cardGrid}>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Status</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: status?.configured ? theme.lime : theme.orange, marginTop: 6 }}>
            {status?.configured ? 'Configured' : 'Not configured'}
          </div>
          <div style={{ fontSize: 12, color: theme.textDim }}>{status?.environment || '-'} / {status?.marketplace_id || '-'}</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Pending lines</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: theme.violetSoft, marginTop: 6 }}>{status?.pending_count ?? 0}</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Active listings</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: theme.teal, marginTop: 6 }}>{status?.listing_count ?? 0}</div>
        </Card>
        <Card>
          <div style={{ fontSize: 11, color: theme.textFaint, textTransform: 'uppercase', fontWeight: 700 }}>Last order sync</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: theme.textStrong, marginTop: 8 }}>
            {status?.last_orders_sync_at ? new Date(Number(status.last_orders_sync_at)).toLocaleString() : '-'}
          </div>
          {status?.last_orders_error ? (
            <div style={{ fontSize: 12, color: theme.orange, marginTop: 4 }}>{status.last_orders_error}</div>
          ) : null}
        </Card>
      </div>

      <Card title="Credentials" style={sectionGap}>
        <p style={{ fontSize: 12, color: theme.textDim, marginTop: 0 }}>
          Paste sandbox App ID, Cert ID, and user refresh token. Env vars EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_REFRESH_TOKEN override DB.
          Leave secret fields blank to keep the stored value. Credentials are not included in Settings backup export.
        </p>
        <div className="ebay-form-row" style={formRow}>
          <div>
            <label style={labelStyle}>Environment</label>
            <select
              style={INPUT_STYLE}
              value={draft.environment || 'sandbox'}
              onChange={e => setDraft(d => ({ ...d, environment: e.target.value }))}
            >
              <option value="sandbox">sandbox</option>
              <option value="production">production</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Marketplace</label>
            <input
              style={INPUT_STYLE}
              value={draft.marketplace_id || ''}
              onChange={e => setDraft(d => ({ ...d, marketplace_id: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Auto-post when stock OK</label>
            <select
              style={INPUT_STYLE}
              value={draft.auto_post ? '1' : '0'}
              onChange={e => setDraft(d => ({ ...d, auto_post: e.target.value === '1' }))}
            >
              <option value="1">Enabled</option>
              <option value="0">Disabled (queue all)</option>
            </select>
          </div>
        </div>
        <div className="ebay-form-row" style={{ ...formRow, marginTop: 10 }}>
          <div>
            <label style={labelStyle}>Client ID {creds?.client_id ? `(${creds.client_id})` : ''}</label>
            <input
              style={INPUT_STYLE}
              placeholder="paste new value to replace"
              value={draft.client_id || ''}
              onChange={e => setDraft(d => ({ ...d, client_id: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Client secret {creds?.client_secret ? `(${creds.client_secret})` : ''}</label>
            <input
              style={INPUT_STYLE}
              type="password"
              placeholder="paste new value to replace"
              value={draft.client_secret || ''}
              onChange={e => setDraft(d => ({ ...d, client_secret: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Refresh token {creds?.refresh_token ? `(${creds.refresh_token})` : ''}</label>
            <input
              style={INPUT_STYLE}
              type="password"
              placeholder="paste new value to replace"
              value={draft.refresh_token || ''}
              onChange={e => setDraft(d => ({ ...d, refresh_token: e.target.value }))}
            />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button type="button" style={BTN_PRIMARY} disabled={busy} onClick={saveCredentials}>Save credentials</button>
        </div>
      </Card>

      <Card title="SKU mappings" style={sectionGap}>
        <div className="ebay-form-row" style={{ ...formRow, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>ERP item</label>
            <select
              style={INPUT_STYLE}
              value={newListing.item_id}
              onChange={e => setNewListing(n => ({ ...n, item_id: e.target.value }))}
            >
              <option value="">Select item</option>
              {(Array.isArray(items) ? items : []).map(it => (
                <option key={it.id} value={it.id}>{it.sku} - {it.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>eBay SKU</label>
            <input
              style={INPUT_STYLE}
              value={newListing.ebay_sku}
              onChange={e => setNewListing(n => ({ ...n, ebay_sku: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>Offer ID (required for push)</label>
            <input
              style={INPUT_STYLE}
              value={newListing.offer_id}
              onChange={e => setNewListing(n => ({ ...n, offer_id: e.target.value }))}
            />
          </div>
          <div>
            <label style={labelStyle}>&nbsp;</label>
            <button type="button" style={BTN_PRIMARY} disabled={busy} onClick={addListing}>Add mapping</button>
          </div>
        </div>
        <Table
          columns={[
            { key: 'ebay_sku', label: 'eBay SKU' },
            { key: 'item_sku', label: 'ERP SKU' },
            { key: 'item_name', label: 'Name' },
            { key: 'offer_id', label: 'Offer ID' },
            { key: 'last_pushed_qty', label: 'Pushed qty' },
            { key: 'last_pushed_price', label: 'Pushed price' },
            { key: 'last_error', label: 'Error', render: r => (
              <span style={{ color: r.last_error ? theme.orange : theme.textDim }}>{r.last_error || '-'}</span>
            ) },
            { key: 'actions', label: '', render: r => (
              <button type="button" style={btnSecondary} onClick={() => removeListing(r.id)}>Remove</button>
            ) },
          ]}
          rows={listings}
          rowKey={r => r.id}
        />
      </Card>

      <Card title="Pending order lines" style={sectionGap}>
        <Table
          columns={[
            { key: 'ebay_order_id', label: 'Order' },
            { key: 'ebay_sku', label: 'SKU' },
            { key: 'title', label: 'Title' },
            { key: 'qty', label: 'Qty' },
            { key: 'unit_price', label: 'Unit $' },
            { key: 'buyer_username', label: 'Buyer' },
            { key: 'item_id', label: 'Mapped', render: r => (r.item_id ? 'yes' : 'no') },
            { key: 'actions', label: '', render: r => (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" style={BTN_PRIMARY} disabled={busy} onClick={() => confirmPending(r, false)}>Confirm</button>
                {r.shortage ? (
                  <button type="button" style={btnSecondary} disabled={busy} onClick={() => confirmPending(r, true)}>Ack shortage</button>
                ) : null}
                <button type="button" style={btnSecondary} onClick={() => dismissPending(r)}>Dismiss</button>
              </div>
            ) },
          ]}
          rows={pending}
          rowKey={r => r.id}
        />
      </Card>

      <Card title="Recent orders" style={sectionGap}>
        <Table
          columns={[
            { key: 'order_id', label: 'Order ID' },
            { key: 'creation_date', label: 'Created' },
            { key: 'buyer_username', label: 'Buyer' },
            { key: 'total_amount', label: 'Total' },
            { key: 'order_payment_status', label: 'Payment' },
            { key: 'order_fulfillment_status', label: 'Fulfillment' },
          ]}
          rows={orders}
          rowKey={r => r.order_id}
        />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <Card title="Seller standards">
          <pre style={{
            fontSize: 11, color: theme.textDim, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 240, overflow: 'auto', margin: 0,
          }}>
            {standards ? JSON.stringify(standards.data || standards, null, 2) : 'No data (configure credentials and connect).'}
          </pre>
        </Card>
        <Card title="Traffic report (30d)">
          <pre style={{
            fontSize: 11, color: theme.textDim, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            maxHeight: 240, overflow: 'auto', margin: 0,
          }}>
            {traffic ? JSON.stringify(traffic.data || traffic, null, 2) : 'No data (configure credentials and connect).'}
          </pre>
        </Card>
      </div>

      {feedbackEl}
    </ErpShell>
  );
}
