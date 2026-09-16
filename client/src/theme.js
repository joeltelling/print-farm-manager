// CoMa visual tokens. Pages copy these hex values (no CSS variables).
// Reference: near-black chrome, lime KPI accents, violet charts, soft card depth.

export const theme = {
  page: '#07070a',
  sidebar: '#0c0c10',
  card: '#121218',
  cardAlt: '#18181f',
  border: '#23232e',
  borderStrong: '#2e2e3a',
  text: '#f4f4f5',
  textMuted: '#a1a1aa',
  textDim: '#71717a',
  textFaint: '#52525b',
  accent: '#8b5cf6',
  accentDeep: '#7c3aed',
  accentSoft: 'rgba(139, 92, 246, 0.16)',
  lime: '#a3e635',
  limeDeep: '#84cc16',
  limeGlow: 'rgba(163, 230, 53, 0.22)',
  orange: '#fb923c',
  orangeDeep: '#f97316',
  teal: '#2dd4bf',
  tealDeep: '#14b8a6',
  violet: '#a78bfa',
  violetDeep: '#8b5cf6',
  violetSoft: '#c4b5fd',
  red: '#f87171',
  redDeep: '#ef4444',
  radius: 16,
  radiusSm: 12,
  shadow: '0 12px 40px rgba(0,0,0,0.35)',
};

export const CARD_STYLE = {
  background: theme.card,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radius,
  boxShadow: theme.shadow,
};

export const INPUT_STYLE = {
  background: theme.page,
  border: `1px solid ${theme.borderStrong}`,
  borderRadius: 10,
  padding: '7px 12px',
  color: theme.text,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

export const BTN_PRIMARY = {
  background: theme.accentDeep,
  color: '#fff',
  border: 'none',
  borderRadius: 999,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};
