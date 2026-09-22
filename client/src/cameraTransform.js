import { useState, useCallback } from 'react';

// Builds the CSS transform for a camera image from the rotation/flip preferences
// GET /api/printers/:id/camera returns (camera_rotation/camera_flip_h/camera_flip_v
// on the printer row: a display preference the app applies itself, not something
// read from the connector). Shared by every place a camera image renders: the
// printer detail camera card, the Dashboard fleet grid's hover preview
// (useCameraHover.jsx), and the Webcams page.
export function cameraTransform(camera) {
  if (!camera) return undefined;
  const parts = [];
  if (camera.rotation) parts.push(`rotate(${camera.rotation}deg)`);
  if (camera.flipH) parts.push('scaleX(-1)');
  if (camera.flipV) parts.push('scaleY(-1)');
  return parts.length ? parts.join(' ') : undefined;
}

function isSideways(camera) {
  return !!camera && (camera.rotation === 90 || camera.rotation === 270);
}

// `rotate()` only repaints pixels; it never changes an element's own layout box.
// A landscape stream rotated 90/270 degrees therefore overflows (or leaves an
// oversized gap in) whatever box was sized for its unrotated width and height:
// that mismatch is the "window size is wrong" bug rotated cameras showed. This
// shrinks the rotated image by the ratio of its own short side to its long side
// (read from the loaded <img> itself via useNaturalSize below), which is exactly
// the scale that makes a 90/270 rotation fit back inside its original box without
// guessing at a fixed aspect ratio that would be wrong for non-4:3 streams. At
// 0/180 degrees rotation never changes the box size, so this is a no-op.
export function rotationFitTransform(camera, natural) {
  const base = cameraTransform(camera);
  if (!isSideways(camera) || !natural || !natural.w || !natural.h) return base;
  const fit = Math.min(natural.w, natural.h) / Math.max(natural.w, natural.h);
  return base ? `${base} scale(${fit})` : `scale(${fit})`;
}

// Tracks an <img>'s natural pixel size for rotationFitTransform. Spread the
// returned onLoad handler onto the <img>; natural size is unknown (and
// rotationFitTransform falls back to the plain rotate/flip transform) until the
// browser reports it, which for a cached image is effectively immediate.
export function useNaturalSize() {
  const [natural, setNatural] = useState(null);
  const onLoad = useCallback((e) => {
    const { naturalWidth: w, naturalHeight: h } = e.target;
    if (w && h) setNatural({ w, h });
  }, []);
  return [natural, onLoad];
}
