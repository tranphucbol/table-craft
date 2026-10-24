import { describe, expect, it } from "vitest";
import { Utf8Error, decodeUtf8, utf8Decoder } from "@table-craft/core";

const BOM = [0xef, 0xbb, 0xbf];
const encode = (text: string) => new TextEncoder().encode(text);

function offsetOf(run: () => unknown): number | null {
  try {
    run();
    return null;
  } catch (cause) {
    if (cause instanceof Utf8Error) return cause.offset;
    throw cause;
  }
}

describe("utf-8 decoding", () => {
  it("givenBomFile_whenDecoding_thenBomStripped", () => {
    expect(decodeUtf8(Uint8Array.from([...BOM, ...encode("SELECT 1;")]))).toBe("SELECT 1;");
  });

  it("givenBomOnlyAtStart_whenStreamed_thenLaterBomKept", () => {
    const decoder = utf8Decoder();
    const text =
      decoder.push(Uint8Array.from(BOM.slice(0, 1))) + decoder.push(Uint8Array.from([...BOM.slice(1), 0x61]));
    expect(text + decoder.push(Uint8Array.from(BOM)) + decoder.end()).toBe("a\uFEFF");
  });

  it("givenInvalidUtf8_whenDecoding_thenErrorNamesByteOffset", () => {
    const bytes = Uint8Array.from([...encode("SELECT 'é'"), 0xe9, ...encode("';")]);
    expect(offsetOf(() => decodeUtf8(bytes))).toBe(encode("SELECT 'é'").length);
    expect(offsetOf(() => decodeUtf8(Uint8Array.from([0x61, 0xc3])))).toBe(1);
    expect(offsetOf(() => decodeUtf8(Uint8Array.from([0xed, 0xa0, 0x80])))).toBe(0);
    expect(offsetOf(() => decodeUtf8(Uint8Array.from([0xc0, 0x80])))).toBe(0);
  });

  it("givenCharacterSplitAcrossChunks_whenStreamed_thenDecodedWhole", () => {
    const bytes = encode("a😀é€b");
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const decoder = utf8Decoder();
      expect(decoder.push(bytes.slice(0, cut)) + decoder.push(bytes.slice(cut)) + decoder.end()).toBe("a😀é€b");
    }
  });

  it("givenBadByteInLaterChunk_whenStreamed_thenOffsetCountsEarlierChunks", () => {
    const decoder = utf8Decoder();
    decoder.push(encode("12345"));
    expect(offsetOf(() => decoder.push(Uint8Array.from([0x61, 0xff])))).toBe(6);
  });
});
