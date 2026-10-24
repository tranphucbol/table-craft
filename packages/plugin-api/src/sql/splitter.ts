import type { StatementSpan, StatementStream, StreamedStatement } from "@table-craft/plugin-api";
import { DEFAULT_DELIMITER, Lexer, wordOf, type SqlDialectOptions, type Token } from "./tokens.js";

const DELIMITER_COMMAND = "DELIMITER";
/** A body only opens inside a statement that defines a routine, so a column called `begin` stays a column. */
const BODY_OWNERS = new Set(["TRIGGER", "FUNCTION", "PROCEDURE", "EVENT"]);
const CREATE = "CREATE";
const CASE = "CASE";
const END = "END";
/** `END IF`, `END LOOP` and the like close a construct the splitter never counted as opened. */
const UNCOUNTED_END_TARGETS = new Set(["IF", "LOOP", "WHILE", "REPEAT"]);
const LINE_BREAK = /\r?\n/;
const NEWLINE = "\n";
/**
 * A stream rescans its unfinished text only once it has doubled, so one statement spanning a
 * thousand pushes is read a logarithmic number of times rather than once per push.
 */
const RESCAN_GROWTH = 2;

interface Statement {
  from: number;
  to: number;
  words: number;
  /** The statement is a `CREATE` that has named a routine, so a block keyword opens its body. */
  definesRoutine: boolean;
  isCreate: boolean;
  depth: number;
  /** An `END` was seen inside a body; the next token decides whether it closes one. */
  pendingEnd: boolean;
}

function freshStatement(from: number): Statement {
  return { from, to: from, words: 0, isCreate: false, definesRoutine: false, depth: 0, pendingEnd: false };
}

/** Where a later scan may start: between statements, under the delimiter then in force. */
interface Checkpoint {
  readonly offset: number;
  readonly delimiter: string;
}

interface Scan {
  readonly spans: StatementSpan[];
  readonly checkpoint: Checkpoint;
}

type Scanner = (text: string, delimiter: string, final: boolean) => Scan;

function scanner(options: SqlDialectOptions): Scanner {
  const blockKeywords = new Set((options.blockKeywords ?? []).map((keyword) => keyword.toUpperCase()));

  return (text, startDelimiter, final) => {
    const spans: StatementSpan[] = [];
    const lexer = new Lexer(text, options);
    let delimiter = startDelimiter;
    let statement: Statement | null = null;
    let checkpoint: Checkpoint = { offset: 0, delimiter };

    const flush = (end: number): void => {
      if (statement !== null)
        spans.push({ from: statement.from, to: statement.to, sql: text.slice(statement.from, statement.to) });
      statement = null;
      checkpoint = { offset: end, delimiter };
    };

    const readDelimiterCommand = (token: Token): void => {
      const rest = text.slice(token.to);
      const line = rest.split(LINE_BREAK, 1)[0] ?? "";
      const value = line.trim().split(/\s+/, 1)[0] ?? "";
      if (value !== "") delimiter = value;
      lexer.position = token.to + line.length;
      checkpoint = { offset: lexer.position, delimiter };
    };

    const resolvePendingEnd = (current: Statement, token: Token): boolean => {
      if (!current.pendingEnd) return false;
      current.pendingEnd = false;
      const word = token.kind === "word" ? wordOf(text, token) : "";
      if (UNCOUNTED_END_TARGETS.has(word)) return true;
      current.depth = Math.max(0, current.depth - 1);
      return word === CASE;
    };

    for (let token = lexer.next(delimiter); token !== null; token = lexer.next(delimiter)) {
      if (token.kind === "comment") continue;
      if (token.kind === "delimiter") {
        const current: Statement | null = statement;
        if (current !== null) resolvePendingEnd(current, token);
        if (current === null || current.depth === 0 || delimiter !== DEFAULT_DELIMITER) flush(token.to);
        else current.to = token.to;
        continue;
      }
      if (statement === null) {
        if (options.delimiterCommand === true && token.kind === "word" && wordOf(text, token) === DELIMITER_COMMAND) {
          readDelimiterCommand(token);
          continue;
        }
        statement = freshStatement(token.from);
      }
      const current: Statement = statement;
      current.to = token.to;
      const consumed = resolvePendingEnd(current, token);
      if (token.kind !== "word" || consumed) continue;
      const word = wordOf(text, token);
      current.words += 1;
      if (current.words === 1) {
        current.isCreate = word === CREATE;
        continue;
      }
      if (current.depth > 0) {
        if (word === END) current.pendingEnd = true;
        else if (blockKeywords.has(word) || word === CASE) current.depth += 1;
      } else if (current.definesRoutine && blockKeywords.has(word)) {
        current.depth = 1;
      } else if (current.isCreate && BODY_OWNERS.has(word)) {
        current.definesRoutine = true;
      }
    }
    if (final) flush(text.length);
    return { spans, checkpoint };
  };
}

