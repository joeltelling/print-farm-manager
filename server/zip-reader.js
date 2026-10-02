// Minimal ZIP reader. A .3mf project file is a ZIP archive, so reading slicer
// metadata out of one means walking the archive by hand. Plain buffer parsing plus
// Node's built-in zlib: no new dependency, which matters because the production farm
// machine is Windows and every native module is a rebuild risk (see the Node >=22 <24
// pin in package.json).
//
// ZIP layout reference: APPNOTE.TXT (PKWARE), sections 4.3.7 (local file header),
// 4.3.12 (central directory file header) and 4.3.16 (end of central directory).
//
// Every function returns null rather than throwing on a malformed archive. Callers are
// upload handlers: "this file is not readable" is a 400 with an instructive message,
// never a 500.

const zlib = require('zlib');

const EOCD_SIG    = 0x06054b50; // end of central directory
const CENTRAL_SIG = 0x02014b50; // central directory file header
const LOCAL_SIG   = 0x04034b50; // local file header

const METHOD_STORED  = 0;
const METHOD_DEFLATE = 8;

// Refuse to inflate anything bigger than this. The metadata entries we read are a few
// KB; the sliced G-code inside a .3mf can be hundreds of MB, and inflating one to pull
// out a comment would blow the farm machine's memory during an upload. Must comfortably
// exceed the largest metadata entry a slicer writes (slice_info.config, project
// settings), not the G-code entry.
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

// Walk the central directory. Returns an array of entry descriptors, or null when the
// buffer is not a parseable ZIP.
function readCentralDirectory(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;

  // The EOCD sits at the very end, possibly followed by a comment of up to 65535 bytes.
  const scanFloor = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) return null;

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset     = buf.readUInt32LE(eocd + 16);
  // ZIP64 markers. No slicer output comes close to these limits, but if one ever does,
  // report "unparseable" rather than misreading offsets as if they were 32-bit.
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) return null;

  const entries = [];
  let pos = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIG) return null;
    const nameLen    = buf.readUInt16LE(pos + 28);
    const extraLen   = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    if (pos + 46 + nameLen > buf.length) return null;

    entries.push({
      name:              buf.toString('utf8', pos + 46, pos + 46 + nameLen),
      method:            buf.readUInt16LE(pos + 10),
      // Sizes come from the central directory, never the local header: an archive
      // written in streaming mode (general purpose bit 3) leaves the local header
      // sizes as zero and puts the real values in a trailing data descriptor.
      compressedSize:    buf.readUInt32LE(pos + 20),
      uncompressedSize:  buf.readUInt32LE(pos + 24),
      localHeaderOffset: buf.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Entry names only. Kept as its own export because callers that just need to know
// whether an entry exists should not pay for, or think about, decompression.
function listEntryNames(buf) {
  const entries = readCentralDirectory(buf);
  return entries === null ? null : entries.map(e => e.name);
}

// Read one entry by exact name and return its decompressed bytes, or null when the
// entry is absent, too large, compressed with a method we do not implement, or corrupt.
function readEntry(buf, name, maxBytes = MAX_ENTRY_BYTES) {
  const entries = readCentralDirectory(buf);
  if (entries === null) return null;

  const entry = entries.find(e => e.name === name);
  if (!entry) return null;
  if (entry.uncompressedSize > maxBytes || entry.compressedSize > maxBytes) return null;
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) return null;

  // The local header's extra field can differ in length from the central directory's,
  // so the data offset has to be computed from the local header itself.
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== LOCAL_SIG) return null;
  const lhNameLen  = buf.readUInt16LE(lh + 26);
  const lhExtraLen = buf.readUInt16LE(lh + 28);
  const dataStart  = lh + 30 + lhNameLen + lhExtraLen;
  const dataEnd    = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) return null;

  const raw = buf.subarray(dataStart, dataEnd);
  if (entry.method === METHOD_STORED) return Buffer.from(raw);
  try {
    return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch (_) {
    return null;
  }
}

module.exports = { readCentralDirectory, listEntryNames, readEntry, MAX_ENTRY_BYTES };
