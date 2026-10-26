import type { WireValue } from "@table-craft/desktop/engine/protocol.js";
import { visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { bufferRowAt, EMPTY_BUFFER, type EditBuffer } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { rowAt, shownHeld, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";

export type BytesWire = Extract<WireValue, { readonly kind: "bytes" }>;

const BYTES_PER_MIB = 1024 * 1024;
const HEX_PER_BYTE = 2;
const HEX_RADIX = 16;
const DEFAULT_EXTENSION = "bin";

export function isBytesWire(value: WireValue | undefined): value is BytesWire {
  return typeof value === "object" && value !== null && value.kind === "bytes";
}

/** Whether the value holds every byte, not just its preview. */
export function isWholeBytes(value: BytesWire): boolean {
  return value.preview.length === HEX_PER_BYTE * value.length;
}

/** The `data.blobLimitMb` setting in bytes. */
export function blobLimitBytes(megabytes: number): number {
  return megabytes * BYTES_PER_MIB;
}

/** A focused binary cell the engine holds: its grid row, held row and result column. */
export interface BinaryCell {
  readonly row: number;
  readonly held: number;
  readonly column: number;
  readonly value: BytesWire;
}

/** The focused cell when it holds bytes in a row the engine holds; null otherwise. */
export function focusedBinaryCell(result: ResultTab, buffer: EditBuffer = EMPTY_BUFFER): BinaryCell | null {
  const focus = result.selection?.focus;
  if (focus === undefined) return null;
  const column = visibleColumns(result.layout)[focus.column];
  if (column === undefined) return null;
  const held = bufferRowAt(buffer, shownHeld(result), focus.row);
  if (held?.kind !== "held") return null;
  const value = rowAt(result.windows, focus.row)?.[column];
  return isBytesWire(value) ? { row: focus.row, held: held.row, column, value } : null;
}

interface ImageSignature {
  readonly mime: string;
  readonly extension: string;
  /** Hex of the leading bytes; `..` matches any byte. */
  readonly magic: string;
}

/** File signatures from each format's specification (PNG 5.2, JFIF, GIF89a, RIFF/WebP). */
const IMAGE_SIGNATURES: readonly ImageSignature[] = [
  { mime: "image/png", extension: "png", magic: "89504e470d0a1a0a" },
  { mime: "image/jpeg", extension: "jpg", magic: "ffd8ff" },
  { mime: "image/gif", extension: "gif", magic: "474946383" },
  { mime: "image/webp", extension: "webp", magic: "52494646........57454250" },
];

function matches(hex: string, magic: string): boolean {
  if (hex.length < magic.length) return false;
  return [...magic].every((digit, index) => digit === "." || hex[index] === digit);
}

/** The image format whose signature the bytes start with, or null. */
export function imageOf(hex: string): ImageSignature | null {
  return IMAGE_SIGNATURES.find((signature) => matches(hex, signature.magic)) ?? null;
}

/** A file name to suggest when saving a cell: the column's name and the extension its signature names. */
export function suggestedFileName(column: string, hex: string): string {
  const base = column.replace(/[^\w.-]+/g, "_") || "value";
  return `${base}.${imageOf(hex)?.extension ?? DEFAULT_EXTENSION}`;
}

/** Hex as base64, without Node's `Buffer`, which the renderer has not got. */
export function base64OfHex(hex: string): string {
  const chars: string[] = [];
  for (let index = 0; index + 1 < hex.length; index += HEX_PER_BYTE) {
    chars.push(String.fromCharCode(Number.parseInt(hex.slice(index, index + HEX_PER_BYTE), HEX_RADIX)));
  }
  return btoa(chars.join(""));
}

/** A `data:` URL that draws the bytes, when they are a whole PNG, JPEG, GIF or WebP image. */
export function imageDataUrl(value: BytesWire): string | null {
  const image = imageOf(value.preview);
  if (image === null || !isWholeBytes(value)) return null;
  return `data:${image.mime};base64,${base64OfHex(value.preview)}`;
}
