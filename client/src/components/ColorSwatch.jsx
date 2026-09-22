// Small colored square next to a material/color badge, same visual as the
// Filament Library admin table's swatch (Settings.jsx). Renders nothing if
// there's no hex to show, rather than a gray placeholder: an unset hex is the
// common case for a printer's loaded_color and shouldn't demand attention.
export default function ColorSwatch({ hex, size = 10 }) {
  if (!hex) return null;
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: 3,
      background: hex, border: '1px solid rgba(255,255,255,0.15)',
      boxShadow: '0 1px 2px rgba(0,0,0,0.4)', flexShrink: 0,
    }} />
  );
}
