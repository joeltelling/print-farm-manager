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
