import { Lexer, type SqlDialectOptions, type Token } from "./tokens.js";

/** Raised for SQL the aligned layout does not read; the statement then goes to `sql-formatter` (decision 062). */
export class Unsupported extends Error {}

export interface Tok {
  readonly type: "tok";
  readonly kind: "word" | "quoted" | "string" | "symbol";
  readonly text: string;
  readonly upper: string;
  /** Whitespace or a comment stood between it and the token before it in the source. */
  readonly spaced: boolean;
  /** Read as a keyword: cased by `keywordCase`, and a `(` after it gets a space. */
  keyword: boolean;
  /** Comments on their own lines before it. */
  readonly leading: string[];
  /** Comments after it on its line. */
  readonly trailing: string[];
}

export interface Group {
  readonly type: "group";
  readonly open: Tok;
  readonly children: Node[];
  readonly close: Tok;
}

/** `CASE … END`, a node so its `WHEN a AND b` never splits a condition list. */
export interface CaseNode {
  readonly type: "case";
  readonly head: Tok;
  readonly children: Node[];
  readonly end: Tok;
}

export type Node = Tok | Group | CaseNode;

export interface Statement {
  readonly nodes: Node[];
  /** Comments on their own lines after the last token. */
  readonly tail: string[];
}

const OPERATOR_CHARS = new Set("+-*/<>=~!@#%^&|`?:");
const OPEN = "(";
const CLOSE = ")";
const COMMA = ",";
const DOT = ".";
const CAST = "::";
const CASE = "CASE";
const END = "END";
const LINE_BREAK = "\n";

/** Reserved in PostgreSQL or MySQL, so never a bare column or table name worth keeping in its case. */
const RESERVED = new Set([
  "ALL",
  "AND",
  "ANY",
  "AS",
  "ASC",
  "BETWEEN",
  "BY",
  "CASE",
  "CROSS",
  "DEFAULT",
  "DELETE",
  "DESC",
  "DISTINCT",
  "DISTINCTROW",
  "DIV",
  "ELSE",
  "END",
  "ESCAPE",
  "EXCEPT",
  "EXISTS",
  "FALSE",
  "FETCH",
  "FOR",
  "FROM",
  "FULL",
  "GROUP",
  "HAVING",
  "HIGH_PRIORITY",
  "IGNORE",
  "ILIKE",
  "IN",
  "INNER",
  "INSERT",
  "INTERSECT",
  "INTERVAL",
  "INTO",
  "IS",
  "ISNULL",
  "JOIN",
  "LATERAL",
  "LEFT",
  "LIKE",
  "LIMIT",
  "LOW_PRIORITY",
  "NATURAL",
  "NOT",
  "NOTNULL",
  "NULL",
  "OFFSET",
  "ON",
  "OR",
  "ORDER",
  "OUTER",
  "OVER",
  "PARTITION",
  "RECURSIVE",
  "REGEXP",
  "RETURNING",
  "RIGHT",
  "RLIKE",
  "SELECT",
  "SET",
  "SIMILAR",
  "SOME",
  "SQL_BIG_RESULT",
  "SQL_BUFFER_RESULT",
  "SQL_CACHE",
  "SQL_CALC_FOUND_ROWS",
  "SQL_NO_CACHE",
  "SQL_SMALL_RESULT",
  "STRAIGHT_JOIN",
  "TABLESAMPLE",
  "THEN",
  "TRUE",
  "UNION",
  "UPDATE",
  "USING",
  "VALUES",
  "WHEN",
  "WHERE",
  "WINDOW",
  "WITH",
  "XOR",
]);

/** Keywords that are also functions; glued to a `(` as written they are the function, cased as written. */
const FUNCTION_KEYWORDS = new Set(["DEFAULT", "INSERT", "INTERVAL", "LEFT", "RIGHT", "VALUES"]);

