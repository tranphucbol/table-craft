import { z, type KeyBytes, type KeyRecord, type KeyTransferEntry, type KeyRange } from "@table-craft/plugin-api";
import { invalidOperation } from "./scope.js";

export const TRANSFER_MAX_FILE_BYTES = 134_217_728;
export const TRANSFER_MAX_RECORDS = 100_000;
export const TRANSFER_MAX_VALUE_BYTES = 1_048_576;
const MAX_HEADER_CHARS = 1_048_576;
const MAX_RECORD_CHARS = 6_291_456;
const MAX_INPUT_CHUNK_BYTES = 16_777_216;
const FORMAT = "tablecraft-keyspace";
const VERSION = 1;
const decimal = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .max(20);
const encoded = z.strictObject({ encoding: z.enum(["utf8", "base64"]), data: z.string().max(MAX_RECORD_CHARS) });
const revision = z.strictObject({
  createRevision: decimal,
  modRevision: decimal,
  version: decimal,
  lease: z
    .string()
    .regex(/^-?(?:0|[1-9][0-9]*)$/)
    .max(20),
});
const recordSchema = z.strictObject({ key: encoded, value: encoded, revision });
const headerSchema = z.strictObject({
  format: z.literal(FORMAT),
  version: z.literal(VERSION),
  clusterId: decimal,
  namespace: encoded,
  revision: decimal,
  records: z.array(z.never()).length(0),
});

export interface TransferHeader {
  readonly clusterId: string;
  readonly namespace: KeyBytes;
  readonly revision: string;
}

export function keyBuffer(bytes: KeyBytes): Buffer {
  return bytes.hex === null ? Buffer.from(bytes.text, "utf8") : Buffer.from(bytes.hex, "hex");
}

export function keyIdentity(bytes: KeyBytes): string {
  return keyBuffer(bytes).toString("hex");
}

function asKey(bytes: Buffer): KeyBytes {
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes)
    ? { text, hex: null }
    : {
        text: [...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join(""),
        hex: bytes.toString("hex"),
      };
}

function decode(value: z.infer<typeof encoded>): KeyBytes {
  const bytes = Buffer.from(value.data, value.encoding === "utf8" ? "utf8" : "base64");
  if (
    bytes.length > TRANSFER_MAX_VALUE_BYTES ||
    (value.encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8")) !== value.data
  )
    throw invalidOperation("Import contains invalid encoding or oversized bytes.");
  return asKey(bytes);
}

function encode(value: KeyBytes) {
  const bytes = keyBuffer(value);
  if (bytes.length > TRANSFER_MAX_VALUE_BYTES) throw invalidOperation("A transfer record exceeds the value budget.");
  const text = bytes.toString("utf8");
  return Buffer.from(text).equals(bytes)
    ? { encoding: "utf8", data: text }
    : { encoding: "base64", data: bytes.toString("base64") };
}

export function exportHeader(header: TransferHeader): string {
  return (
    JSON.stringify({
      format: FORMAT,
      version: VERSION,
      clusterId: header.clusterId,
      namespace: encode(header.namespace),
      revision: header.revision,
    }).slice(0, -1) + ',"records":[\n'
  );
}

export function exportRecord(record: KeyRecord): string {
  return JSON.stringify({ key: encode(record.key), value: encode(record.value), revision: record.revision });
}

export function inRange(key: KeyBytes, range: KeyRange): boolean {
  const bytes = keyBuffer(key);
  switch (range.kind) {
    case "all":
      return true;
    case "key":
      return bytes.equals(keyBuffer(range.key));
    case "prefix": {
      const prefix = keyBuffer(range.prefix);
      return bytes.subarray(0, prefix.length).equals(prefix);
    }
    case "range":
      return bytes.compare(keyBuffer(range.from)) >= 0 && bytes.compare(keyBuffer(range.to)) < 0;
  }
}

export type ParsedTransfer =
  | { readonly kind: "header"; readonly header: TransferHeader }
  | { readonly kind: "record"; readonly entry: KeyTransferEntry };

/** Stream one JSON document: bounded metadata first, then records; never materialize the array. */
export async function* parseTransfer(source: AsyncIterable<Uint8Array>): AsyncGenerator<ParsedTransfer> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let state: "header" | "record" | "delimiter" | "end" | "done" = "header";
  let text = "";
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let records = 0;
  let total = 0;
  let needRecord = false;
  const seen = new Set<string>();
  async function* decoded(): AsyncGenerator<string> {
    for await (const chunk of source) {
      total += chunk.byteLength;
      if (total > TRANSFER_MAX_FILE_BYTES || chunk.byteLength > MAX_INPUT_CHUNK_BYTES)
        throw invalidOperation("Import exceeds its input budget.");
      yield decoder.decode(chunk, { stream: true });
    }
    yield decoder.decode();
  }
  for await (const chunk of decoded()) {
    for (const char of chunk) {
      if (state === "done") {
        if (!/\s/.test(char)) throw invalidOperation("Unexpected data after the import document.");
        continue;
      }
      if (state === "end") {
        if (/\s/.test(char)) continue;
        if (char !== "}") throw invalidOperation("Records must be the final field of the import document.");
        state = "done";
        continue;
      }
      if (state === "delimiter") {
        if (/\s/.test(char)) continue;
        if (char === "]") {
          state = "end";
          continue;
        }
        if (char !== ",") throw invalidOperation("Expected an import record separator.");
        needRecord = true;
        state = "record";
        continue;
      }
      if (state === "record" && text.length === 0) {
        if (/\s/.test(char)) continue;
        if (char === "]" && !needRecord) {
          state = "end";
          continue;
        }
        if (char !== "{") throw invalidOperation("Every import record must be a JSON object.");
      }
      text += char;
      if (text.length > (state === "header" ? MAX_HEADER_CHARS : MAX_RECORD_CHARS))
        throw invalidOperation("Import metadata or record exceeds its size budget.");
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (state === "header" && char === "[" && depth === 1 && /"records"\s*:\s*\[$/.test(text)) {
        const header = headerSchema.parse(JSON.parse(text.slice(0, -1) + "[]} "));
        yield {
          kind: "header",
          header: { clusterId: header.clusterId, namespace: decode(header.namespace), revision: header.revision },
        };
        state = "record";
        text = "";
        depth = 0;
        continue;
      }
      if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") depth -= 1;
      if (depth < 0) throw invalidOperation("Malformed import document.");
      if (state === "record" && depth === 0) {
        records += 1;
        if (records > TRANSFER_MAX_RECORDS) throw invalidOperation("Import has too many records.");
        const value = recordSchema.parse(JSON.parse(text));
        const key = decode(value.key);
        const identity = keyIdentity(key);
        if (seen.has(identity)) throw invalidOperation("Import contains duplicate binary keys.");
        seen.add(identity);
        yield {
          kind: "record",
          entry: { key, value: decode(value.value), expectedModRevision: value.revision.modRevision },
        };
        text = "";
        needRecord = false;
        state = "delimiter";
      }
    }
  }
  if (state !== "done" || quoted || depth !== 0)
    throw invalidOperation("Import ended before its complete JSON document.");
}
