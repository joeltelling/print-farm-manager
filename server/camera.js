/**
 * Shared camera snapshot fetch used by the proxy route and timelapse capture.
 */
const axios = require('axios');
const { getDriver } = require('./drivers');

async function resolveCameraInfo(printer, cameraInfoFor) {
  if (typeof cameraInfoFor === 'function') {
    return cameraInfoFor(printer);
  }
  if (printer.camera_snapshot_url || printer.camera_stream_url) {
    return {
      available: true,
      name: 'configured',
      snapshotUrl: printer.camera_snapshot_url || printer.camera_stream_url,
      streamUrl: printer.camera_stream_url || printer.camera_snapshot_url,
    };
  }
  try {
    const driver = getDriver(printer.type);
    if (typeof driver.getCameraInfo === 'function') {
      return driver.getCameraInfo(printer);
    }
  } catch (_) { /* unknown type */ }
  return null;
}

/**
 * Returns a JPEG Buffer or null when the camera is unavailable.
 */
async function fetchSnapshotBuffer(printer, cameraInfoFor) {
  const info = await resolveCameraInfo(printer, cameraInfoFor);
  if (!info?.available || !info.snapshotUrl) return null;
  const img = await axios.get(info.snapshotUrl, {
    responseType: 'arraybuffer',
    timeout: 8000,
  });
  return Buffer.from(img.data);
}

module.exports = { fetchSnapshotBuffer, resolveCameraInfo };
