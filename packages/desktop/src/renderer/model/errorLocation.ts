import type { TextSpan } from "@table-craft/desktop/renderer/model/statementAt.js";

/**
 * Where a failed statement went wrong in the console's text (decision 082): the token at the
 * database's error position, and the statement it belongs to, whose edits drop the mark.
 */
export interface ErrorMark extends TextSpan {
  readonly statementFrom: number;
  readonly statementTo: number;
  readonly message: string;
  readonly hint: string;
}

const WORD = /[\p{L}\p{N}_$]/u;
const SPACE = /\s/u;

function isWord(char: string | undefined): boolean {
  return char !== undefined && WORD.test(char);
}

/**
 * The token at `position`, an offset into `statement.sql`, as document offsets. A position on a
 * word covers the word; on a symbol, that one character; past the last token, as an incomplete
 * statement reports, the token before it, so the mark is never drawn on nothing.
 */
export function errorSpan(statement: TextSpan & { readonly sql: string }, position: number): TextSpan {
  const { sql } = statement;
  const at = Math.min(Math.max(0, Math.trunc(position)), sql.length);
  let from = at;
  if (from >= sql.length || SPACE.test(sql.charAt(from))) {
    while (from > 0 && SPACE.test(sql.charAt(from - 1))) from--;
    if (from === 0) return { from: statement.from + at, to: statement.from + at };
    from--;
  }
  let to = from + 1;
  if (isWord(sql.charAt(from))) {
    while (from > 0 && isWord(sql.charAt(from - 1))) from--;
    while (to < sql.length && isWord(sql.charAt(to))) to++;
  }
  return { from: statement.from + from, to: statement.from + to };
}

/** The mark for a statement's failure, or null when the database said nowhere. */
export function errorMarkOf(
  statement: TextSpan & { readonly sql: string },
  error: { readonly message: string; readonly hint: string; readonly position?: number },
): ErrorMark | null {
  if (error.position === undefined) return null;
  return {
    ...errorSpan(statement, error.position),
    statementFrom: statement.from,
    statementTo: statement.to,
    message: error.message,
    hint: error.hint,
  };
}

function overlaps(mark: ErrorMark, span: TextSpan): boolean {
  return mark.statementFrom < span.to && span.from < mark.statementTo;
}

/** The marks no statement in `ran` covers: running a statement again clears what it said before. */
export function marksOutside(marks: readonly ErrorMark[], ran: readonly TextSpan[]): readonly ErrorMark[] {
  const kept = marks.filter((mark) => !ran.some((span) => overlaps(mark, span)));
  return kept.length === marks.length ? marks : kept;
}

/** Adds `mark`, replacing any earlier mark of the same statement. */
export function withMark(marks: readonly ErrorMark[], mark: ErrorMark): readonly ErrorMark[] {
  return [...marks.filter((kept) => !overlaps(kept, { from: mark.statementFrom, to: mark.statementTo })), mark];
}

/**
 * The mark Go to Error lands on from `caret` (decision 6): the first one starting after it, or
 * before it going back, wrapping around the text; null when there is none.
 */
export function nextMark(marks: readonly ErrorMark[], caret: number, backward: boolean): ErrorMark | null {
  const sorted = [...marks].sort((a, b) => a.from - b.from);
  if (backward) return sorted.filter((mark) => mark.from < caret).at(-1) ?? sorted.at(-1) ?? null;
  return sorted.find((mark) => mark.from > caret) ?? sorted[0] ?? null;
}

const NEWLINE = "\n";

/** The offset of `line` and `column` (both from 1) in `text`, clamped to the text and the line. */
export function offsetOf(text: string, line: number, column: number): number {
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const end = text.indexOf(NEWLINE, start);
    if (end < 0) return text.length;
    start = end + 1;
  }
  const end = text.indexOf(NEWLINE, start);
  return Math.min(start + column - 1, end < 0 ? text.length : end);
}

/** A Run SQL Script failure, positions in its file with lines and columns from 1. */
export interface FileFailure {
  readonly line: number | null;
  readonly column: number | null;
  /** The statement's first characters, as the engine keeps them. */
  readonly statement: string | null;
  readonly at: { readonly line: number; readonly column: number } | null;
  readonly message: string;
  readonly hint: string;
}

/**
 * The marks of a script's failures in its file's `text` (decision 083). A failure whose statement
 * no longer starts where it ran, because the file changed since, marks nothing. The statement
 * reaches at least to the end of the error's line, as the engine keeps only its start.
 */
export function fileMarks(text: string, failures: readonly FileFailure[]): readonly ErrorMark[] {
  let marks: readonly ErrorMark[] = [];
  for (const failure of failures) {
    if (failure.at === null || failure.line === null || failure.statement === null) continue;
    const from = offsetOf(text, failure.line, failure.column ?? 1);
    if (!text.startsWith(failure.statement, from)) continue;
    const position = offsetOf(text, failure.at.line, failure.at.column);
    const lineEnd = text.indexOf(NEWLINE, position);
    const to = Math.max(from + failure.statement.length, lineEnd < 0 ? text.length : lineEnd);
    const mark = errorMarkOf({ from, to, sql: text.slice(from, to) }, { ...failure, position: position - from });
    if (mark !== null) marks = withMark(marks, mark);
  }
  return marks;
}

/** The mark of the failure the console shows, if it still stands. */
export function markOfError(marks: readonly ErrorMark[], error: { readonly message: string } | null): ErrorMark | null {
  if (error === null) return null;
  return marks.filter((mark) => mark.message === error.message).at(-1) ?? null;
}