/** Pairs where the second word is a keyword only after the first (`USE INDEX`, `NULLS LAST`). */
const CONTEXTUAL_PAIRS: readonly (readonly [ReadonlySet<string>, ReadonlySet<string>])[] = [
  [new Set(["USE", "FORCE", "IGNORE"]), new Set(["INDEX", "KEY"])],
  [new Set(["ON"]), new Set(["DUPLICATE", "CONFLICT", "CONSTRAINT"])],
  [new Set(["DUPLICATE"]), new Set(["KEY"])],
  [new Set(["DO"]), new Set(["NOTHING", "UPDATE"])],
  [new Set(["NULLS"]), new Set(["FIRST", "LAST"])],
  [new Set(["LOCK"]), new Set(["IN"])],
  [new Set(["SHARE"]), new Set(["MODE"])],
  [new Set(["FOR"]), new Set(["SHARE", "NO", "KEY"])],
  [new Set(["NO"]), new Set(["KEY"])],
  [new Set(["KEY"]), new Set(["SHARE", "UPDATE"])],
  [new Set(["SKIP"]), new Set(["LOCKED"])],
  [new Set(["FETCH"]), new Set(["FIRST", "NEXT"])],
  [new Set(["ROW", "ROWS"]), new Set(["ONLY"])],
  [new Set(["WITH"]), new Set(["TIES"])],
  [new Set(["FROM", "JOIN", "UPDATE"]), new Set(["ONLY"])],
  [new Set(["AS", "NOT"]), new Set(["MATERIALIZED"])],
  [new Set(["UPDATE", "SHARE"]), new Set(["NOWAIT"])],
];
/** The first word of a pair that is a keyword itself once its second word follows. */
const CONTEXTUAL_LEADS = new Set(["USE", "FORCE", "DUPLICATE", "DO", "NULLS", "LOCK", "SHARE", "NO", "KEY", "SKIP"]);
/** Inside `OVER ( … )`: the frame clause. */
const WINDOW_WORDS = new Set([
  "ROWS",
  "RANGE",
  "GROUPS",
  "UNBOUNDED",
  "PRECEDING",
  "FOLLOWING",
  "CURRENT",
  "ROW",
  "EXCLUDE",
  "TIES",
  "OTHERS",
  "NO",
]);

interface Flat {
  readonly token: Token;
  readonly text: string;
  readonly spaced: boolean;
  readonly leading: string[];
  readonly trailing: string[];
}

/** Operator characters next to each other are one operator, so the layout never puts a space inside `>=` or `->>`. */
function mergeOperators(text: string, tokens: readonly Token[]): Token[] {
  const merged: Token[] = [];
  for (const token of tokens) {
    const last = merged.at(-1);
    if (
      last !== undefined &&
      token.kind === "symbol" &&
      last.kind === "symbol" &&
      last.to === token.from &&
      OPERATOR_CHARS.has(text.charAt(token.from)) &&
      OPERATOR_CHARS.has(text.charAt(last.from))
    ) {
      merged[merged.length - 1] = { kind: "symbol", from: last.from, to: token.to };
    } else {
      merged.push(token);
    }
  }
  return merged;
}

export function isLineComment(comment: string): boolean {
  return !comment.startsWith("/*");
}

function flatten(text: string, dialect: SqlDialectOptions): { flat: Flat[]; tail: string[] } {
  const lexer = new Lexer(text, dialect);
  const significant: Token[] = [];
  const comments: Token[] = [];
  for (let token = lexer.next(); token !== null; token = lexer.next()) {
    if (token.kind === "delimiter") throw new Unsupported("a statement holding a delimiter");
    (token.kind === "comment" ? comments : significant).push(token);
  }
  const tokens = mergeOperators(text, significant);
  const flat: Flat[] = tokens.map((token, index) => {
    const before = tokens[index - 1];
    return {
      token,
      text: text.slice(token.from, token.to),
      spaced: before === undefined || before.to < token.from,
      leading: [],
      trailing: [],
    };
  });
  const tail: string[] = [];
  let next = 0;
  for (const comment of comments) {
    while (next < flat.length && (flat[next]?.token.from ?? 0) < comment.from) next += 1;
    const content = text.slice(comment.from, comment.to);
    const previous = flat[next - 1];
    if (previous !== undefined && !text.slice(previous.token.to, comment.from).includes(LINE_BREAK)) {
      previous.trailing.push(content);
    } else if (next < flat.length) {
      flat[next]?.leading.push(content);
    } else {
      tail.push(content);
    }
  }
  moveCommentsPastCommas(flat);
  return { flat, tail };
}

/** `a -- note` then `, b` reads as `a, -- note`; a comment on its own line before a comma goes after it. */
function moveCommentsPastCommas(flat: Flat[]): void {
  flat.forEach((entry, index) => {
    if (entry.text !== COMMA) return;
    const previous = flat[index - 1];
    if (previous !== undefined && previous.trailing.some(isLineComment)) {
      entry.trailing.unshift(...previous.trailing.splice(0));
    }
    const following = flat[index + 1];
    if (following !== undefined && entry.leading.length > 0) following.leading.unshift(...entry.leading.splice(0));
  });
}

