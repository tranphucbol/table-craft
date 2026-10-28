import { columnLetters, exportEncoder, xmlText, ZIP32_MAX, zipWriter } from "@table-craft/core";
import type { Column, Row } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";
import { readZip } from "../support/zipReader.js";

function bytesOf(parts: readonly (string | Uint8Array)[]): Uint8Array {
  const encoded = parts.map((part) => (typeof part === "string" ? new TextEncoder().encode(part) : part));
  const out = new Uint8Array(encoded.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function workbook(columns: readonly Column[], rows: readonly Row[], sheetRows?: number) {
  const encoder = exportEncoder("xlsx", columns, sheetRows === undefined ? {} : { sheetRows });
  const parts = [encoder.start(), ...rows.map((row, index) => encoder.row(row, index)), encoder.end(rows.length)];
  const archive = readZip(bytesOf(parts));
  const text = (name: string) => archive.entries.find((entry) => entry.name === name)?.text() ?? "";
  return { encoder, archive, text };
}

const LOCAL_VERSION_OFFSET = 4;

describe("zip writer", () => {
  it("givenEntries_whenZipped_thenCentralDirectoryAndCrcsMatch", () => {
    const zip = zipWriter();
    const big = "row,".repeat(100_000);
    const parts = [
      zip.begin("a.txt"),
      zip.data(new TextEncoder().encode("hello ")),
      zip.data(new TextEncoder().encode("world")),
      zip.finish(),
      zip.begin("dir/b.txt"),
      zip.data(new TextEncoder().encode(big)),
      zip.finish(),
      zip.close(),
    ];

    const bytes = bytesOf(parts);
    const archive = readZip(bytes);

    expect(archive.entries.map((entry) => entry.name)).toEqual(["a.txt", "dir/b.txt"]);
    // Version needed 2.0 in the local header: Excel refuses 4.5 beside a 32-bit data descriptor.
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(LOCAL_VERSION_OFFSET, true)).toBe(20);
    expect(archive.entries[0]?.text()).toBe("hello world");
    expect(archive.entries[1]?.text()).toBe(big);
    expect(archive.entries[1]?.compressed).toBeLessThan(big.length / 10);
    expect(archive.zip64End).toBe(false);
  });

  it("givenZip64Forced_whenZipped_thenZip64RecordsWritten", () => {
    const zip = zipWriter({ zip64Limit: 10 });
    const parts = [
      zip.begin("first.xml"),
      zip.data(new TextEncoder().encode("<a>first entry, long enough</a>")),
      zip.finish(),
      zip.begin("second.xml"),
      zip.data(new TextEncoder().encode("<b/>")),
      zip.finish(),
      zip.close(),
    ];

    const archive = readZip(bytesOf(parts));

    expect(archive.zip64End).toBe(true);
    expect(archive.entries.every((entry) => entry.zip64)).toBe(true);
    expect(archive.entries[0]?.text()).toBe("<a>first entry, long enough</a>");
    expect(archive.entries[1]?.text()).toBe("<b/>");
    expect(ZIP32_MAX).toBe(4_294_967_295);
  });
});

describe("xlsx writer", () => {
  const COLUMNS: readonly Column[] = [
    { name: "id", type: "int4" },
    { name: "name", type: "text" },
  ];

  it("givenRows_whenWritten_thenWorkbookPartsPresentAndHeaderBoldAndFrozen", () => {
    const { archive, text } = workbook(COLUMNS, [[1, "a"]]);

    expect(archive.entries.map((entry) => entry.name)).toEqual([
      "_rels/.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "[Content_Types].xml",
    ]);
    expect(text("[Content_Types].xml")).toContain('<Default Extension="xml" ContentType="application/xml"/>');
    const sheet = text("xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">id</t></is></c>');
    expect(sheet).toContain('<row r="2"><c r="A2"><v>1</v></c>');
    expect(text("xl/workbook.xml")).toContain('<sheet name="Sheet1" sheetId="1" r:id="rId1"/>');
  });

  it("givenRowsPastSheetLimit_whenWritten_thenRollsOverWithHeaderRepeated", () => {
    const rows: Row[] = Array.from({ length: 7 }, (_, index) => [index + 1, `r${String(index + 1)}`]);

    const { encoder, text } = workbook(COLUMNS, rows, 4);

    expect(encoder.sheets).toBe(3);
    const second = text("xl/worksheets/sheet2.xml");
    expect(second).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">id</t></is></c>');
    expect(second).toContain('<row r="2"><c r="A2"><v>4</v></c>');
    expect(second).toContain('<row r="4"><c r="A4"><v>6</v></c>');
    expect(text("xl/worksheets/sheet3.xml")).toContain('<row r="2"><c r="A2"><v>7</v></c>');
    expect(text("xl/workbook.xml")).toContain('<sheet name="Sheet3" sheetId="3" r:id="rId3"/>');
    expect(text("xl/_rels/workbook.xml.rels")).toContain('Id="rId4"');
    expect(text("[Content_Types].xml").match(/PartName="\/xl\/worksheets\/sheet\d\.xml"/g)).toHaveLength(3);
  });

  it("givenControlCharactersAndEntities_whenWritten_thenEscaped", () => {
    expect(xmlText("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
    expect(xmlText("bell\u0007tab\tok")).toBe("bell_x0007_tab\tok");
    expect(xmlText("_x0041_ stays")).toBe("_x005F_x0041_ stays");
    expect(xmlText("lone \uD800 surrogate")).toBe("lone _xD800_ surrogate");
    expect(xmlText("😀 pair")).toBe("😀 pair");
  });

  it("givenLongCell_whenWritten_thenTruncatedAndCounted", () => {
    const { encoder, text } = workbook(COLUMNS, [[1, "x".repeat(40_000)]]);

    expect(encoder.truncatedCells).toBe(1);
    expect(text("xl/worksheets/sheet1.xml")).toContain(`>${"x".repeat(32_767)}</t>`);
  });

  it("givenValueKinds_whenWritten_thenNumbersBooleansAndTextTyped", () => {
    const columns: readonly Column[] = [
      { name: "price", type: "numeric" },
      { name: "flag", type: "bool" },
      { name: "big", type: "int8" },
      { name: "precise", type: "numeric" },
      { name: "at", type: "timestamptz" },
      { name: "code", type: "text" },
      { name: "blob", type: "bytea" },
      { name: "missing", type: "text" },
    ];
    const row: Row = [
      "12.50",
      true,
      { kind: "bigint", value: "9223372036854775807" },
      "1234567890.1234567",
      { kind: "date", iso: "2026-10-23T10:00:00.000Z" },
      "00123",
      { kind: "bytes", preview: "deadbeef", length: 4 },
      null,
    ];

    const sheet = workbook(columns, [row]).text("xl/worksheets/sheet1.xml");

    expect(sheet).toContain('<c r="A2"><v>12.50</v></c>');
    expect(sheet).toContain('<c r="B2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">9223372036854775807</t></is></c>');
    expect(sheet).toContain('<c r="D2" t="inlineStr"><is><t xml:space="preserve">1234567890.1234567</t></is></c>');
    expect(sheet).toContain('<t xml:space="preserve">2026-10-23T10:00:00.000Z</t>');
    expect(sheet).toContain('<c r="F2" t="inlineStr"><is><t xml:space="preserve">00123</t></is></c>');
    expect(sheet).toContain('<t xml:space="preserve">0xdeadbeef</t>');
    expect(sheet).not.toContain('r="H2"');
  });

  it("givenIntegerPastExcelDigits_whenWritten_thenTextKeepsEveryDigit", () => {
    const columns: readonly Column[] = [
      { name: "sixteen", type: "int8" },
      { name: "negative", type: "int8" },
      { name: "fifteen", type: "int8" },
      { name: "round", type: "int8" },
      { name: "double", type: "float8" },
    ];
    const row: Row = [1_234_567_890_123_456, -9_007_199_254_740_991, 123_456_789_012_345, 1e18, 0.1 + 0.2];

    const sheet = workbook(columns, [row]).text("xl/worksheets/sheet1.xml");

    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">1234567890123456</t></is></c>');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">-9007199254740991</t></is></c>');
    expect(sheet).toContain('<c r="C2"><v>123456789012345</v></c>');
    expect(sheet).toContain('<c r="D2"><v>1000000000000000000</v></c>');
    expect(sheet).toContain('<c r="E2"><v>0.30000000000000004</v></c>');
  });

  it("givenColumnIndex_whenLettered_thenExcelStyle", () => {
    expect([0, 25, 26, 51, 701, 702].map(columnLetters)).toEqual(["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
  });
});
