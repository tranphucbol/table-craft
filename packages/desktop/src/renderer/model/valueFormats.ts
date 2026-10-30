import { decode as decodeMessagePack } from "@msgpack/msgpack";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify as stringifyYaml,
  type Node as YamlNode,
} from "yaml";
import type { KeyBytes, WireValue } from "@table-craft/desktop/engine/protocol.js";

/** How the value panel reads a key's bytes (plan 058 decision 15). */
export const VALUE_FORMATS = ["auto", "text", "json", "yaml", "hex", "base64", "msgpack", "gzip"] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];
export type ConcreteFormat = Exclude<ValueFormat, "auto">;

export const FORMAT_LABELS: Readonly<Record<ValueFormat, string>> = {
  auto: "Auto",
  text: "Text",
  json: "JSON",
  yaml: "YAML",
  hex: "Hex",
  base64: "Base64",
  msgpack: "MessagePack",
  gzip: "gzip",
};

/** Formats whose text turns back into the same bytes; MessagePack and gzip show read-only. */
export const EDITABLE_FORMATS: ReadonlySet<ConcreteFormat> = new Set(["text", "json", "yaml", "hex", "base64"]);

export type YamlValue = null | boolean | number | bigint | string | YamlValue[] | { [key: string]: YamlValue };
export const MAX_YAML_BYTES = 1_048_576;
const MAX_YAML_DEPTH = 64;
const MAX_YAML_NODES = 50_000;

function yamlDocument(text: string, losslessNumbers = false) {
  if (encoder.encode(text).length > MAX_YAML_BYTES) throw new Error("YAML is limited to 1 MiB here.");
  const document = parseDocument(text, {
    schema: "core",
    version: "1.2",
    customTags: [],
    resolveKnownTags: false,
    uniqueKeys: true,
    intAsBigInt: true,
    strict: true,
    merge: false,
    prettyErrors: false,
  });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem !== undefined) throw new Error(problem.message);
  const pending: { node: YamlNode | null; depth: number }[] = [{ node: document.contents, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined || entry.node === null) continue;
    const { node, depth } = entry;
    if (++count > MAX_YAML_NODES || depth > MAX_YAML_DEPTH)
      throw new Error("YAML is too deeply nested or has too many items.");
    if (isAlias(node) || node.anchor !== undefined) throw new Error("YAML anchors and aliases are not supported here.");
    if (node.tag !== undefined) throw new Error("Explicit YAML tags are not supported here.");
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          throw new Error("YAML mapping keys must be strings here.");
        if (pair.key.value === "<<") throw new Error("YAML merge keys are not supported here.");
        pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value as YamlNode | null, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const item of node.items) pending.push({ node: item as YamlNode | null, depth: depth + 1 });
    } else if (isScalar(node) && typeof node.value === "number") {
      if (!Number.isFinite(node.value)) throw new Error("Non-finite YAML numbers are not supported here.");
      if (losslessNumbers && String(node.value) !== node.source)
        throw new Error("This YAML number cannot be normalized without changing its spelling.");
    }
  }
  return document;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Structured YAML only; scalar text is never mistaken for a YAML document by Auto or Merge. */
export function parseKeyYaml(text: string): YamlValue[] | { [key: string]: YamlValue } {
  if (encoder.encode(text).length > MAX_YAML_BYTES) throw new Error("YAML is limited to 1 MiB here.");
  if (isJson(text)) throw new Error("JSON documents are handled as JSON, not normalized as YAML.");
  const document = yamlDocument(text, true);
  if (!isMap(document.contents) && !isSeq(document.contents)) throw new Error("Not a YAML mapping or sequence.");
  return document.toJS({ maxAliasCount: 0 }) as YamlValue[] | { [key: string]: YamlValue };
}

export function normalizedKeyYaml(value: YamlValue): string {
  return stringifyYaml(value, { schema: "core", aliasDuplicateObjects: false });
}

