import PageHeader from '../components/PageHeader';
import Card from '../components/Card';
import { theme } from '../theme';

const FUTURE = [
  'Article master (raw, buy, make, packaging, service)',
  'BOM / recipes with quantities and cost percentages',
  'Inventory ledger for materials, made parts, and purchased parts',
  'Cost drivers: electricity, plastic, shipping, packaging, ads, sales platform',
  'Production orders that release work to shopfloor machines',
  'Invoicing (numbering + PDF), separate from printer jobs',
];

export default function Erp() {
  return (
    <div>
      <PageHeader
        title="ERP"
        subtitle="Production definition, inventory, costing, and invoices. Shopfloor execution stays under Fleet / Projects / Jobs."
      />

      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: theme.textMuted, lineHeight: 1.65, marginBottom: 12 }}>
          CoMa is ERP-first. The 3D printer shopfloor you already use is the first machine connector
          (<code style={{ color: theme.violetSoft }}>3d_printer</code>). Laser, plotter, and other
          machine types will be added by development when needed. They will not behave the same,
          so each gets its own connector.
        </div>
        <div style={{ fontSize: 13, color: theme.textDim, lineHeight: 1.6 }}>
          Domain rules and the event bridge are written in{' '}
          <strong style={{ color: theme.textMuted }}>docs/erp/README.md</strong>.
          No ERP API or database is mounted yet; this page reserves the product home in the shell.
        </div>
      </Card>

      <Card>
        <div style={{
          fontSize: 12, fontWeight: 700, color: theme.textFaint,
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12,
        }}>
          Planned modules
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: theme.textMuted, fontSize: 13, lineHeight: 1.8 }}>
          {FUTURE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