/**
 * A configurable splitter plugins may build `SqlLanguage.split` on (decision 023). It tokenizes
 * strings, quoted identifiers, comments, dollar quotes, `DELIMITER` lines and `BEGIN … END`
 * bodies, and drops statements that hold nothing but comments.
 */
export function sqlSplitter(options: SqlDialectOptions = {}): (text: string) => StatementSpan[] {
  const scan = scanner(options);
  return (text) => scan(text, DEFAULT_DELIMITER, true).spans;
}

/**
 * `sqlSplitter` over text that arrives in pieces, for `SqlLanguage.splitStream` (decision 081).
 * Only whole lines are scanned before `end`, so a token, a `DELIMITER` line or a multi-character
 * delimiter cut by a push is read once its line is complete. Statements come out exactly as
 * `sqlSplitter` would find them in the concatenated text.
 */
export function sqlStatementStream(options: SqlDialectOptions = {}): () => StatementStream {
  const scan = scanner(options);

  return () => {
    let pending = "";
    /** Where `pending` starts in everything pushed, and the line and column there. */
    let base = 0;
    let line = 1;
    let column = 1;
    let delimiter = DEFAULT_DELIMITER;
    let scannedLength = 0;

    const advance = (consumed: string): void => {
      let lineStart = -1;
      for (let at = consumed.indexOf(NEWLINE); at >= 0; at = consumed.indexOf(NEWLINE, at + 1)) {
        line += 1;
        lineStart = at + 1;
      }
      column = lineStart < 0 ? column + consumed.length : consumed.length - lineStart + 1;
      base += consumed.length;
    };

    const located = (spans: readonly StatementSpan[]): StreamedStatement[] => {
      const startLine = line;
      const startColumn = column;
      let cursor = 0;
      let cursorLine = startLine;
      let cursorColumn = startColumn;
      return spans.map((span) => {
        for (
          let at = pending.indexOf(NEWLINE, cursor);
          at >= 0 && at < span.from;
          at = pending.indexOf(NEWLINE, at + 1)
        ) {
          cursorLine += 1;
          cursorColumn = 1;
          cursor = at + 1;
        }
        cursorColumn += span.from - cursor;
        cursor = span.from;
        return { from: base + span.from, to: base + span.to, sql: span.sql, line: cursorLine, column: cursorColumn };
      });
    };

    const run = (final: boolean): StreamedStatement[] => {
      const scanned = final ? pending : pending.slice(0, pending.lastIndexOf(NEWLINE) + 1);
      if (scanned === "") return [];
      const { spans, checkpoint } = scan(scanned, delimiter, final);
      const statements = located(spans);
      const consumed = final ? pending.length : checkpoint.offset;
      advance(pending.slice(0, consumed));
      pending = pending.slice(consumed);
      delimiter = checkpoint.delimiter;
      scannedLength = pending.length;
      return statements;
    };

    return {
      push: (text) => {
        pending += text;
        if (pending.length < scannedLength * RESCAN_GROWTH) return [];
        return run(false);
      },
      end: () => {
        const statements = run(true);
        pending = "";
        return statements;
      },
    };
  };
}
