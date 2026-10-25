import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeValue,
  detectFormat,
  encodeValue,
  formatPattern,
  hexOf,
  valueBytes,
} from "@table-craft/desktop/renderer/model/valueFormats.js";

const encoder = new TextEncoder();

describe("value formats", () => {
  it("givenGzipJson_whenAuto_thenGzipJson", async () => {
    const bytes = new Uint8Array(gzipSync(encoder.encode('{"theme":"dark"}')));
    expect(detectFormat(bytes)).toBe("gzip");
    const decoded = await decodeValue(bytes, "auto");
    expect(decoded).toMatchObject({ format: "gzip", inner: "json", error: null });
    expect(JSON.parse(decoded.text)).toEqual({ theme: "dark" });
  });

  it("givenInvalidUtf8_whenAuto_thenHex", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    expect(await decodeValue(bytes, "auto")).toEqual({ format: "hex", text: "fffe0001", inner: null, error: null });
  });

  it("givenHexEdit_whenEncoded_thenSameBytes", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    const { text } = await decodeValue(bytes, "hex");
    const encoded = encodeValue(text, "hex");
    expect(encoded.ok && hexOf(encoded.bytes)).toBe("fffe0001");
  });

  it("givenBase64Edit_whenEncoded_thenSameBytes", async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x41]);
    const { text } = await decodeValue(bytes, "base64");
    expect(text).toBe("/wBB");
    const encoded = encodeValue(text, "base64");
    expect(encoded.ok && hexOf(encoded.bytes)).toBe("ff0041");
  });

  it("givenText_whenAuto_thenTextAndPlainScalarsAreNotJson", async () => {
    expect(detectFormat(encoder.encode("hello"))).toBe("text");
    expect(detectFormat(encoder.encode("42"))).toBe("text");
    expect(detectFormat(encoder.encode(" [1, 2] "))).toBe("json");
    expect(await decodeValue(encoder.encode("[1,2]"), "json")).toMatchObject({ text: "[\n  1,\n  2\n]", error: null });
  });

  it("givenMessagePack_whenDecoded_thenJsonText", async () => {
    // {"id": 42, "tags": ["a"]}: fixmap 2, fixstr "id", positive fixint 42, fixstr "tags", fixarray 1, fixstr "a".
    const bytes = new Uint8Array([0x82, 0xa2, 0x69, 0x64, 0x2a, 0xa4, 0x74, 0x61, 0x67, 0x73, 0x91, 0xa1, 0x61]);
    const decoded = await decodeValue(bytes, "msgpack");
    expect(JSON.parse(decoded.text)).toEqual({ id: 42, tags: ["a"] });
  });

  it("givenBadInput_whenEncoded_thenRefusedWithReason", () => {
    expect(encodeValue("abc", "hex")).toEqual({ ok: false, error: "Hex takes pairs of digits 0-9 and a-f." });
    expect(encodeValue("{", "json").ok).toBe(false);
    expect(encodeValue("x", "gzip")).toEqual({ ok: false, error: "gzip values open read-only." });
  });

  it("givenNotGzip_whenDecodedAsGzip_thenHexWithError", async () => {
    expect(await decodeValue(encoder.encode("plain"), "gzip")).toMatchObject({
      format: "gzip",
      text: hexOf(encoder.encode("plain")),
      error: "Not gzip data; shown as hex.",
    });
  });

  it("givenCellValues_whenBytes_thenTextAndFullHexOnly", () => {
    expect(valueBytes("hi")).toEqual(encoder.encode("hi"));
    expect(valueBytes({ kind: "bytes", preview: "fffe", length: 2 })).toEqual(new Uint8Array([0xff, 0xfe]));
    expect(valueBytes({ kind: "bytes", preview: "ff", length: 2 })).toBeNull();
    expect(valueBytes(42)).toBeNull();
  });

  it.each([
    ["user:42:profile", ":", "user:42:*"],
    ["greeting", ":", "*"],
    ["a/b", "", "a/b"],
  ])("givenKey_%s_whenPattern_thenLastSegmentStarred", (key, delimiter, pattern) => {
    expect(formatPattern(key, delimiter)).toBe(pattern);
  });
});