/** gzip's magic bytes, RFC 1952 section 2.3.1. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;
const HEX_RADIX = 16;
const JSON_INDENT = 2;
const HEX_PAIR = /^[0-9a-f]{2}$/i;
const KUBERNETES_MAGIC = [0x6b, 0x38, 0x73, 0x00] as const;
const HEX_ROW_BYTES = 16;
const PRINTABLE_ASCII_START = 0x20;
const PRINTABLE_ASCII_END = 0x7e;
const BASE64_CHUNK_BYTES = 0x8000;
export const KUBERNETES_VALUE_NOTICE =
  "Kubernetes protobuf envelope detected. Decoding is not supported here; raw bytes are read-only. Edit this object through the Kubernetes API.";

export function isKubernetesEnvelope(bytes: Uint8Array): boolean {
  return KUBERNETES_MAGIC.every((byte, index) => bytes[index] === byte);
}

export function isKubernetesKeyValue(value: KeyBytes): boolean {
  return isKubernetesEnvelope(value.hex === null ? encoder.encode(value.text) : bytesOfHex(value.hex));
}

export function hexRows(
  bytes: Uint8Array,
): readonly { readonly offset: string; readonly hex: string; readonly ascii: string }[] {
  const rows: { offset: string; hex: string; ascii: string }[] = [];
  for (let offset = 0; offset < bytes.length; offset += HEX_ROW_BYTES) {
    const row = bytes.subarray(offset, offset + HEX_ROW_BYTES);
    rows.push({
      offset: offset.toString(HEX_RADIX).padStart(8, "0"),
      hex: Array.from(row, (byte) => byte.toString(HEX_RADIX).padStart(2, "0")).join(" "),
      ascii: Array.from(row, (byte) =>
        byte >= PRINTABLE_ASCII_START && byte <= PRINTABLE_ASCII_END ? String.fromCharCode(byte) : ".",
      ).join(""),
    });
  }
  return rows;
}

export interface DecodedValue {
  /** The format the bytes were read as; Auto resolves to one. */
  readonly format: ConcreteFormat;
  readonly text: string;
  /** For gzip: what the inflated bytes were read as. */
  readonly inner: ConcreteFormat | null;
  /** Why the bytes do not read in the chosen format; the text then shows them as hex. */
  readonly error: string | null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function bytesOfHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), HEX_RADIX);
  }
  return bytes;
}

export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(2, "0")).join("");
}

/** `bytes` as the engine takes them: the text when they are UTF-8, else their hex. */
export function keyBytesOf(bytes: Uint8Array): KeyBytes {
  const text = utf8Text(bytes);
  return text === null ? { text: "", hex: hexOf(bytes) } : { text, hex: null };
}

/** A cell's or string key's bytes: text as UTF-8, bytes from their full hex; null for anything else. */
export function valueBytes(value: WireValue | undefined): Uint8Array | null {
  if (typeof value === "string") return encoder.encode(value);
  if (
    typeof value === "object" &&
    value !== null &&
    value.kind === "bytes" &&
    value.preview.length === value.length * 2
  ) {
    return bytesOfHex(value.preview);
  }
  if (typeof value === "object" && value !== null && value.kind === "json") return encoder.encode(value.text);
  return null;
}

function utf8Text(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
}

function jsonText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, JSON_INDENT);
  } catch {
    return null;
  }
}

/** Auto detects envelopes first, then JSON and supported YAML collections, text, or binary. */
export function detectFormat(bytes: Uint8Array): ConcreteFormat {
  if (isKubernetesEnvelope(bytes)) return "hex";
  if (isGzip(bytes)) return "gzip";
  const text = utf8Text(bytes);
  if (text === null) return "hex";
  if (jsonText(text) !== null) return "json";
  try {
    const document = yamlDocument(text);
    if (!isMap(document.contents) && !isSeq(document.contents)) return "text";
    return "yaml";
  } catch {
    return "text";
  }
}

