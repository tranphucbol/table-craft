/**
 * The public surface of one plugin-api entry as the committed `.api.md` report records it, and the
 * reader that turns a report back into that model (decision 107).
 */

export interface SurfaceMember {
  /** The member's name, `()` for a call signature, `new` for a construct signature, `[]` for an index. */
  key: string;
  /** Every declaration under the key, sorted: overloads share a key. */
  texts: string[];
  optional: boolean;
  deprecated: boolean;
}

export interface SurfaceSymbol {
  name: string;
  /** False for a type no entry exports that an exported declaration reaches (`~Name` in the report). */
  exported: boolean;
  deprecated: boolean;
  /** The whole declaration for a symbol without members, else the line that opens its block. */
  header: string;
  members: Map<string, SurfaceMember> | null;
}

export interface SurfaceModel {
  entry: string;
  apiVersion: string;
  symbols: Map<string, SurfaceSymbol>;
}

export class ReportFormatError extends Error {
  override name = "ReportFormatError";
}

export const DEPRECATED_MARK = "/** @deprecated */ ";
export const UNEXPORTED_MARK = "~";
export const MEMBER_INDENT = "  ";
export const BLOCK_OPEN = " {";
export const BLOCK_CLOSE = "}";
export const FENCE_OPEN = "```ts";
export const FENCE_CLOSE = "```";
export const ENTRY_PREFIX = "# Public surface of `";
export const VERSION_PREFIX = "API_VERSION: ";

const SYMBOL_NAME =
  /^(?:abstract class|class|const enum|enum|interface|type|function|const|let|var|namespace) ([A-Za-z_$][\w$]*)|^export \{ ([A-Za-z_$][\w$]*) \} from /;
const MEMBER_MODIFIERS = /^(?:(?:readonly|static|private|protected|public|abstract|accessor|get|set|async) )+/;
const MEMBER_NAME = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$#][\w$]*)/;

export function symbolName(header: string): string {
  const match = SYMBOL_NAME.exec(header);
  const name = match?.[1] ?? match?.[2];
  if (name === undefined) throw new ReportFormatError(`Cannot name the declaration "${header}".`);
  return name;
}

export function memberKey(text: string): { key: string; optional: boolean } {
  const bare = text.replace(MEMBER_MODIFIERS, "");
  if (bare.startsWith("[")) return { key: "[]", optional: false };
  if (bare.startsWith("(") || bare.startsWith("<")) return { key: "()", optional: false };
  if (bare.startsWith("new ") || bare.startsWith("new(")) return { key: "new", optional: false };
  const match = MEMBER_NAME.exec(bare);
  if (match?.[1] === undefined) throw new ReportFormatError(`Cannot name the member "${text}".`);
  const key = match[1];
  return { key, optional: bare.charAt(key.length) === "?" };
}

export function addMember(members: Map<string, SurfaceMember>, text: string, deprecated: boolean): void {
  const { key, optional } = memberKey(text);
  const existing = members.get(key);
  if (existing === undefined) {
    members.set(key, { key, texts: [text], optional, deprecated });
    return;
  }
  existing.texts = [...existing.texts, text].sort();
  existing.optional &&= optional;
  existing.deprecated &&= deprecated;
}

function withoutMark(line: string, mark: string): { text: string; marked: boolean } {
  return line.startsWith(mark) ? { text: line.slice(mark.length), marked: true } : { text: line, marked: false };
}

/** Reads a report written by `renderReport`; anything else is a `ReportFormatError`. */
export function parseReport(text: string): SurfaceModel {
  const lines = text.split("\n");
  const entryLine = lines.find((line) => line.startsWith(ENTRY_PREFIX));
  const versionLine = lines.find((line) => line.startsWith(VERSION_PREFIX));
  if (entryLine === undefined || versionLine === undefined) {
    throw new ReportFormatError("Not an API report: the entry or API_VERSION line is missing.");
  }
  const entry = entryLine.slice(ENTRY_PREFIX.length).replace(/`.*$/, "");
  const apiVersion = versionLine.slice(VERSION_PREFIX.length).trim();
  const start = lines.indexOf(FENCE_OPEN);
  const end = lines.lastIndexOf(FENCE_CLOSE);
  if (start < 0 || end <= start) throw new ReportFormatError("Not an API report: the ts block is missing.");

  const symbols = new Map<string, SurfaceSymbol>();
  let open: SurfaceSymbol | null = null;
  for (const line of lines.slice(start + 1, end)) {
    if (line === "") continue;
    if (open !== null) {
      if (line === BLOCK_CLOSE) {
        open = null;
        continue;
      }
      if (!line.startsWith(MEMBER_INDENT)) throw new ReportFormatError(`Unclosed block before "${line}".`);
      const member = withoutMark(line.slice(MEMBER_INDENT.length), DEPRECATED_MARK);
      if (open.members === null) throw new ReportFormatError(`"${open.name}" has no member block.`);
      addMember(open.members, member.text, member.marked);
      continue;
    }
    const deprecated = withoutMark(line, DEPRECATED_MARK);
    const unexported = withoutMark(deprecated.text, UNEXPORTED_MARK);
    const isBlock = unexported.text.endsWith(BLOCK_OPEN);
    const header = isBlock ? unexported.text.slice(0, -BLOCK_OPEN.length) : unexported.text;
    const symbol: SurfaceSymbol = {
      name: symbolName(header),
      exported: !unexported.marked,
      deprecated: deprecated.marked,
      header,
      members: isBlock ? new Map() : null,
    };
    if (symbols.has(symbol.name)) throw new ReportFormatError(`"${symbol.name}" appears twice.`);
    symbols.set(symbol.name, symbol);
    if (isBlock) open = symbol;
  }
  if (open !== null) throw new ReportFormatError(`The block of "${open.name}" is not closed.`);
  return { entry, apiVersion, symbols };
}
