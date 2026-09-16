import { theme } from '../theme';

export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      marginBottom: 20,
      flexWrap: 'wrap',
    }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: theme.text, letterSpacing: '-0.02em' }}>
          {title}
        </h1>
        {subtitle && (
          <div style={{ fontSize: 13, color: theme.textDim, marginTop: 4 }}>{subtitle}</div>
        )}
      </div>
      {actions && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {actions}
        </div>
      )}
    </div>
  );
}
