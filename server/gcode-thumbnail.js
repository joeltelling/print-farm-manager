// Extracts an embedded plate thumbnail from a sliced file, for the G-code
// list/job row thumbnail preview (GET /api/gcodes/:id/thumbnail). Two real,
// documented formats, read from their actual specs, never guessed:
//
//   .bgcode  Prusa's binary G-code container: a file header followed by
//            typed, length-prefixed blocks (Thumbnail is one of them).
//            https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md
//
//   .3mf     A ZIP (OPC) container. Bambu Studio / OrcaSlicer write the
//            default plate thumbnail at "Metadata/plate_1.png" (or
//            "Metadata/plate_<N>.png" for additional plates), confirmed
//            against OrcaSlicer's own source (src/libslic3r/Format/bbs_3mf.cpp,
//            THUMBNAIL_FILE / THUMBNAIL_FILE_FORMAT constants), not guessed.
//            The ZIP local/central-directory format itself is the standard
//            PKWARE format, read here directly rather than via a dependency.
//
// Plain .gcode has no embedded thumbnail: extractThumbnail returns null for it.
const zlib = require('zlib');

// ─── .bgcode ─────────────────────────────────────────────────────────────────

const BGCODE_MAGIC = 'GCDE';
const BLOCK_TYPE_THUMBNAIL = 5;
const COMPRESSION_NONE = 0;
const COMPRESSION_DEFLATE = 1;
// 2 = Heatshrink(11,4), 3 = Heatshrink(12,4) per the spec: niche embedded-systems
// compression with no Node/zlib support and no dependency-free decoder available.
// A thumbnail block using either is skipped (not guessed at, not mis-decoded).
const THUMBNAIL_FORMAT_MIME = { 0: 'image/png', 1: 'image/jpeg' }; // 2 = QOI: no browser support, skipped

function fromBgcode(buf) {
  if (buf.length < 10 || buf.toString('ascii', 0, 4) !== BGCODE_MAGIC) return null;
  const checksumType = buf.readUInt16LE(8);
  // Only CRC32 (=1) is currently defined; treat any nonzero value the same way
  // (a 4-byte trailer) since "0 = None" is the only value that means no trailer.
  const checksumSize = checksumType === 0 ? 0 : 4;

  let offset = 10;
  let best = null; // prefer the largest thumbnail by pixel area, if more than one

  while (offset + 8 <= buf.length) {
    const type = buf.readUInt16LE(offset);
    const compression = buf.readUInt16LE(offset + 2);
    const uncompressedSize = buf.readUInt32LE(offset + 4);
    let headerSize = 8;
    let compressedSize = uncompressedSize;
    if (compression !== COMPRESSION_NONE) {
      if (offset + 12 > buf.length) break;
      compressedSize = buf.readUInt32LE(offset + 8);
      headerSize = 12;
    }

    const paramsOffset = offset + headerSize;
    // Every block type's parameters start with a 2-byte field; Thumbnail's is
    // Format+Width+Height (6 bytes total), every other current block type is
    // just a 2-byte Encoding field. Skipping unread block kinds the same way.
    const paramsSize = type === BLOCK_TYPE_THUMBNAIL ? 6 : 2;
    if (paramsOffset + paramsSize > buf.length) break;

    const dataSize = compression === COMPRESSION_NONE ? uncompressedSize : compressedSize;
    const dataOffset = paramsOffset + paramsSize;
    if (dataOffset + dataSize > buf.length) break;

    if (type === BLOCK_TYPE_THUMBNAIL) {
      const format = buf.readUInt16LE(paramsOffset);
      const width = buf.readUInt16LE(paramsOffset + 2);
      const height = buf.readUInt16LE(paramsOffset + 4);
      const mimeType = THUMBNAIL_FORMAT_MIME[format];
      if (mimeType && (compression === COMPRESSION_NONE || compression === COMPRESSION_DEFLATE)) {
        try {
          const raw = buf.subarray(dataOffset, dataOffset + dataSize);
          const data = compression === COMPRESSION_DEFLATE ? zlib.inflateRawSync(raw) : Buffer.from(raw);
          const area = width * height;
          if (!best || area > best.area) best = { mimeType, data, area };
        } catch (_) { /* corrupt block: skip it, keep scanning for another */ }
      }
    }

    offset = dataOffset + dataSize + checksumSize;
  }

  return best ? { mimeType: best.mimeType, data: best.data } : null;
}

// ─── .3mf (ZIP/OPC container) ────────────────────────────────────────────────

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIR_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;

function pickThreeMfEntryName(names) {
  const byLower = new Map(names.map(n => [n.toLowerCase(), n]));
  if (byLower.has('metadata/plate_1.png')) return byLower.get('metadata/plate_1.png');
  const platePattern = /^metadata\/plate_\d+\.png$/;
  const anyPlate = names.find(n => platePattern.test(n.toLowerCase()));
  if (anyPlate) return anyPlate;
  if (byLower.has('metadata/bbl_thumbnail.png')) return byLower.get('metadata/bbl_thumbnail.png');
  return null;
}

// The EOCD record has a variable-length comment (0-65535 bytes) after its
// fixed 22-byte body, so it isn't at a fixed offset from the end of the file:
// scan backward for its signature, same as any standard ZIP reader has to.
function readZipEntries(buf) {
  const EOCD_MIN_SIZE = 22;
  const MAX_COMMENT_LEN = 65535;
  const searchStart = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT_LEN);
  let eocdOffset = -1;
  for (let i = buf.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) return [];

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== ZIP_CENTRAL_DIR_SIGNATURE) break;
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntryData(buf, entry) {
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== ZIP_LOCAL_HEADER_SIGNATURE) return null;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) return null;
  const raw = buf.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(raw); // stored, no compression
  if (entry.compressionMethod === 8) {
    try { return zlib.inflateRawSync(raw); } catch (_) { return null; }
  }
  return null; // any other ZIP compression method (rare in a 3mf) is unsupported
}

function fromThreeMf(buf) {
  const entries = readZipEntries(buf);
  if (entries.length === 0) return null;
  const targetName = pickThreeMfEntryName(entries.map(e => e.name));
  if (!targetName) return null;
  const entry = entries.find(e => e.name === targetName);
  const data = readZipEntryData(buf, entry);
  return data ? { mimeType: 'image/png', data } : null;
}

// ─── Dispatch by extension ───────────────────────────────────────────────────

function extractThumbnail(filename, buf) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'bgcode') return fromBgcode(buf);
  if (ext === '3mf') return fromThreeMf(buf);
  return null;
}

module.exports = { extractThumbnail, fromBgcode, fromThreeMf };