async function inflated(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function messagePackText(bytes: Uint8Array): string {
  const value = decodeMessagePack(bytes, { useBigInt64: true });
  return JSON.stringify(
    value,
    (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item instanceof Uint8Array ? hexOf(item) : item,
    JSON_INDENT,
  );
}

function failed(format: ConcreteFormat, bytes: Uint8Array, error: string): DecodedValue {
  return { format, text: hexOf(bytes), inner: null, error };
}

function plain(format: Exclude<ConcreteFormat, "gzip">, bytes: Uint8Array): DecodedValue {
  if (format === "hex") return { format, text: hexOf(bytes), inner: null, error: null };
  if (format === "base64") {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
    return { format, text: btoa(binary), inner: null, error: null };
  }
  if (format === "msgpack") {
    try {
      return { format, text: messagePackText(bytes), inner: null, error: null };
    } catch (cause) {
      return failed(format, bytes, `Not MessagePack: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  const text = utf8Text(bytes);
  if (text === null) return failed(format, bytes, "Not valid UTF-8; shown as hex.");
  if (format === "text") return { format, text, inner: null, error: null };
  if (format === "yaml") {
    try {
      yamlDocument(text);
      return { format, text, inner: null, error: null };
    } catch (cause) {
      return {
        format,
        text,
        inner: null,
        error: `Not supported YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  }
  const json = jsonText(text);
  return json === null
    ? { format, text, inner: null, error: "Not a JSON object or array." }
    : { format, text: json, inner: null, error: null };
}

/** `bytes` read as `format`; Auto picks one, and gzip reads what it inflates to as Auto would. */
export async function decodeValue(bytes: Uint8Array, format: ValueFormat): Promise<DecodedValue> {
  const concrete = format === "auto" ? detectFormat(bytes) : format;
  if (concrete !== "gzip") return plain(concrete, bytes);
  try {
    const inner = await inflated(bytes);
    const innerFormat = detectFormat(inner);
    const decoded = plain(innerFormat === "gzip" ? "hex" : innerFormat, inner);
    return { ...decoded, format: "gzip", inner: decoded.format };
  } catch {
    return failed("gzip", bytes, "Not gzip data; shown as hex.");
  }
}

export type EncodedValue =
  { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: string };

function base64Bytes(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text.replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The bytes an edit in `format` writes; refused when the text does not read in that format. */
export function encodeValue(text: string, format: ConcreteFormat): EncodedValue {
  if (format === "text") return { ok: true, bytes: encoder.encode(text) };
  if (format === "yaml") {
    try {
      yamlDocument(text);
      return { ok: true, bytes: encoder.encode(text) };
    } catch (cause) {
      return { ok: false, error: `Not supported YAML: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
  }
  if (format === "json") {
    try {
      JSON.parse(text);
    } catch (cause) {
      return { ok: false, error: `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    return { ok: true, bytes: encoder.encode(text) };
  }
  if (format === "hex") {
    const digits = text.replace(/\s+/g, "");
    const pairs = digits.match(/.{1,2}/g) ?? [];
    if (digits.length % 2 !== 0 || !pairs.every((pair) => HEX_PAIR.test(pair))) {
      return { ok: false, error: "Hex takes pairs of digits 0-9 and a-f." };
    }
    return { ok: true, bytes: bytesOfHex(digits) };
  }
  if (format === "base64") {
    const bytes = base64Bytes(text);
    return bytes === null ? { ok: false, error: "Not valid Base64." } : { ok: true, bytes };
  }
  return { ok: false, error: `${FORMAT_LABELS[format]} values open read-only.` };
}

/** The pattern a key's format is remembered under: its last segment becomes `*` (`user:42:*`). */
export function formatPattern(key: string, delimiter: string): string {
  if (delimiter === "") return key;
  const cut = key.lastIndexOf(delimiter);
  return cut === -1 ? "*" : `${key.slice(0, cut + delimiter.length)}*`;
}
