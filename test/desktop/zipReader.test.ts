import { describe, expect, it } from "vitest";
import { ZipReadError, readZipEntry } from "@table-craft/desktop/main/import/zipReader.js";
import { zip } from "@table-craft/desktop/main/log/zip.js";

const DATE = new Date(2026, 10, 2);
const LIMIT = 1024 * 1024;
const REPEATED = '<value key="hostName">db.test</value>\n'.repeat(200);
/** Byte 6 of a local header and byte 8 of a central one hold the general purpose flags. */
const LOCAL_FLAGS = 6;
const CENTRAL_FLAGS = 8;
const ENCRYPTED = 0x1;

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

function archive(): Uint8Array {
  return zip(
    [
      { name: "tiny.txt", data: encode("ab") },
      { name: "connections.xml", data: encode(REPEATED) },
    ],
    DATE,
  );
}

describe("readZipEntry", () => {
  it("givenStoredAndDeflatedEntries_whenRead_thenBothDecode", () => {
    const bytes = archive();

    expect(decode(readZipEntry(bytes, "tiny.txt", LIMIT))).toBe("ab");
    expect(decode(readZipEntry(bytes, "connections.xml", LIMIT))).toBe(REPEATED);
  });

  it("givenMissingEntry_whenRead_thenNull", () => {
    expect(readZipEntry(archive(), "server_instances.xml", LIMIT)).toBeNull();
  });

  it("givenEntryOverTheLimit_whenRead_thenRefused", () => {
    expect(() => readZipEntry(archive(), "connections.xml", 100)).toThrow(ZipReadError);
  });

  it("givenTruncatedArchive_whenRead_thenRefused", () => {
    const bytes = archive();

    expect(() => readZipEntry(bytes.subarray(0, bytes.length - 30), "connections.xml", LIMIT)).toThrow(ZipReadError);
    expect(() => readZipEntry(encode("plain text"), "connections.xml", LIMIT)).toThrow("not a ZIP archive");
  });

  it("givenEncryptedEntry_whenRead_thenRefused", () => {
    const bytes = zip([{ name: "connections.xml", data: encode("secret") }], DATE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const central = bytes.findIndex(
      (_byte, index) => index + 4 <= bytes.length && view.getUint32(index, true) === 0x02014b50,
    );
    view.setUint16(LOCAL_FLAGS, view.getUint16(LOCAL_FLAGS, true) | ENCRYPTED, true);
    view.setUint16(central + CENTRAL_FLAGS, view.getUint16(central + CENTRAL_FLAGS, true) | ENCRYPTED, true);

    expect(() => readZipEntry(bytes, "connections.xml", LIMIT)).toThrow("encrypted");
  });
});
