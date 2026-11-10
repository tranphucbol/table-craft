import type { RowLimiter, RowLimitRewrite } from "@table-craft/plugin-api";
import { significantTokens, wordOf, type SqlDialectOptions, type Token } from "./tokens.js";

/**
 * How a dialect writes a row limit: `LIMIT n` at the end (MySQL, PostgreSQL, SQLite, DuckDB),
 * `FETCH FIRST n ROWS ONLY` at the end (Oracle 12c and later, SQL:2008) or `TOP (n)` after
 * `SELECT` (SQL Server).
 */
export type RowLimitStyle = "limit" | "fetchFirst" | "top";

const SELECT = "SELECT";
const WITH = "WITH";
const TOP = "TOP";
const OPEN_PAREN = "(";
const CLOSE_PAREN = ")";
/** What may stand between `SELECT` and `TOP`. */
const SET_QUANTIFIERS = new Set(["ALL", "DISTINCT"]);
const MAIN_VERBS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);
/** A top-level row limit the statement already has. */
const OWN_LIMITS = new Set(["LIMIT", "OFFSET", "FETCH"]);
/**
 * Top-level words that make a SELECT more than a read of rows a limit may trim: `INTO` writes,
 * `FOR UPDATE` and `LOCK IN SHARE MODE` lock what they read, `PROCEDURE` hands the rows to MySQL.
 */
const NOT_A_PLAIN_READ = new Set(["INTO", "FOR", "LOCK", "PROCEDURE"]);
/** A data-modifying CTE or subquery runs whatever the limit trims. */
const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
/** `TOP` limits only the SELECT it opens, not the whole combined query. */
const SET_OPERATIONS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);

interface PlacedWord {
  readonly word: string;
  readonly depth: number;
  readonly token: Token;
}

function placedWords(sql: string, tokens: readonly Token[]): PlacedWord[] {
  const found: PlacedWord[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "symbol") {
      const char = sql.charAt(token.from);
      if (char === OPEN_PAREN) depth += 1;
      else if (char === CLOSE_PAREN) depth = Math.max(0, depth - 1);
    } else if (token.kind === "word") {
      found.push({ word: wordOf(sql, token), depth, token });
    }
  }
  return found;
}

function mainSelect(list: readonly PlacedWord[]): number | null {
  const first = list[0];
  if (first === undefined || first.depth !== 0) return null;
  if (first.word === SELECT) return 0;
  if (first.word !== WITH) return null;
  const verb = list.findIndex((entry, at) => at > 0 && entry.depth === 0 && MAIN_VERBS.has(entry.word));
  return verb > 0 && list[verb]?.word === SELECT ? verb : null;
}

/** The statement's tokens up to its delimiter; null when another statement follows it. */
function ownTokens(tokens: readonly Token[]): readonly Token[] | null {
  const end = tokens.findIndex((token) => token.kind === "delimiter");
  if (end < 0) return tokens;
  return tokens.slice(end).every((token) => token.kind === "delimiter") ? tokens.slice(0, end) : null;
}

function insert(sql: string, offset: number, text: string): RowLimitRewrite {
  return { sql: sql.slice(0, offset) + text + sql.slice(offset), inserted: { offset, length: text.length } };
}

function topOffset(list: readonly PlacedWord[], verb: number): number | null {
  let at = verb + 1;
  if (SET_QUANTIFIERS.has(list[at]?.word ?? "")) at += 1;
  if (list[at]?.word === TOP) return null;
  return list[at - 1]?.token.to ?? null;
}

/**
 * The `rowLimit` language service for a dialect (decision 162). It limits a plain SELECT, `WITH`
 * included, by one insertion, and answers null for anything it cannot limit without changing what
 * the statement does or reading it wrongly: another verb, a limit of its own, `INTO`, a locking
 * read, a data-modifying CTE, more than one statement, and under `top` a combined query.
 */
export function sqlRowLimiter(options: SqlDialectOptions, style: RowLimitStyle): RowLimiter {
  return {
    limit(sql, rows) {
      if (!Number.isSafeInteger(rows) || rows < 1)
        throw new RangeError(`A row limit is a positive integer, not ${rows}`);
      const tokens = ownTokens(significantTokens(sql, options));
      const last = tokens?.at(-1);
      if (tokens === null || last === undefined) return null;
      const list = placedWords(sql, tokens);
      const verb = mainSelect(list);
      if (verb === null) return null;
      if (list.some((entry) => WRITES.has(entry.word))) return null;
      const top = list.slice(verb + 1).filter((entry) => entry.depth === 0);
      if (top.some((entry) => OWN_LIMITS.has(entry.word) || NOT_A_PLAIN_READ.has(entry.word))) return null;
      if (style === "top") {
        if (top.some((entry) => SET_OPERATIONS.has(entry.word))) return null;
        const offset = topOffset(list, verb);
        return offset === null ? null : insert(sql, offset, ` ${TOP} (${rows})`);
      }
      const clause = style === "limit" ? ` LIMIT ${rows}` : ` FETCH FIRST ${rows} ROWS ONLY`;
      return insert(sql, last.to, clause);
    },
  };
}
