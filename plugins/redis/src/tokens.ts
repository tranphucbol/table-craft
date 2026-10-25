/**
 * The `redis-cli` reading of a line (decision 112): words split on blanks, `"…"` with backslash
 * escapes (`\n`, `\r`, `\t`, `\b`, `\a`, `\xHH`, and any other character as itself), `'…'` where
 * only `\'` escapes. Shared by split, classify, complete and execute, so all four agree.
 */

/** One argument of a command line, in UTF-16 offsets into the text read. */
export interface Token {
  readonly from: number;
  readonly to: number;
  /** The argument as the server receives it. */
  readonly bytes: Buffer;
  /** `bytes` read as UTF-8, for matching names and keywords. */
  readonly text: string;
  readonly quoted: boolean;
  /** False for a quote the line never closes. */
  readonly closed: boolean;
}

const COMMENT = "#";
const HEX_RADIX = 16;
const HEX_ESCAPE_LENGTH = 2;
const ESCAPES: Readonly<Record<string, number>> = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, a: 0x07 };
const BLANK = /\s/;

function isBlank(char: string | undefined): boolean {
  return char !== undefined && BLANK.test(char);
}

function utf8(text: string): number[] {
  return [...Buffer.from(text, "utf8")];
}

/** Reads one quoted argument starting at the quote; returns its bytes and where it ends. */
function readQuoted(text: string, start: number): { bytes: number[]; end: number; closed: boolean } {
  const quote = text[start];
  const bytes: number[] = [];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === quote) return { bytes, end: index + 1, closed: true };
    if (char === "\\" && index + 1 < text.length) {
      const next = text[index + 1] ?? "";
      if (quote === "'") {
        if (next === "'") {
          bytes.push(...utf8("'"));
          index += 2;
          continue;
        }
      } else {
        const hex = text.slice(index + 2, index + 2 + HEX_ESCAPE_LENGTH);
        if (next === "x" && /^[0-9a-fA-F]{2}$/.test(hex)) {
          bytes.push(Number.parseInt(hex, HEX_RADIX));
          index += 2 + HEX_ESCAPE_LENGTH;
          continue;
        }
        const escaped = ESCAPES[next];
        bytes.push(...(escaped === undefined ? utf8(next) : [escaped]));
        index += 2;
        continue;
      }
    }
    const codePoint = text.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    bytes.push(...utf8(text.slice(index, index + width)));
    index += width;
  }
  return { bytes, end: text.length, closed: false };
}

/** Every argument of `line`; a word that runs into a quote, `ab"c d"`, is one argument as redis-cli reads it. */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    while (isBlank(line[index])) index += 1;
    if (index >= line.length) break;
    const from = index;
    const bytes: number[] = [];
    let quoted = false;
    let closed = true;
    while (index < line.length && !isBlank(line[index])) {
      const char = line[index];
      if (char === '"' || char === "'") {
        const read = readQuoted(line, index);
        bytes.push(...read.bytes);
        quoted = true;
        closed = read.closed;
        index = read.end;
        if (!read.closed) break;
      } else {
        const codePoint = line.codePointAt(index) ?? 0;
        const width = codePoint > 0xffff ? 2 : 1;
        bytes.push(...utf8(line.slice(index, index + width)));
        index += width;
      }
    }
    const buffer = Buffer.from(bytes);
    tokens.push({ from, to: index, bytes: buffer, text: buffer.toString("utf8"), quoted, closed });
  }
  return tokens;
}

/** Whether the line is blank or a `#` comment, so it holds no command. */
export function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed === "" || trimmed.startsWith(COMMENT);
}

/** An argument as `redis-cli` would print it to be read back: bare when it can be, else quoted. */
export function quoteArgument(value: string): string {
  if (value !== "" && !/[\s"'\\]/.test(value)) return value;
  return `"${value
    .replace(/[\\"]/g, (char) => `\\${char}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}
