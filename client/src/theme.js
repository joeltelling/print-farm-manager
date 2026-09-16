// CoMa visual tokens. Pages copy these hex values (no CSS variables).
// Screenshot-inspired navy dashboard: rounded cards, lime/orange bars, teal donuts.

export const theme = {
  page: '#0b1220',
  sidebar: '#101828',
  card: '#151c2c',
  cardAlt: '#1a2332',
  border: '#243044',
  borderStrong: '#2d3d55',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textDim: '#64748b',
  textFaint: '#475569',
  accent: '#2563eb',
  accentDeep: '#1e40af',
  lime: '#4ade80',
  limeDeep: '#22c55e',
  orange: '#fb923c',
  orangeDeep: '#f97316',
  teal: '#2dd4bf',
  tealDeep: '#14b8a6',
  red: '#ef4444',
  redDeep: '#dc2626',
  radius: 14,
  radiusSm: 10,
};

export const CARD_STYLE = {
  background: theme.card,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radius,
};

export const INPUT_STYLE = {
  background: theme.page,
  border: `1px solid ${theme.borderStrong}`,
  borderRadius: 8,
  padding: '6px 10px',
  color: theme.text,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

export const BTN_PRIMARY = {
  background: theme.accent,
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};
