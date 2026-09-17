// CoMa visual tokens. Pages copy these values (no CSS variables, no CSS framework).
// Reference: near-black chrome, lime KPI accents, violet actions, soft card depth.

export const theme = {
  // Chrome surfaces, darkest to lightest.
  shell: '#0a0b0f',
  page: '#0d0e14',
  sidebar: '#0f1017',
  panel: '#12131c',
  card: '#141620',
  cardAlt: '#181a27',
  cardSoft: '#171825',
  hover: '#1d1f2c',

  // Borders, soft to strong.
  borderSoft: '#1e202e',
  border: '#232639',
  borderStrong: '#2d3146',

  // Text ramp (zinc).
  text: '#f4f4f5',
  textBright: '#ffffff',
  textStrong: '#d4d4d8',
  textMuted: '#a1a1aa',
  textDim: '#71717a',
  textFaint: '#52525b',

  // Accents.
  accent: '#8b5cf6',
  accentDeep: '#7c3aed',
  accentSoft: 'rgba(139, 92, 246, 0.16)',
  lime: '#a3e635',
  limeDeep: '#84cc16',
  limeGlow: 'rgba(163, 230, 53, 0.25)',
  indigo: '#818cf8',
  indigoSoft: '#a5b4fc',
  cyan: '#22d3ee',
  orange: '#f59e0b',
  orangeDeep: '#d97706',
  amber: '#fbbf24',
  amberSoft: 'rgba(245, 158, 11, 0.12)',
  teal: '#2dd4bf',
  tealDeep: '#14b8a6',
  emerald: '#34d399',
  emeraldDeep: '#10b981',
  violet: '#a78bfa',
  violetDeep: '#8b5cf6',
  violetSoft: '#c4b5fd',
  red: '#f87171',
  redDeep: '#ef4444',

  // Geometry and depth.
  radius: 16,
  radiusSm: 12,
  radiusXs: 8,
  shadow: '0 4px 20px -2px rgba(0, 0, 0, 0.45), inset 0 1px 0 0 rgba(255, 255, 255, 0.04)',
  shadowLift: '0 16px 40px -8px rgba(0, 0, 0, 0.6)',
  glowLime: '0 0 25px -3px rgba(163, 230, 53, 0.35)',
  glowViolet: '0 0 25px -4px rgba(139, 92, 246, 0.4)',

  mono: "'JetBrains Mono', 'IBM Plex Mono', monospace",
};

export const CARD_STYLE = {
  background: theme.card,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radius,
  boxShadow: theme.shadow,
};

// Larger content panels (split grids, tables, chart blocks).
export const PANEL_STYLE = {
  background: theme.panel,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radius,
  boxShadow: theme.shadow,
};

export const INPUT_STYLE = {
  background: theme.shell,
  border: `1px solid ${theme.borderStrong}`,
  borderRadius: 10,
  padding: '8px 12px',
  color: theme.text,
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

export const BTN_PRIMARY = {
  background: `linear-gradient(90deg, ${theme.accentDeep} 0%, #4f46e5 100%)`,
  color: '#fff',
  border: 'none',
  borderRadius: theme.radiusSm,
  padding: '9px 16px',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
  boxShadow: theme.glowViolet,
};

export const BTN_SECONDARY = {
  background: theme.cardAlt,
  color: theme.textStrong,
  border: `1px solid ${theme.borderStrong}`,
  borderRadius: theme.radiusSm,
  padding: '8px 14px',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
};

// Small uppercase caption used above every value and panel title.
export const CAPTION_STYLE = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  color: theme.textMuted,
};

// Monospace metadata chip (counts, versions, sync state).
export const CHIP_STYLE = {
  fontFamily: theme.mono,
  fontSize: 10,
  fontWeight: 500,
  padding: '2px 7px',
  borderRadius: 6,
  background: theme.cardAlt,
  border: `1px solid ${theme.border}`,
  color: theme.textMuted,
  whiteSpace: 'nowrap',
};

/** Tinted badge (status pills, action counts). Pass any accent hex. */
export function tintStyle(color, alpha = 0.1) {
  return {
    background: hexAlpha(color, alpha),
    border: `1px solid ${hexAlpha(color, alpha * 2.5)}`,
    color,
  };
}

/** Hex to rgba, so one accent token drives fill, border, and glow. */
export function hexAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
