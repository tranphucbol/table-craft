import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeValue,
  detectFormat,
  encodeValue,
  formatPattern,
  hexOf,
  hexRows,
  isKubernetesEnvelope,
  parseKeyYaml,
  MAX_YAML_BYTES,
  valueBytes,
} from "@table-craft/desktop/renderer/model/valueFormats.js";

const encoder = new TextEncoder();

describe("value formats", () => {
  it("givenYamlWithComments_whenPresentedOrValidated_thenSourceIsPreserved", async () => {
    const source = "# Routing limits\nlimits:\n  daily: 5000 # Keep this note\n  ratio: 1.0\n";
    expect(detectFormat(encoder.encode(source))).toBe("yaml");
    expect(await decodeValue(encoder.encode(source), "yaml")).toEqual({
      format: "yaml",
      text: source,
      inner: null,
      error: null,
    });
    const encoded = encodeValue(source, "yaml");
    expect(encoded.ok && new TextDecoder().decode(encoded.bytes)).toBe(source);
    expect(detectFormat(encoder.encode("just ordinary text"))).toBe("text");
  });

  it("givenLargeYamlIntegers_whenParsed_thenNoPrecisionIsLost", () => {
    expect(parseKeyYaml("revision: 9007199254740993\n")).toEqual({ revision: 9007199254740993n });
  });

  it.each([
    "value: [unterminated",
    "value: 1\nvalue: 2\n",
    "value: &ref [1, 2]\nother: *ref\n",
    "value: !custom something\n",
    "value: !!js/function function(){}\n",
    "value: !!str hello\n",
    "<<: {value: 1}\n",
    "value: .inf\n",
    "? [complex, key]\n: value\n",
    "value: " + "[".repeat(70) + "0" + "]".repeat(70),
    "value: " + "a".repeat(MAX_YAML_BYTES),
  ])("givenUnsupportedYaml_whenValidated_thenRefused_%#", (source) => {
    expect(encodeValue(source, "yaml").ok).toBe(false);
  });

  it("givenBinaryRows_whenViewed_thenOffsetsSixteenBytesAndPrintableAscii", () => {
    const bytes = new Uint8Array([0x00, 0x1f, 0x20, 0x41, 0x7e, 0x7f, 0xff, ...Array<number>(10).fill(0x42)]);
    const rows = hexRows(bytes);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      offset: "00000000",
      hex: "00 1f 20 41 7e 7f ff 42 42 42 42 42 42 42 42 42",
      ascii: ".. A~..BBBBBBBBB",
    });
    expect(rows[1]).toEqual({ offset: "00000010", hex: "42", ascii: "B" });
    expect(hexRows(new Uint8Array())).toEqual([]);
  });

  it("givenKubernetesMagic_whenDetected_thenRawHexNotFabricatedYaml", async () => {
    const bytes = encoder.encode("k8s\u0000protobuf");
    expect(isKubernetesEnvelope(bytes)).toBe(true);
    expect(isKubernetesEnvelope(encoder.encode("k8s"))).toBe(false);
    expect(isKubernetesEnvelope(encoder.encode("k8sx"))).toBe(false);
    expect(detectFormat(bytes)).toBe("hex");
    expect(await decodeValue(bytes, "auto")).toMatchObject({ format: "hex", text: hexOf(bytes) });
  });

  it("givenLargeBinary_whenBase64_thenNoArgumentStackOverflowAndRoundTrips", async () => {
    const bytes = new Uint8Array(1_048_576).fill(0xff);
    const decoded = await decodeValue(bytes, "base64");
    const encoded = encodeValue(decoded.text, "base64");
    expect(encoded.ok && encoded.bytes).toEqual(bytes);
  });
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
