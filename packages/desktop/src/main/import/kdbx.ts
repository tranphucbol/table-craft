import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { childText, descendants, parseXml } from "@table-craft/desktop/main/import/xml.js";

/**
 * Reads the KeePass database IntelliJ keeps its passwords in when "In KeePass" is chosen, and the
 * main key file beside it. IntelliJ writes KDBX 3.1 (`platform/credential-store-impl/src/
 * credentialStore/kdbx/KdbxHeader.kt`, Apache-2.0): AES-KDF, AES-256-CBC, SHA-256 hashed blocks,
 * GZip, and ChaCha20 (or, from older files, Salsa20) over protected values. The format is KeePass's
 * own, documented at https://keepass.info/help/kb/kdbx.html; KDBX 4 files are reported as unsupported.
 */
export type KdbxProblem = "wrongKey" | "unsupported" | "corrupt";

export class KdbxError extends Error {
  override readonly name = "KdbxError";
  constructor(
    readonly problem: KdbxProblem,
    message: string,
  ) {
    super(message);
  }
}

export interface KdbxEntry {
  readonly title: string;
  readonly user: string | null;
  readonly password: string | null;
}

const SIGNATURE_1 = 0x9aa2d903;
const SIGNATURE_2 = 0xb54bfb67;
const MAJOR_VERSION_3 = 3;
const VERSION_MAJOR_SHIFT = 16;
const AES_CIPHER_ID = "31c1f2e6bf714350be5805216afc5aff";
const HEADER_END = 0;
const HEADER_CIPHER_ID = 2;
const HEADER_COMPRESSION = 3;
const HEADER_MASTER_SEED = 4;
const HEADER_TRANSFORM_SEED = 5;
const HEADER_TRANSFORM_ROUNDS = 6;
const HEADER_ENCRYPTION_IV = 7;
const HEADER_PROTECTED_STREAM_KEY = 8;
const HEADER_STREAM_START_BYTES = 9;
const HEADER_INNER_RANDOM_STREAM = 10;
const COMPRESSION_GZIP = 1;
const INNER_STREAM_SALSA20 = 2;
const INNER_STREAM_CHACHA20 = 3;
const HASH_BYTES = 32;
const STREAM_START_BYTES = 32;
const CHACHA_KEY_BYTES = 32;
const CHACHA_NONCE_BYTES = 12;
const CHACHA_COUNTER_BYTES = 4;
/** KeePass's fixed Salsa20 IV for protected values (KDBX 3.1). */
const SALSA20_IV = Buffer.from([0xe8, 0x30, 0x09, 0x4b, 0x97, 0x20, 0x5d, 0x2a]);
/** `EncryptionSupport.kt`: the BUILT_IN main-key cipher is AES-128-CBC under this fixed key. */
const BUILT_IN_KEY = Buffer.from("Proxy Config Sec", "latin1");
const BUILT_IN = "BUILT_IN";
const IV_LENGTH_BYTES = 4;

