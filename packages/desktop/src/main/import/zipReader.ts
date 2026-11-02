import { inflateRawSync } from "node:zlib";

/**
 * Reads one entry of a ZIP archive, enough for MySQL Workbench's Backup Connections file (Python's
 * `zipfile`, stored or DEFLATE). Offsets and signatures follow PKWARE's APPNOTE.TXT, sections
 * 4.3.7 (local header), 4.3.12 (central directory) and 4.3.16 (end of central directory). No
 * ZIP64, encryption or multi-disk archives.
 */
export class ZipReadError extends Error {
  override readonly name = "ZipReadError";
}

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x1;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function endOfCentralDirectory(data: DataView): number {
  const lowest = Math.max(0, data.byteLength - END_SIZE - MAX_COMMENT);
  for (let offset = data.byteLength - END_SIZE; offset >= lowest; offset--) {
    if (data.getUint32(offset, true) === END_SIGNATURE) return offset;
  }
  throw new ZipReadError("The file is not a ZIP archive.");
}

function inside(data: DataView, offset: number, length: number): void {
  if (offset < 0 || offset + length > data.byteLength) throw new ZipReadError("The ZIP archive is truncated.");
}

/** The entry's bytes, or null when the archive has no entry by that name. */
export function readZipEntry(bytes: Uint8Array, name: string, maxBytes: number): Uint8Array | null {
  const data = view(bytes);
  const end = endOfCentralDirectory(data);
  const count = data.getUint16(end + 10, true);
  let offset = data.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    inside(data, offset, CENTRAL_SIZE);
    if (data.getUint32(offset, true) !== CENTRAL_SIGNATURE) throw new ZipReadError("The ZIP directory is damaged.");
    const flags = data.getUint16(offset + 8, true);
    const method = data.getUint16(offset + 10, true);
    const compressedSize = data.getUint32(offset + 20, true);
    const size = data.getUint32(offset + 24, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localOffset = data.getUint32(offset + 42, true);
    inside(data, offset + CENTRAL_SIZE, nameLength);
    const entryName = decoder.decode(bytes.subarray(offset + CENTRAL_SIZE, offset + CENTRAL_SIZE + nameLength));
    offset += CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if ((flags & FLAG_ENCRYPTED) !== 0) throw new ZipReadError(`${name} in the archive is encrypted.`);
    if (size > maxBytes) throw new ZipReadError(`${name} in the archive is too large.`);
    inside(data, localOffset, LOCAL_SIZE);
    if (data.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new ZipReadError("The ZIP archive is damaged.");
    const start =
      localOffset + LOCAL_SIZE + data.getUint16(localOffset + 26, true) + data.getUint16(localOffset + 28, true);
    inside(data, start, compressedSize);
    const stored = bytes.subarray(start, start + compressedSize);
    if (method === METHOD_STORED) return stored;
    if (method !== METHOD_DEFLATE) throw new ZipReadError(`${name} in the archive uses an unsupported compression.`);
    try {
      return new Uint8Array(inflateRawSync(stored, { maxOutputLength: maxBytes }));
    } catch {
      throw new ZipReadError(`${name} in the archive could not be decompressed.`);
    }
  }
  return null;
}
