// Runs the G-code parser off the main thread so large files do not freeze the UI. All of the
// parsing logic lives in client/src/lib/gcode-parse.js, which is unit tested in plain Node.
import { parseGcode } from './lib/gcode-parse.js';

self.onmessage = (e) => {
  const extrudeArr = parseGcode(e.data);
  self.postMessage({ extrude: extrudeArr }, [extrudeArr.buffer]);
};
