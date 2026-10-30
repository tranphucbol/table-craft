/**
 * The shell reading of a console line, as `etcdctl` receives its arguments (decision 8 of plan
 * 110): words split on blanks, `"…"` with backslash escapes (`\n`, `\r`, `\t`, `\xHH`, and any
 * other character as itself), `'…'` taken literally, and a bare backslash escaping the next
 * character. Shared by split, classify, complete and execute, so all four agree.
 */

/** One argument of a command line, in UTF-16 offsets into the text read. */
export interface Token {
  readonly from: number;
  readonly to: number;
  /** The argument as the server receives it. */
  readonly bytes: Buffer;
  /** `bytes` read as UTF-8, for matching names and flags. */
  readonly text: string;
  readonly quoted: boolean;
  /** False for a quote the line never closes. */
  readonly closed: boolean;
}

const COMMENT = "#";
const HEX_RADIX = 16;
const HEX_ESCAPE_LENGTH = 2;
const ESCAPES: Readonly<Record<string, number>> = { n: 0x0a, r: 0x0d, t: 0x09 };
const BLANK = /\s/;
const PRINTABLE_ASCII_FIRST = 0x20;
const PRINTABLE_ASCII_LAST = 0x7e;
const HEX_WIDTH = 2;
const QUOTED_ESCAPES: Readonly<Record<number, string>> = {
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x22: '\\"',
  0x5c: "\\\\",
};

function isBlank(char: string | undefined): boolean {
  return char !== undefined && BLANK.test(char);
}

function utf8(text: string): number[] {
  return [...Buffer.from(text, "utf8")];
}

function charAt(text: string, index: number): string {
  const codePoint = text.codePointAt(index) ?? 0;
  return text.slice(index, index + (codePoint > 0xffff ? 2 : 1));
}

/** Reads one quoted argument starting at the quote; returns its bytes and where it ends. */
export function readQuoted(text: string, start: number): { bytes: number[]; end: number; closed: boolean } {
  const quote = text[start];
  const bytes: number[] = [];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === quote) return { bytes, end: index + 1, closed: true };
    if (quote === '"' && char === "\\" && index + 1 < text.length) {
      const next = text[index + 1] ?? "";
      const hex = text.slice(index + 2, index + 2 + HEX_ESCAPE_LENGTH);
      if (next === "x" && /^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, HEX_RADIX));
        index += 2 + HEX_ESCAPE_LENGTH;
        continue;
      }
      const escaped = ESCAPES[next];
      const nextChar = charAt(text, index + 1);
      bytes.push(...(escaped === undefined ? utf8(nextChar) : [escaped]));
      index += 1 + nextChar.length;
      continue;
    }
    const whole = charAt(text, index);
    bytes.push(...utf8(whole));
    index += whole.length;
  }
  return { bytes, end: text.length, closed: false };
}

/** Every argument of `line`; a word that runs into a quote, `ab"c d"`, is one argument as a shell reads it. */
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
      } else if (char === "\\" && index + 1 < line.length) {
        const next = charAt(line, index + 1);
        bytes.push(...utf8(next));
        index += 1 + next.length;
      } else {
        const whole = charAt(line, index);
        bytes.push(...utf8(whole));
        index += whole.length;
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

function printableText(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) return null;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < PRINTABLE_ASCII_FIRST || code === PRINTABLE_ASCII_LAST + 1) return null;
  }
  return text;
}

/** Bytes as an argument the console reads back to the same bytes: bare when it can be, else double-quoted. */
export function quoteBytes(bytes: Uint8Array): string {
  const text = printableText(bytes);
  // A bare leading dash would read back as a flag.
  if (text !== null && text !== "" && !/[\s"'\\#]/.test(text) && !text.startsWith("-")) return text;
  if (text !== null) return `"${text.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
  let quoted = "";
  for (const byte of bytes) {
    const escaped = QUOTED_ESCAPES[byte];
    if (escaped !== undefined) quoted += escaped;
    else if (byte >= PRINTABLE_ASCII_FIRST && byte <= PRINTABLE_ASCII_LAST) quoted += String.fromCharCode(byte);
    else quoted += `\\x${byte.toString(HEX_RADIX).padStart(HEX_WIDTH, "0")}`;
  }
  return `"${quoted}"`;
}

/** Text as an argument the console reads back to the same text. */
export function quoteArgument(value: string): string {
  return quoteBytes(Buffer.from(value, "utf8"));
}
