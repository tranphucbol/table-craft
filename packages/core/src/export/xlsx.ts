import type { Column, WireValue } from "@table-craft/plugin-api";
import type { ExportEncoder } from "@table-craft/core/export/runner.js";
import { zipWriter, type ZipOptions } from "@table-craft/core/export/zip.js";
import { columnTypeClass, type TypeClass } from "@table-craft/core/results/compare.js";
import { bytesText } from "@table-craft/core/results/extract/text.js";

/** Rows in one Excel sheet, the header included (Excel's limit). */
export const XLSX_SHEET_ROWS = 1_048_576;
/** Characters one Excel cell holds. */
export const XLSX_CELL_CHARS = 32_767;
/** XML gathered before it is deflated: large enough to compress well, small enough to be nothing. */
const XML_BATCH_CHARS = 1 << 18;
/** Excel keeps 15 significant digits; a longer number is written as text so no digit is lost. */
const EXCEL_DIGITS = 15;
const HEADER_STYLE = 1;
const LETTERS = 26;
const LETTER_A = 65;

const NUMERIC_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/u;
const NUMERIC_CLASSES: ReadonlySet<TypeClass> = new Set(["integer", "float", "decimal"]);
/** Characters XML 1.0 forbids, and lone surrogates. */
const INVALID_XML =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;
/** A literal `_xHHHH_` would be read back as an escape; its underscore is escaped instead. */
const ESCAPE_LOOKALIKE = /_(?=x[0-9A-Fa-f]{4}_)/gu;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NEEDS_ESCAPE = /[&<>_\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;
const HEX_RADIX = 16;
const ESCAPE_DIGITS = 4;

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

const CONTENT_TYPE = {
  rels: "application/vnd.openxmlformats-package.relationships+xml",
  xml: "application/xml",
  workbook: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  worksheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
  styles: "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
} as const;

/**
 * Written last, when the sheet count is known: Excel refuses a package whose `.xml` default is the
 * worksheet type, and ZIP entry order does not matter to Open Packaging Conventions.
 */
function contentTypes(sheets: number): string {
  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`;
  const worksheets = Array.from({ length: sheets }, (_, index) =>
    override(`/xl/worksheets/sheet${String(index + 1)}.xml`, CONTENT_TYPE.worksheet),
  );
  return (
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="${CONTENT_TYPE.rels}"/>` +
    `<Default Extension="xml" ContentType="${CONTENT_TYPE.xml}"/>` +
    override("/xl/workbook.xml", CONTENT_TYPE.workbook) +
    override("/xl/styles.xml", CONTENT_TYPE.styles) +
    worksheets.join("") +
    "</Types>"
  );
}

const ROOT_RELS =
  `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
  `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
  "</Relationships>";