function sha256(...parts: Uint8Array[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** IntelliJ's `c.pwd`: YAML with `encryption:` and a `value: !!binary` base64 blob. */
export function readMainKey(text: string): Uint8Array {
  const encryption = /^encryption:\s*(\S+)/m.exec(text)?.[1]?.toUpperCase() ?? BUILT_IN;
  if (encryption !== BUILT_IN) {
    throw new KdbxError(
      "unsupported",
      `The KeePass main key is protected by ${encryption}, which TableCraft cannot read.`,
    );
  }
  const value = /^value:\s*(?:!!binary)?\s*([\s\S]*)$/m.exec(text)?.[1];
  if (value === undefined) throw new KdbxError("corrupt", "The KeePass main key file has no value.");
  const blob = Buffer.from(value.split(/\r?\n(?=\S)/)[0]?.replace(/\s+/g, "") ?? "", "base64");
  const ivLength = blob.length >= IV_LENGTH_BYTES ? blob.readUInt32BE(0) : -1;
  if (ivLength <= 0 || IV_LENGTH_BYTES + ivLength > blob.length) {
    throw new KdbxError("corrupt", "The KeePass main key file is damaged.");
  }
  const iv = blob.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + ivLength);
  try {
    const decipher = createDecipheriv("aes-128-cbc", BUILT_IN_KEY, iv);
    return Buffer.concat([decipher.update(blob.subarray(IV_LENGTH_BYTES + ivLength)), decipher.final()]);
  } catch {
    throw new KdbxError("corrupt", "The KeePass main key file is damaged.");
  }
}

class Reader {
  offset = 0;
  constructor(readonly buffer: Buffer) {}
  take(count: number): Buffer {
    if (this.offset + count > this.buffer.length) throw new KdbxError("corrupt", "The KeePass file ends early.");
    const slice = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }
  u8(): number {
    return this.take(1).readUInt8(0);
  }
  u16(): number {
    return this.take(2).readUInt16LE(0);
  }
  u32(): number {
    return this.take(4).readUInt32LE(0);
  }
}

interface Header {
  cipherId: string;
  compression: number;
  masterSeed: Buffer;
  transformSeed: Buffer;
  transformRounds: bigint;
  encryptionIv: Buffer;
  protectedStreamKey: Buffer;
  streamStartBytes: Buffer;
  innerStream: number;
}

function readHeader(reader: Reader): Header {
  if (reader.u32() !== SIGNATURE_1 || reader.u32() !== SIGNATURE_2) {
    throw new KdbxError("corrupt", "This is not a KeePass database.");
  }
  const version = reader.u32();
  if (version >>> VERSION_MAJOR_SHIFT !== MAJOR_VERSION_3) {
    throw new KdbxError("unsupported", "This KeePass database uses a format version TableCraft does not read.");
  }
  const header: Header = {
    cipherId: "",
    compression: 0,
    masterSeed: Buffer.alloc(0),
    transformSeed: Buffer.alloc(0),
    transformRounds: 0n,
    encryptionIv: Buffer.alloc(0),
    protectedStreamKey: Buffer.alloc(0),
    streamStartBytes: Buffer.alloc(0),
    innerStream: 0,
  };
  for (;;) {
    const type = reader.u8();
    const data = reader.take(reader.u16());
    if (type === HEADER_END) break;
    if (type === HEADER_CIPHER_ID) header.cipherId = data.toString("hex");
    else if (type === HEADER_COMPRESSION) header.compression = data.readUInt32LE(0);
    else if (type === HEADER_MASTER_SEED) header.masterSeed = data;
    else if (type === HEADER_TRANSFORM_SEED) header.transformSeed = data;
    else if (type === HEADER_TRANSFORM_ROUNDS) header.transformRounds = data.readBigUInt64LE(0);
    else if (type === HEADER_ENCRYPTION_IV) header.encryptionIv = data;
    else if (type === HEADER_PROTECTED_STREAM_KEY) header.protectedStreamKey = data;
    else if (type === HEADER_STREAM_START_BYTES) header.streamStartBytes = data;
    else if (type === HEADER_INNER_RANDOM_STREAM) header.innerStream = data.readUInt32LE(0);
  }
  if (header.cipherId !== AES_CIPHER_ID) {
    throw new KdbxError("unsupported", "This KeePass database uses a cipher TableCraft does not read.");
  }
  return header;
}

function masterKey(header: Header, password: Uint8Array): Buffer {
  let transformed: Buffer = sha256(sha256(password));
  const cipher = createCipheriv("aes-256-ecb", header.transformSeed, null).setAutoPadding(false);
  for (let round = 0n; round < header.transformRounds; round++) transformed = cipher.update(transformed);
  return sha256(header.masterSeed, sha256(transformed));
}

function unhashBlocks(reader: Reader): Buffer {
  const blocks: Buffer[] = [];
  for (;;) {
    reader.u32();
    const hash = reader.take(HASH_BYTES);
    const size = reader.u32();
    if (size === 0) break;
    const block = reader.take(size);
    if (!sha256(block).equals(hash)) throw new KdbxError("corrupt", "A KeePass block failed its hash check.");
    blocks.push(block);
  }
  return Buffer.concat(blocks);
}

const SALSA_ROUNDS = 20;
const SALSA_CONSTANTS = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function rotate(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

/**
 * A Salsa20/20 keystream (Bernstein, "Salsa20 specification", 2005) for a 32-byte key and an
 * 8-byte nonce; node:crypto has no Salsa20. Each call returns the next `length` bytes.
 */
export function salsa20(key: Buffer, nonce: Buffer): (length: number) => Buffer {
  const input = new Uint32Array(16);
  input[0] = SALSA_CONSTANTS[0] ?? 0;
  input[5] = SALSA_CONSTANTS[1] ?? 0;
  input[10] = SALSA_CONSTANTS[2] ?? 0;
  input[15] = SALSA_CONSTANTS[3] ?? 0;
  for (let i = 0; i < 4; i++) {
    input[1 + i] = key.readUInt32LE(i * 4);
    input[11 + i] = key.readUInt32LE(16 + i * 4);
  }
  input[6] = nonce.readUInt32LE(0);
  input[7] = nonce.readUInt32LE(4);
  let pending = Buffer.alloc(0);
  const block = (): Buffer => {
    const x = Uint32Array.from(input);
    const quarter = (a: number, b: number, c: number, d: number) => {
      x[b] = (x[b] ?? 0) ^ rotate(((x[a] ?? 0) + (x[d] ?? 0)) | 0, 7);
      x[c] = (x[c] ?? 0) ^ rotate(((x[b] ?? 0) + (x[a] ?? 0)) | 0, 9);
      x[d] = (x[d] ?? 0) ^ rotate(((x[c] ?? 0) + (x[b] ?? 0)) | 0, 13);
      x[a] = (x[a] ?? 0) ^ rotate(((x[d] ?? 0) + (x[c] ?? 0)) | 0, 18);
    };
    for (let round = 0; round < SALSA_ROUNDS; round += 2) {
      quarter(0, 4, 8, 12);
      quarter(5, 9, 13, 1);
      quarter(10, 14, 2, 6);
      quarter(15, 3, 7, 11);
      quarter(0, 1, 2, 3);
      quarter(5, 6, 7, 4);
      quarter(10, 11, 8, 9);
      quarter(15, 12, 13, 14);
    }
    const out = Buffer.alloc(64);
    for (let i = 0; i < 16; i++) out.writeUInt32LE((((x[i] ?? 0) + (input[i] ?? 0)) | 0) >>> 0, i * 4);
    input[8] = ((input[8] ?? 0) + 1) >>> 0;
    if (input[8] === 0) input[9] = ((input[9] ?? 0) + 1) >>> 0;
    return out;
  };
  return (length) => {
    while (pending.length < length) pending = Buffer.concat([pending, block()]);
    const taken = pending.subarray(0, length);
    pending = pending.subarray(length);
    return taken;
  };
}

function innerStream(header: Header): (length: number) => Buffer {
  if (header.innerStream === INNER_STREAM_CHACHA20) {
    const hash = createHash("sha512").update(header.protectedStreamKey).digest();
    const iv = Buffer.concat([
      Buffer.alloc(CHACHA_COUNTER_BYTES),
      hash.subarray(CHACHA_KEY_BYTES, CHACHA_KEY_BYTES + CHACHA_NONCE_BYTES),
    ]);
    const cipher = createCipheriv("chacha20", hash.subarray(0, CHACHA_KEY_BYTES), iv);
    return (length) => cipher.update(Buffer.alloc(length));
  }
  if (header.innerStream === INNER_STREAM_SALSA20) return salsa20(sha256(header.protectedStreamKey), SALSA20_IV);
  throw new KdbxError("unsupported", "This KeePass database protects values in a way TableCraft does not read.");
}

/**
 * Opens a KDBX 3.1 database with `password` (the main key's bytes) and returns its entries. Throws
 * `wrongKey` when the key does not open it.
 */
export function readKdbx(bytes: Uint8Array, password: Uint8Array): KdbxEntry[] {
  const reader = new Reader(Buffer.from(bytes));
  const header = readHeader(reader);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", masterKey(header, password), header.encryptionIv);
    plain = Buffer.concat([decipher.update(reader.buffer.subarray(reader.offset)), decipher.final()]);
  } catch {
    throw new KdbxError("wrongKey", "The main key does not open this KeePass database.");
  }
  if (!plain.subarray(0, STREAM_START_BYTES).equals(header.streamStartBytes)) {
    throw new KdbxError("wrongKey", "The main key does not open this KeePass database.");
  }
  let payload = unhashBlocks(new Reader(plain.subarray(STREAM_START_BYTES)));
  if (header.compression === COMPRESSION_GZIP) payload = gunzipSync(payload);
  const document = parseXml(payload.toString("utf8"));
  const root = descendants(document, "Root")[0];
  if (root === undefined) return [];
  const keystream = innerStream(header);
  const entries: KdbxEntry[] = [];
  for (const entry of descendants(root, "Entry")) {
    // History entries are older copies; their protected values still advance the stream.
    const fields: Record<string, string> = {};
    for (const string of entry.children.filter((node) => node.name === "String")) {
      const key = childText(string, "Key");
      const valueElement = string.children.find((node) => node.name === "Value");
      if (key === null || valueElement === undefined) continue;
      if (valueElement.attributes.Protected === "True") {
        const cipherText = Buffer.from(valueElement.text, "base64");
        const mask = keystream(cipherText.length);
        fields[key] = Buffer.from(cipherText.map((byte, index) => byte ^ (mask[index] ?? 0))).toString("utf8");
      } else {
        fields[key] = valueElement.text;
      }
    }
    const title = fields.Title;
    if (title !== undefined) {
      entries.push({ title, user: fields.UserName ?? null, password: fields.Password ?? null });
    }
  }
  return entries;
}
