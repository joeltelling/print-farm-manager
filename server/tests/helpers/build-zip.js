// Minimal ZIP builder for tests: produces a valid archive from
// { entryName: content }. Enough structure for the central-directory walk and the
// entry reads in server/zip-reader.js; CRCs are zeroed, which neither the validator
// nor inflateRaw checks.
//
// Entries are stored (uncompressed) by default. Pass { deflate: true } to compress
// them instead, which is what real slicers emit: the reader has to locate the entry
// data past the local header and inflate it, and only a deflated fixture exercises
// that path.

const zlib = require('zlib');

function buildZip(entries, { deflate = false } = {}) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const method = deflate ? 8 : 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf  = Buffer.from(content, 'utf8');
    const dataBuf = deflate ? zlib.deflateRawSync(rawBuf) : rawBuf;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(dataBuf.length, 18); // compressed size
    local.writeUInt32LE(rawBuf.length, 22);  // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, dataBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(rawBuf.length, 24);
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

// The slice_info.config Orca and Bambu Studio write for a sliced plate. Only the two
// values the farm reads are parameterised; pass null to omit either, which is what a
// slicer does when it has no figure (Orca omits weight entirely when it is zero).
// Field names verified against OrcaSlicer source, see server/slicer-metadata.js.
function buildSliceInfoConfig({ index = 1, predictionSecs = 4383, weightGrams = 17.24 } = {}) {
  const rows = [`    <metadata key="index" value="${index}"/>`];
  if (predictionSecs !== null) rows.push(`    <metadata key="prediction" value="${predictionSecs}"/>`);
  if (weightGrams !== null)    rows.push(`    <metadata key="weight" value="${weightGrams}"/>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    '  <plate>',
    ...rows,
    '    <filament id="1" type="PLA" color="#000000" used_m="5.75" used_g="17.24"/>',
    '  </plate>',
    '</config>',
    '',
  ].join('\n');
}

module.exports = { buildZip, buildSliced3mf, buildSliceInfoConfig };
