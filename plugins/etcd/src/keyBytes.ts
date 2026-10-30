import type { KeyBytes } from "@table-craft/plugin-api";

/** A leading byte order mark is part of the key: stripping it would name a different key. */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });
const HEX_RADIX = 16;
const HEX_WIDTH = 2;
const ASCII_LAST = 0x7f;
const CONTINUATION_FIRST = 0x80;
const CONTINUATION_LAST = 0xbf;

/**
 * The lead bytes of each valid UTF-8 sequence with the range its second byte must fall in, which
 * rules out overlong forms and surrogates (RFC 3629, section 4).
 */
const LEADS: readonly (readonly [first: number, last: number, length: number, low: number, high: number])[] = [
  [0xc2, 0xdf, 2, CONTINUATION_FIRST, CONTINUATION_LAST],
  [0xe0, 0xe0, 3, 0xa0, CONTINUATION_LAST],
  [0xe1, 0xec, 3, CONTINUATION_FIRST, CONTINUATION_LAST],
  [0xed, 0xed, 3, CONTINUATION_FIRST, 0x9f],
  [0xee, 0xef, 3, CONTINUATION_FIRST, CONTINUATION_LAST],
  [0xf0, 0xf0, 4, 0x90, CONTINUATION_LAST],
  [0xf1, 0xf3, 4, CONTINUATION_FIRST, CONTINUATION_LAST],
  [0xf4, 0xf4, 4, CONTINUATION_FIRST, 0x8f],
];

/** The length of the valid UTF-8 sequence starting at `at`, or 0 when the byte there starts none. */
function sequenceAt(bytes: Uint8Array, at: number): number {
  const lead = bytes[at] ?? 0;
  if (lead <= ASCII_LAST) return 1;
  const shape = LEADS.find(([first, last]) => lead >= first && lead <= last);
  if (shape === undefined) return 0;
  const [, , length, low, high] = shape;
  const second = bytes[at + 1];
  if (second === undefined || second < low || second > high) return 0;
  for (let offset = 2; offset < length; offset += 1) {
    const next = bytes[at + offset];
    if (next === undefined || next < CONTINUATION_FIRST || next > CONTINUATION_LAST) return 0;
  }
  return length;
}

/** Bytes as `KeyBytes` (decision 113): text with each invalid byte `\xNN`, and the hex when any is. */
export function keyBytesOf(bytes: Uint8Array): KeyBytes {
  let text = "";
  let start = 0;
  let valid = true;
  let at = 0;
  while (at < bytes.length) {
    const length = sequenceAt(bytes, at);
    if (length > 0) {
      at += length;
      continue;
    }
    valid = false;
    text += UTF8.decode(bytes.subarray(start, at));
    text += `\\x${(bytes[at] ?? 0).toString(HEX_RADIX).padStart(HEX_WIDTH, "0")}`;
    at += 1;
    start = at;
  }
  text += UTF8.decode(bytes.subarray(start));
  return { text, hex: valid ? null : Buffer.from(bytes).toString("hex") };
}

/** The bytes `KeyBytes` stand for: the hex when present, else the text as UTF-8. */
export function bytesOf(key: KeyBytes): Buffer {
  return key.hex === null ? Buffer.from(key.text, "utf8") : Buffer.from(key.hex, "hex");
}

/** Text as `KeyBytes`, for a name the user typed. */
export function textBytes(text: string): KeyBytes {
  return { text, hex: null };
}
