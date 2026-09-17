import PageHeader from '../../components/PageHeader';
import { theme, INPUT_STYLE, BTN_PRIMARY } from '../../theme';
import { useToast } from '../../useToast';
import { useConfirm } from '../../useConfirm';

export { theme, INPUT_STYLE, BTN_PRIMARY };

// Module navigation lives in the CoMa sidebar (App.jsx). ErpShell is header + page body only.
export function ErpShell({ title = 'ERP', subtitle, children }) {
  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle || 'ERP linked to shopfloor: product=project, component=part. Manufactured and outsource.'}
      />
      {children}
    </div>
  );
}

export function Table({ columns, rows, rowKey }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map(c => (
              <th
                key={c.key}
                onClick={c.onSort || undefined}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  color: theme.textFaint,
                  borderBottom: `1px solid ${theme.border}`,
                  fontWeight: 600,
                  cursor: c.onSort ? 'pointer' : 'default',
                  userSelect: c.onSort ? 'none' : undefined,
                }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} style={{ padding: 16, color: theme.textDim }}>No rows yet.</td></tr>
          )}
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row) : (row.id ?? row.sku ?? i)}>
              {columns.map(c => (
                <td key={c.key} style={{ padding: '8px 10px', borderBottom: `1px solid ${theme.border}`, color: theme.textMuted }}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const labelStyle = { fontSize: 12, color: theme.textDim, display: 'block', marginBottom: 4 };
export const formRow = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, alignItems: 'end' };
export const btnSecondary = {
  background: 'transparent',
  color: theme.textMuted,
  border: `1px solid ${theme.borderStrong}`,
  borderRadius: 10,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

export function useErpFeedback() {
  const [showToast, toastEl] = useToast();
  const [confirm, confirmModal] = useConfirm();
  return {
    showToast,
    confirm,
    feedbackEl: <>{toastEl}{confirmModal}</>,
  };
}

export async function apiJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || body.detail || res.statusText || String(res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