const STYLES =
  `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

const SHEET_END = "</sheetData></worksheet>";

export interface XlsxOptions extends ZipOptions {
  /** Rows per sheet, the header included. Lowered only by tests. */
  readonly sheetRows?: number;
}

/** `A`, `Z`, `AA`, … for a 0-based column. */
export function columnLetters(index: number): string {
  let letters = "";
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % LETTERS;
    letters = String.fromCharCode(LETTER_A + digit) + letters;
    rest = Math.floor((rest - 1) / LETTERS);
  }
  return letters;
}

function hexEscape(character: string): string {
  return `_x${(character.codePointAt(0) ?? 0).toString(HEX_RADIX).toUpperCase().padStart(ESCAPE_DIGITS, "0")}_`;
}

/** `text` safe inside an XML element, with what XML cannot hold written as OOXML `_xHHHH_`. */
export function xmlText(text: string): string {
  if (!NEEDS_ESCAPE.test(text)) return text;
  return text
    .replace(ESCAPE_LOOKALIKE, "_x005F_")
    .replace(INVALID_XML, hexEscape)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function significantDigits(text: string): number {
  const mantissa = text.replace(/^-/u, "").split(/[eE]/u)[0] ?? "";
  return mantissa.replace(".", "").replace(/^0+/u, "").length;
}

/** Trailing zeros of an integer are exact in a double, so `1e18` keeps its one digit. */
function integerDigits(text: string): number {
  return significantDigits(text.replace(/0+$/u, ""));
}

function sheetStart(selected: boolean): string {
  return (
    `${XML_DECLARATION}<worksheet xmlns="${MAIN_NS}"><sheetViews><sheetView ${selected ? 'tabSelected="1" ' : ""}workbookViewId="0">` +
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>'
  );
}

/**
 * An `.xlsx` written as rows arrive (decision 041): inline strings, so no shared-strings table has
 * to be held, and a new sheet with the header repeated every `sheetRows` rows.
 */
export function xlsxEncoder(columns: readonly Column[], options: XlsxOptions = {}): ExportEncoder {
  const sheetRows = options.sheetRows ?? XLSX_SHEET_ROWS;
  const zip = zipWriter(options);
  const encoder = new TextEncoder();
  const letters = columns.map((_, index) => columnLetters(index));
  const numeric = columns.map((column) => NUMERIC_CLASSES.has(columnTypeClass(column)));
  let sheets = 0;
  let sheetRow = 0;
  let truncatedCells = 0;
  let xml = "";
  const out: Uint8Array[] = [];

  function flushXml(): void {
    if (xml === "") return;
    out.push(zip.data(encoder.encode(xml)));
    xml = "";
  }

  function drain(): Uint8Array {
    if (out.length === 1) return out.pop() ?? new Uint8Array(0);
    const total = out.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of out.splice(0)) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }

  function entry(name: string, text: string): void {
    out.push(zip.begin(name), zip.data(encoder.encode(text)), zip.finish());
  }

  function inline(ref: string, text: string, style: string): string {
    let value = text;
    if (value.length > XLSX_CELL_CHARS) {
      value = value.slice(0, XLSX_CELL_CHARS);
      truncatedCells += 1;
    }
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
  }

  function cell(value: WireValue, column: number, rowNumber: number): string {
    if (value === null) return "";
    const ref = `${letters[column] ?? columnLetters(column)}${String(rowNumber)}`;
    if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? "1" : "0"}</v></c>`;
    if (typeof value === "number") {
      const text = String(value);
      // A double is already approximate, so only an exact integer is worth keeping as text.
      const loses = !Number.isFinite(value) || (Number.isSafeInteger(value) && integerDigits(text) > EXCEL_DIGITS);
      return loses ? inline(ref, text, "") : `<c r="${ref}"><v>${text}</v></c>`;
    }
    if (typeof value === "string") {
      const asNumber = numeric[column] === true && NUMERIC_TEXT.test(value) && significantDigits(value) <= EXCEL_DIGITS;
      return asNumber ? `<c r="${ref}"><v>${value}</v></c>` : inline(ref, value, "");
    }
    switch (value.kind) {
      case "bigint":
        return value.value.replace("-", "").length <= EXCEL_DIGITS
          ? `<c r="${ref}"><v>${value.value}</v></c>`
          : inline(ref, value.value, "");
      case "json":
        return inline(ref, value.text, "");
      case "date":
        return inline(ref, value.iso, "");
      case "bytes":
        return inline(ref, bytesText(value.preview, value.length), "");
    }
  }

  function openSheet(): void {
    sheets += 1;
    sheetRow = 1;
    out.push(zip.begin(`xl/worksheets/sheet${String(sheets)}.xml`));
    const header = columns
      .map((column, index) => inline(`${letters[index] ?? ""}1`, column.name, ` s="${String(HEADER_STYLE)}"`))
      .join("");
    xml += `${sheetStart(sheets === 1)}<row r="1">${header}</row>`;
  }

  function closeSheet(): void {
    xml += SHEET_END;
    flushXml();
    out.push(zip.finish());
  }

  function workbook(): string {
    const names = Array.from({ length: sheets }, (_, index) => index + 1);
    return (
      `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
      names.map((n) => `<sheet name="Sheet${String(n)}" sheetId="${String(n)}" r:id="rId${String(n)}"/>`).join("") +
      "</sheets></workbook>"
    );
  }

  function workbookRels(): string {
    const names = Array.from({ length: sheets }, (_, index) => index + 1);
    return (
      `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">` +
      names
        .map(
          (n) =>
            `<Relationship Id="rId${String(n)}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${String(n)}.xml"/>`,
        )
        .join("") +
      `<Relationship Id="rId${String(sheets + 1)}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
      "</Relationships>"
    );
  }

  return {
    get sheets() {
      return sheets;
    },
    get truncatedCells() {
      return truncatedCells;
    },
    start() {
      entry("_rels/.rels", ROOT_RELS);
      entry("xl/styles.xml", STYLES);
      openSheet();
      return drain();
    },
    row(row) {
      if (sheetRow >= sheetRows) {
        closeSheet();
        openSheet();
      }
      sheetRow += 1;
      xml += `<row r="${String(sheetRow)}">${row.map((value, column) => cell(value, column, sheetRow)).join("")}</row>`;
      if (xml.length >= XML_BATCH_CHARS) flushXml();
      return drain();
    },
    end() {
      closeSheet();
      entry("xl/workbook.xml", workbook());
      entry("xl/_rels/workbook.xml.rels", workbookRels());
      entry("[Content_Types].xml", contentTypes(sheets));
      out.push(zip.close());
      return drain();
    },
  };
}
