import { TextDecoder } from "node:util";

const ASCII_MAX = 0x7f;
const CONTINUATION_MIN = 0x80;
const CONTINUATION_MAX = 0xbf;
const TWO_BYTE_MIN = 0xc2;
const THREE_BYTE_MIN = 0xe0;
const FOUR_BYTE_MIN = 0xf0;
const FOUR_BYTE_MAX = 0xf4;
/** After E0 the next byte must be A0..BF (no overlong forms); after ED, 80..9F (no surrogates). */
const OVERLONG_THREE = 0xe0;
const SURROGATE_THREE = 0xed;
const OVERLONG_FOUR = 0xf0;
const BEYOND_UNICODE_FOUR = 0xf4;
const THREE_OVERLONG_LOWER = 0xa0;
const SURROGATE_UPPER = 0x9f;
const FOUR_OVERLONG_LOWER = 0x90;
const FOUR_BEYOND_UPPER = 0x8f;

/** Bytes that are not UTF-8; `offset` is where the bad sequence starts, counted from the first byte. */
export class Utf8Error extends Error {
  override readonly name = "Utf8Error";
  constructor(readonly offset: number) {
    super(`The file is not UTF-8 text: byte ${String(offset)} starts an invalid sequence.`);
  }
}

/** A strict streaming UTF-8 decoder that drops a leading byte-order mark (plan 041, decision 8). */
export interface Utf8Decoder {
  /** Text the bytes complete; a character split across chunks waits for the next one. */
  push(bytes: Uint8Array): string;
  /** The rest; throws when the input ended inside a character. */
  end(): string;
}

/**
 * Validates as it decodes, after the WHATWG UTF-8 decoder, so a bad file fails with the byte offset
 * a user can find in a hex editor; `TextDecoder`'s own fatal mode says only that it failed.
 */
export function utf8Decoder(): Utf8Decoder {
  const decoder = new TextDecoder("utf-8");
  let offset = 0;
  let needed = 0;
  let sequenceStart = 0;
  let lower = CONTINUATION_MIN;
  let upper = CONTINUATION_MAX;

  function validate(bytes: Uint8Array): void {
    for (let index = 0; index < bytes.length; index++, offset++) {
      const byte = bytes[index] ?? 0;
      if (needed === 0) {
        sequenceStart = offset;
        if (byte <= ASCII_MAX) continue;
        lower = CONTINUATION_MIN;
        upper = CONTINUATION_MAX;
        if (byte >= TWO_BYTE_MIN && byte < THREE_BYTE_MIN) needed = 1;
        else if (byte >= THREE_BYTE_MIN && byte < FOUR_BYTE_MIN) {
          needed = 2;
          if (byte === OVERLONG_THREE) lower = THREE_OVERLONG_LOWER;
          if (byte === SURROGATE_THREE) upper = SURROGATE_UPPER;
        } else if (byte >= FOUR_BYTE_MIN && byte <= FOUR_BYTE_MAX) {
          needed = 3;
          if (byte === OVERLONG_FOUR) lower = FOUR_OVERLONG_LOWER;
          if (byte === BEYOND_UNICODE_FOUR) upper = FOUR_BEYOND_UPPER;
        } else throw new Utf8Error(offset);
        continue;
      }
      if (byte < lower || byte > upper) throw new Utf8Error(sequenceStart);
      lower = CONTINUATION_MIN;
      upper = CONTINUATION_MAX;
      needed--;
    }
  }

  return {
    push(bytes) {
      validate(bytes);
      return decoder.decode(bytes, { stream: true });
    },
    end() {
      if (needed > 0) throw new Utf8Error(sequenceStart);
      return decoder.decode();
    },
  };
}

/** Decodes a whole buffer strictly, BOM dropped. */
export function decodeUtf8(bytes: Uint8Array): string {
  const decoder = utf8Decoder();
  return decoder.push(bytes) + decoder.end();
}
