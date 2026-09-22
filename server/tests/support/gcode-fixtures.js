// Shared byte-fixture builders for server/gcode-thumbnail.js tests
// (server/tests/gcode-thumbnail.test.js and server/tests/gcodes-thumbnail-route.test.js).
// See gcode-thumbnail.js's own header comment for the format specs these follow.

const zlib = require('zlib');

function buildBgcode(blocks, { checksumType = 0 } = {}) {
  const parts = [Buffer.alloc(10)];
  parts[0].write('GCDE', 0, 'ascii');
  parts[0].writeUInt32LE(1, 4);
  parts[0].writeUInt16LE(checksumType, 8);

  for (const b of blocks) {
    const compression = b.compression ?? 0;
    const paramsSize = b.type === 5 ? 6 : 2;
    const params = Buffer.alloc(paramsSize);
    if (b.type === 5) {
      params.writeUInt16LE(b.format, 0);
      params.writeUInt16LE(b.width, 2);
      params.writeUInt16LE(b.height, 4);
    }
    const uncompressed = b.data || Buffer.alloc(0);
    const compressed = compression === 1 ? zlib.deflateRawSync(uncompressed) : uncompressed;

    const header = Buffer.alloc(compression === 0 ? 8 : 12);
    header.writeUInt16LE(b.type, 0);
    header.writeUInt16LE(compression, 2);
    header.writeUInt32LE(uncompressed.length, 4);
    if (compression !== 0) header.writeUInt32LE(compressed.length, 8);

    parts.push(header, params, compressed);
    if (checksumType !== 0) parts.push(Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const method = e.method ?? 0;
    const compressed = method === 8 ? zlib.deflateRawSync(e.data) : e.data;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(e.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntryOffset = offset;
    localParts.push(localHeader, nameBuf, compressed);
    offset += localHeader.length + nameBuf.length + compressed.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(e.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localEntryOffset, 42);
    centralParts.push(centralHeader, nameBuf);
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

module.exports = { buildBgcode, buildZip };
