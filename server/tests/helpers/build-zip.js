// Minimal ZIP builder for tests: produces a valid stored (uncompressed) archive
// from { entryName: content }. Enough structure for the upload route's
// central-directory walk (see listZipEntryNames in routes/gcodes.js); CRCs are
// zeroed since the validator never inflates entries.

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.from(content, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0, 8);          // method: stored
    local.writeUInt32LE(dataBuf.length, 18); // compressed size
    local.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, dataBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 10);          // method: stored
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);     // local header offset
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + dataBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// A minimal valid sliced Bambu .3mf: contains the one entry the farm prints.
function buildSliced3mf() {
  return buildZip({
    'Metadata/plate_1.gcode': 'G28\nG1 X10\n',
    '3D/3dmodel.model': '<model/>',
  });
}

module.exports = { buildZip, buildSliced3mf };
