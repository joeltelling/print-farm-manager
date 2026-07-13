const fs = require('fs');
const zlib = require('zlib');

// Bambu Studio .3mf files are ZIP archives. This module reads the internal
// Metadata/plate_1.json to extract layer_height. Print time, filament weight,
// filament type, and temperatures are NOT embedded in .3mf exports — those
// are generated at print time by the printer.

function readU32(buf, offset) { return buf.readUInt32LE(offset); }
function readU16(buf, offset) { return buf.readUInt16LE(offset); }

/**
 * Parse a .3mf (ZIP archive) and extract metadata from Metadata/plate_1.json.
 * Returns { layer_height: number|null } — other fields always null.
 */
const MAX_FILE_SIZE = 50 * 1024 * 1024;       // 50 MB — .3mf slice projects are rarely larger
const MAX_COMPRESSED_ENTRY = 10 * 1024 * 1024; // 10 MB — plate_1.json is a few KB

function parse3mfFile(filePath) {
  const result = { layer_height: null };

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stats = fs.fstatSync(fd);
    if (stats.size > MAX_FILE_SIZE) {
      console.warn(`[3mf-parser] Skipping ${filePath}: ${stats.size} bytes exceeds ${MAX_FILE_SIZE} byte limit`);
      return result;
    }
    const buf = Buffer.alloc(stats.size);
    fs.readSync(fd, buf, 0, stats.size, 0);

    // Find End of Central Directory (signature 0x06054b50)
    let eocdOffset = -1;
    for (let i = stats.size - 22; i >= 0; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
        eocdOffset = i; break;
      }
    }
    if (eocdOffset < 0) return result;

    const totalEntries = readU16(buf, eocdOffset + 10);
    const cdOffset = readU32(buf, eocdOffset + 16);

    let jsonOffset = -1, compressedSize = 0, compressionMethod = 0;
    let offset = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (readU32(buf, offset) !== 0x02014b50) break;
      const nameLen = readU16(buf, offset + 28);
      const name = buf.toString('utf-8', offset + 46, offset + 46 + nameLen);
      if (name === 'Metadata/plate_1.json') {
        compressionMethod = readU16(buf, offset + 10);
        compressedSize = readU32(buf, offset + 20);
        const localOffset = readU32(buf, offset + 42);
        const localNameLen = readU16(buf, localOffset + 26);
        const localExtraLen = readU16(buf, localOffset + 28);
        jsonOffset = localOffset + 30 + localNameLen + localExtraLen;
        break;
      }
      offset += 46 + nameLen + readU16(buf, offset + 30) + readU16(buf, offset + 32);
    }
    if (jsonOffset < 0) return result;
    if (compressedSize > MAX_COMPRESSED_ENTRY) {
      console.warn(`[3mf-parser] Skipping plate_1.json in ${filePath}: ${compressedSize} compressed bytes exceeds ${MAX_COMPRESSED_ENTRY} byte limit`);
      return result;
    }

    const compressed = buf.slice(jsonOffset, jsonOffset + compressedSize);
    let jsonStr;
    if (compressionMethod === 0) jsonStr = compressed.toString('utf-8');
    else if (compressionMethod === 8) {
        jsonStr = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_COMPRESSED_ENTRY }).toString('utf-8');
      }
    else return result;

    const json = JSON.parse(jsonStr);
    if (json && json.layer_height) result.layer_height = parseFloat(json.layer_height);
  } catch (err) {
    console.error(`[3mf-parser] Error reading ${filePath}:`, err.message);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }

  return result;
}

module.exports = { parse3mfFile };