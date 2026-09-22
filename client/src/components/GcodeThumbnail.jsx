import { useState } from 'react';

// Embedded plate thumbnail for a G-code (.bgcode/.3mf; plain .gcode never has
// one), from GET /api/gcodes/:id/thumbnail. Renders nothing at all rather than
// a broken-image icon when there's no gcodeId, or the request 404s (no file
// on disk, unrecognized format, or no thumbnail block/entry found): this is
// a nice-to-have visual aid, not something worth a placeholder for.
export default function GcodeThumbnail({ gcodeId, size = 32 }) {
  const [failed, setFailed] = useState(false);
  if (!gcodeId || failed) return null;
  return (
    <img
      src={`/api/gcodes/${gcodeId}/thumbnail`}
      alt=""
      onError={() => setFailed(true)}
      style={{
        width: size, height: size, objectFit: 'cover', borderRadius: 4,
        background: '#0f172a', flexShrink: 0,
      }}
    />
  );
}