function keywordFlags(flat: readonly Flat[]): boolean[] {
  const uppers = flat.map((entry) => (entry.token.kind === "word" ? entry.text.toUpperCase() : ""));
  const flags = flat.map((entry, index) => {
    const upper = uppers[index] ?? "";
    if (!RESERVED.has(upper)) return false;
    const previous = flat[index - 1];
    if (previous?.text === CAST || (previous?.text === DOT && !entry.spaced)) return false;
    const next = flat[index + 1];
    return !(FUNCTION_KEYWORDS.has(upper) && next?.text === OPEN && !next.spaced);
  });
  uppers.forEach((upper, index) => {
    const next = uppers[index + 1] ?? "";
    for (const [first, second] of CONTEXTUAL_PAIRS) {
      if (!first.has(upper) || !second.has(next)) continue;
      flags[index + 1] = true;
      if (CONTEXTUAL_LEADS.has(upper)) flags[index] = true;
    }
  });
  const overDepths: number[] = [];
  let depth = 0;
  flat.forEach((entry, index) => {
    if (entry.text === OPEN) {
      depth += 1;
      if (uppers[index - 1] === "OVER") overDepths.push(depth);
    } else if (entry.text === CLOSE) {
      if (overDepths.at(-1) === depth) overDepths.pop();
      depth -= 1;
    } else if (overDepths.at(-1) === depth && WINDOW_WORDS.has(uppers[index] ?? "")) {
      flags[index] = true;
    }
  });
  return flags;
}

interface Frame {
  readonly opener: Tok | null;
  readonly kind: "root" | "group" | "case";
  readonly children: Node[];
}

/** The statement as tokens nested by parentheses and `CASE … END`; throws `Unsupported` when they do not balance. */
export function parseStatement(text: string, dialect: SqlDialectOptions): Statement {
  const { flat, tail } = flatten(text, dialect);
  const flags = keywordFlags(flat);
  const stack: Frame[] = [{ opener: null, kind: "root", children: [] }];
  const top = (): Frame => stack[stack.length - 1] ?? { opener: null, kind: "root", children: [] };
  flat.forEach((entry, index) => {
    const kind = entry.token.kind === "comment" || entry.token.kind === "delimiter" ? "symbol" : entry.token.kind;
    const tok: Tok = {
      type: "tok",
      kind,
      text: entry.text,
      upper: entry.text.toUpperCase(),
      spaced: entry.spaced,
      keyword: flags[index] ?? false,
      leading: entry.leading,
      trailing: entry.trailing,
    };
    if (tok.text === OPEN) {
      stack.push({ opener: tok, kind: "group", children: [] });
    } else if (tok.text === CLOSE) {
      const frame = stack.pop();
      if (frame?.kind !== "group" || frame.opener === null) throw new Unsupported("an unbalanced parenthesis");
      top().children.push({ type: "group", open: frame.opener, children: frame.children, close: tok });
    } else if (tok.keyword && tok.upper === CASE) {
      stack.push({ opener: tok, kind: "case", children: [] });
    } else if (tok.keyword && tok.upper === END) {
      const frame = stack.pop();
      if (frame?.kind !== "case" || frame.opener === null) throw new Unsupported("an END without its CASE");
      top().children.push({ type: "case", head: frame.opener, children: frame.children, end: tok });
    } else {
      top().children.push(tok);
    }
  });
  if (stack.length !== 1) throw new Unsupported("an unclosed parenthesis or CASE");
  return { nodes: top().children, tail };
}

export function firstTok(node: Node): Tok {
  if (node.type === "tok") return node;
  return node.type === "group" ? node.open : node.head;
}

export function lastTok(node: Node): Tok {
  if (node.type === "tok") return node;
  return node.type === "group" ? node.close : node.end;
}

/** `node` is the keyword `word`. */
export function isWord(node: Node | undefined, word: string): node is Tok {
  return node?.type === "tok" && node.keyword && node.upper === word;
}

/** `node` is a word spelled `word`, keyword or not (a clause the layout reads structurally). */
export function spells(node: Node | undefined, word: string): node is Tok {
  return node?.type === "tok" && node.kind === "word" && node.upper === word;
}
