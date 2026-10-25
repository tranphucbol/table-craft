import { decode as decodeMessagePack } from "@msgpack/msgpack";
import type { KeyBytes, WireValue } from "@table-craft/desktop/engine/protocol.js";

/** How the value panel reads a key's bytes (plan 058 decision 15). */
export const VALUE_FORMATS = ["auto", "text", "json", "hex", "base64", "msgpack", "gzip"] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];
export type ConcreteFormat = Exclude<ValueFormat, "auto">;

export const FORMAT_LABELS: Readonly<Record<ValueFormat, string>> = {
  auto: "Auto",
  text: "Text",
  json: "JSON",
  hex: "Hex",
  base64: "Base64",
  msgpack: "MessagePack",
  gzip: "gzip",
};

/** Formats whose text turns back into the same bytes; MessagePack and gzip show read-only. */
export const EDITABLE_FORMATS: ReadonlySet<ConcreteFormat> = new Set(["text", "json", "hex", "base64"]);

/** gzip's magic bytes, RFC 1952 section 2.3.1. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;
const HEX_RADIX = 16;
const JSON_INDENT = 2;
const HEX_PAIR = /^[0-9a-f]{2}$/i;

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

/** What Auto reads `bytes` as: gzip by its magic, JSON when it parses, Text when UTF-8, else Hex. */
export function detectFormat(bytes: Uint8Array): ConcreteFormat {
  if (isGzip(bytes)) return "gzip";
  const text = utf8Text(bytes);
  if (text === null) return "hex";
  return jsonText(text) === null ? "text" : "json";
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
  if (format === "base64") return { format, text: btoa(String.fromCharCode(...bytes)), inner: null, error: null };
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
