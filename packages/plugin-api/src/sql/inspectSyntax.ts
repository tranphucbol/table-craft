import type { Problem, QuickFix } from "@table-craft/plugin-api";
import { problem, removal, type StatementView } from "./inspectContext.js";
import { closingQuote } from "./scope.js";
import { Lexer, type SqlDialectOptions, type Token } from "./tokens.js";

const ID = "SqlSyntax";
const OPEN = "(";
const CLOSE = ")";
const COMMA = ",";
const BY = "BY";
const SELECT = "SELECT";
const EXPRESSION_EXPECTED = "Expression expected";
/** Keywords that start the next clause, so a clause keyword right before one has no body. */
const CLAUSE_STARTS = new Set([
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "RETURNING",
  "WINDOW",
  "FETCH",
  "FROM",
  "INTO",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "STRAIGHT_JOIN",
  "SET",
  "VALUES",
  "ON",
  "USING",
]);
/** Clause keywords that need an expression after them. */
const NEEDS_BODY = new Set(["WHERE", "HAVING", "ON", "SET", SELECT]);
const BY_OWNERS = new Set(["ORDER", "GROUP", "PARTITION"]);
/** Words between `SELECT` and its list that are not the list. */
const SELECT_MODIFIERS = new Set([
  "DISTINCT",
  "ALL",
  "DISTINCTROW",
  "HIGH_PRIORITY",
  "SQL_CALC_FOUND_ROWS",
  "SQL_NO_CACHE",
  "SQL_SMALL_RESULT",
  "SQL_BIG_RESULT",
  "SQL_BUFFER_RESULT",
]);
const LINE_COMMENT_STARTS = ["--", "#"];
const BLOCK_COMMENT_END = "*/";
/** Appended after an unterminated token: a closed token never grows to take it. */
const PROBE = " x";
const DOLLAR = "$";

/** Whether the token at `index` starts the next clause rather than being, say, `LEFT(…)` or `VALUES(…)`. */
function startsClause(view: StatementView, index: number): boolean {
  const word = view.word(index);
  return word !== null && CLAUSE_STARTS.has(word) && !view.isSymbol(index + 1, OPEN);
}

/** Nothing usable follows `index`: the statement ends, its parentheses close, or the next clause starts. */
function nothingFollows(view: StatementView, index: number): boolean {
  const next = index + 1;
  return next >= view.tokens.length || view.isSymbol(next, CLOSE) || startsClause(view, next);
}

function emptyClause(view: StatementView, index: number): Problem | null {
  const word = view.word(index);
  if (word === null) return null;
  let first = index;
  let last = index;
  if (word === BY) {
    const owner = view.word(index - 1);
    if (owner === null || !BY_OWNERS.has(owner)) return null;
    first = index - 1;
  } else if (!NEEDS_BODY.has(word)) {
    return null;
  }
  if (word === SELECT) while (SELECT_MODIFIERS.has(view.word(last + 1) ?? "")) last += 1;
  if (!nothingFollows(view, last)) return null;
  const start = view.token(first);
  const end = view.token(last);
  if (start === undefined || end === undefined) return null;
  const label = view.text.slice(start.from, end.to).toUpperCase().replace(/\s+/g, " ");
  const fixes: QuickFix[] = [];
  if (word !== SELECT) {
    const following = view.token(last + 1);
    const span =
      following === undefined || view.isSymbol(last + 1, CLOSE)
        ? view.withLeadingSpace(first, last)
        : { from: start.from, to: following.from };
    fixes.push(removal(`Remove empty ${label} clause`, span));
  }
  return problem(ID, "error", { from: start.from, to: end.to }, EXPRESSION_EXPECTED, fixes);
}

function trailingComma(view: StatementView, index: number): Problem | null {
  if (!view.isSymbol(index, COMMA) || !nothingFollows(view, index)) return null;
  const comma = view.token(index);
  if (comma === undefined) return null;
  const next = view.word(index + 1);
  const message = next === null ? "Trailing comma" : `Trailing comma before ${next}`;
  return problem(ID, "error", comma, message, [removal("Remove trailing comma", comma)]);
}

function parentheses(view: StatementView): Problem[] {
  const problems: Problem[] = [];
  const open: Token[] = [];
  view.tokens.forEach((token, index) => {
    if (view.isSymbol(index, OPEN)) open.push(token);
    else if (view.isSymbol(index, CLOSE) && open.pop() === undefined)
      problems.push(problem(ID, "error", token, `Unexpected '${CLOSE}'`, [removal(`Remove '${CLOSE}'`, token)]));
  });
  for (const token of open) {
    const fix: QuickFix = { title: `Add closing '${CLOSE}'`, edits: [{ from: view.end, to: view.end, insert: CLOSE }] };
    problems.push(problem(ID, "error", { from: token.from, to: token.to }, `'${CLOSE}' expected`, [fix]));
  }
  return problems;
}

/** Empty clauses, trailing commas and unbalanced parentheses in one statement. */
export function syntaxProblems(view: StatementView): Problem[] {
  const problems = parentheses(view);
  if (!view.inspected) return problems;
  for (let index = 0; index < view.tokens.length; index += 1) {
    const found = emptyClause(view, index) ?? trailingComma(view, index);
    if (found !== null) problems.push(found);
  }
  return problems;
}

/** What closes an unterminated token, and what to call it; null for a token that cannot run on. */
function closer(raw: string): { close: string; what: string } | null {
  if (LINE_COMMENT_STARTS.some((start) => raw.startsWith(start))) return null;
  if (raw.startsWith("/*")) return { close: BLOCK_COMMENT_END, what: "comment" };
  if (raw.startsWith(DOLLAR)) {
    const tag = raw.slice(0, raw.indexOf(DOLLAR, 1) + 1);
    return { close: tag, what: "string literal" };
  }
  const quoteAt = raw.search(/['"`[]/);
  if (quoteAt < 0) return null;
  const quote = raw.charAt(quoteAt);
  return { close: closingQuote(quote), what: quote === "'" ? "string literal" : "quoted identifier" };
}

/**
 * A string, quoted name or block comment the text ends inside. Only the last token can be one,
 * since an unterminated token runs to the end of the text.
 */
export function unterminatedProblem(text: string, last: Token | undefined, dialect: SqlDialectOptions): Problem | null {
  if (last === undefined || last.to !== text.length) return null;
  if (last.kind !== "string" && last.kind !== "quoted" && last.kind !== "comment") return null;
  const raw = text.slice(last.from);
  const probed = new Lexer(raw + PROBE, dialect).next();
  if (probed === null || probed.to <= raw.length) return null;
  const found = closer(raw);
  if (found === null) return null;
  const fix: QuickFix = {
    title: `Add closing ${found.close}`,
    edits: [{ from: text.length, to: text.length, insert: found.close }],
  };
  return problem(ID, "error", last, `Unclosed ${found.what}`, [fix]);
}
