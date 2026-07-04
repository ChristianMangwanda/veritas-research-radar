/**
 * Minimal zero-dependency ZIP reader — just enough to pull one CSV out of the
 * IPEDS HD archive (~1MB, fits in memory). Supports stored (0) and deflate (8)
 * entries; anything else fails loudly.
 */

const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 65535;

function findEndOfCentralDirectory(buffer) {
  const scanFloor = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_LENGTH);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= scanFloor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP: end-of-central-directory signature not found');
}

function listZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`ZIP: bad central-directory record at ${offset}`);
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Extracts the first entry whose name satisfies entryNameMatcher(name).
 * @returns {Buffer} decompressed entry content
 */
function extractZipEntry(buffer, entryNameMatcher) {
  const entries = listZipEntries(buffer);
  const entry = entries.find((candidate) => entryNameMatcher(candidate.name));
  if (!entry) {
    throw new Error(`ZIP: no entry matched; archive contains: ${entries.map((e) => e.name).join(', ')}`);
  }
  const headerOffset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(headerOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`ZIP: bad local header for ${entry.name}`);
  }
  // Local header name/extra lengths can differ from the central record
  const nameLength = buffer.readUInt16LE(headerOffset + 26);
  const extraLength = buffer.readUInt16LE(headerOffset + 28);
  const dataStart = headerOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return Buffer.from(data);
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(data);
  throw new Error(`ZIP: unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
}

module.exports = { extractZipEntry, listZipEntries };
