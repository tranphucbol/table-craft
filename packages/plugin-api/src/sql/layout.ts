import type { FormatOptions } from "@table-craft/plugin-api";
import { sqlSplitter } from "./splitter.js";
import { Lexer, type SqlDialectOptions } from "./tokens.js";
import { isLineComment, parseStatement, Unsupported } from "./layoutNodes.js";
import { AlignedPrinter } from "./layoutPrint.js";

export { ALIAS_ALIGN_LIMIT, CASE_INLINE_LIMIT, RIGHT_MARGIN } from "./layoutPrint.js";

const LINE_BREAK = "\n";
const DELIMITER = ";";
const SPACE = " ";

interface Piece {
  /** The statement with the comments that lead it and those before its delimiter. */
  readonly text: string;
  readonly delimited: boolean;
  /** Comments on the delimiter's line, after it. */
  readonly after: readonly string[];
}

interface Formatted {
  readonly text: string;
  readonly endsInLineComment: boolean;
}

/** The statements of `text` with the comments around them, so none is lost between statements. */
function segment(text: string, dialect: SqlDialectOptions): { pieces: Piece[]; tail: string[] } {
  const lexer = new Lexer(text, dialect);
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const span of sqlSplitter(dialect)(text)) {
    lexer.position = cursor;
    let start = span.from;
    for (let token = lexer.next(); token !== null && token.from < span.from; token = lexer.next()) {
      if (token.kind === "comment") {
        start = token.from;
        break;
      }
    }
    lexer.position = span.to;
    let end = span.to;
    let delimited = false;
    for (let token = lexer.next(); token !== null; token = lexer.next()) {
      if (token.kind === "comment") {
        end = token.to;
        continue;
      }
      delimited = token.kind === "delimiter";
      cursor = delimited ? token.to : end;
      break;
    }
    if (!delimited) cursor = end;
    const after: string[] = [];
    if (delimited) {
      lexer.position = cursor;
      for (let token = lexer.next(); token !== null && token.kind === "comment"; token = lexer.next()) {
        if (text.slice(cursor, token.from).includes(LINE_BREAK)) break;
        after.push(text.slice(token.from, token.to));
        cursor = token.to;
      }
    }
    pieces.push({ text: text.slice(start, end), delimited, after });
  }
  const tail: string[] = [];
  lexer.position = cursor;
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    if (token.kind === "comment") tail.push(text.slice(token.from, token.to));
  }
  return { pieces, tail };
}

function tokenStream(text: string, dialect: SqlDialectOptions): string[] {
  const lexer = new Lexer(text, dialect);
  const stream: string[] = [];
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    const content = text.slice(token.from, token.to);
    stream.push(token.kind === "word" ? content.toUpperCase() : content);
  }
  return stream;
}

function sameTokens(before: string, after: string, dialect: SqlDialectOptions): boolean {
  const expected = tokenStream(before, dialect);
  const actual = tokenStream(after, dialect);
  return expected.length === actual.length && expected.every((token, index) => token === actual[index]);
}

function lastIsLineComment(text: string, dialect: SqlDialectOptions): boolean {
  const lexer = new Lexer(text, dialect);
  let last: string | null = null;
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    last = token.kind === "comment" ? text.slice(token.from, token.to) : null;
  }
  return last !== null && isLineComment(last);
}

/**
 * The aligned layout (decision 061), statement by statement. A statement it does not read, or one
 * whose tokens it would change, goes to `standard` as written (decision 062).
 */
export function formatAligned(
  text: string,
  format: FormatOptions,
  dialect: SqlDialectOptions,
  standard: (statement: string) => string,
): string {
  const { pieces, tail } = segment(text, dialect);
  if (pieces.length === 0) return standard(text);
  const printer = new AlignedPrinter(format);
  const statement = (sql: string): Formatted => {
    try {
      const parsed = parseStatement(sql, dialect);
      const printed = printer.print(parsed.nodes, parsed.tail);
      if (!sameTokens(sql, printed.text, dialect)) throw new Unsupported("the layout would change a token");
      return printed;
    } catch (cause) {
      if (!(cause instanceof Unsupported)) throw cause;
      const fallback = standard(sql);
      return { text: fallback, endsInLineComment: lastIsLineComment(fallback, dialect) };
    }
  };
  const blocks = pieces.map((piece) => {
    const formatted = statement(piece.text);
    let block = formatted.text;
    if (piece.delimited) block += formatted.endsInLineComment ? LINE_BREAK + DELIMITER : DELIMITER;
    for (const comment of piece.after) block += SPACE + comment;
    return block;
  });
  const joined = blocks.join(LINE_BREAK.repeat(format.linesBetweenStatements + 1));
  return tail.length === 0 ? joined : [joined, ...tail].join(LINE_BREAK);
}
