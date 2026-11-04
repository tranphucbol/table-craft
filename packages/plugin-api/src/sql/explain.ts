import type { ExplainCheck, Explainability, ExplainOptions, Row } from "@table-craft/plugin-api";
import { classifyTokens } from "./classify.js";
import { sqlSplitter } from "./splitter.js";
import { significantTokens, type SqlDialectOptions } from "./tokens.js";
import { EXPLAIN_VERBS, mainVerb, words, type Word } from "./words.js";

/** What `sqlExplainable` needs to know about a dialect's EXPLAIN (decision 031). */
export interface ExplainableOptions {
  readonly dialect: SqlDialectOptions;
  /** The database's name, as a refusal names it: `PostgreSQL`. */
  readonly name: string;
  /**
   * The verbs EXPLAIN accepts, as the verb that decides what a statement does (`SELECT`, or the one
   * after `WITH …`); `CREATE_TABLE_AS` stands for `CREATE TABLE … AS`.
   */
  readonly verbs: readonly string[];
  /** The verbs Explain Analyse accepts, a subset of `verbs`; empty where the dialect cannot analyse. */
  readonly analyzeVerbs: readonly string[];
}

export const NOTHING_TO_EXPLAIN = "There is no statement to explain; put the caret in one.";
export const EXPLAIN_ONE_STATEMENT = "Explain one statement at a time.";
export const ALREADY_EXPLAIN = "This statement is already an EXPLAIN; run it with Run to see its rows.";

const CREATE = "CREATE";
const TABLE = "TABLE";
const AS = "AS";
/** How `ExplainableOptions` names `CREATE TABLE … AS`, which `CREATE TABLE` alone is not. */
export const CREATE_TABLE_AS = "CREATE TABLE … AS";

function anyOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1) ?? ""}`;
}

function isCreateTableAs(list: readonly Word[]): boolean {
  if (list[0]?.word !== CREATE) return false;
  const table = list.findIndex((entry) => entry.depth === 0 && entry.word === TABLE);
  return table > 0 && list.some((entry, at) => at > table && entry.depth === 0 && entry.word === AS);
}

/**
 * The refusals every dialect shares: nothing to explain, more than one statement, and a statement
 * that already is an EXPLAIN. Null when none applies.
 */
export function commonExplainRefusal(sql: string, dialect: SqlDialectOptions): string | null {
  const spans = sqlSplitter(dialect)(sql);
  if (spans.length === 0) return NOTHING_TO_EXPLAIN;
  if (spans.length > 1) return EXPLAIN_ONE_STATEMENT;
  const first = words(sql, significantTokens(sql, dialect))[0]?.word;
  return first !== undefined && EXPLAIN_VERBS.has(first) ? ALREADY_EXPLAIN : null;
}

/**
 * The verb that decides what `sql` does, upper case: `SELECT`, the verb after `WITH …`, or
 * `CREATE_TABLE_AS`; empty for no statement. A plugin picks its EXPLAIN format by it.
 */
export function explainedVerb(sql: string, dialect: SqlDialectOptions): string {
  const list = words(sql, significantTokens(sql, dialect));
  return isCreateTableAs(list) ? CREATE_TABLE_AS : (list[mainVerb(list)]?.word ?? "");
}

/**
 * The `explain` language service (`ExplainCheck`) from a dialect's verb lists: the shared refusals, then the statement's
 * main verb against what the dialect explains and analyses. A statement writes when it is not a read.
 */
export function sqlExplainable(options: ExplainableOptions): ExplainCheck {
  const verbs = new Set(options.verbs);
  const analyzeVerbs = new Set(options.analyzeVerbs);
  const explainable = (sql: string, { analyze }: ExplainOptions): Explainability => {
    const common = commonExplainRefusal(sql, options.dialect);
    if (common !== null) return { ok: false, reason: common };
    const statement = sqlSplitter(options.dialect)(sql)[0]?.sql ?? sql;
    const verb = explainedVerb(statement, options.dialect);
    if (!verbs.has(verb)) {
      return {
        ok: false,
        reason: `${options.name} cannot explain a ${verb} statement. Explain ${anyOf(options.verbs)} instead.`,
      };
    }
    if (analyze && !analyzeVerbs.has(verb)) {
      return {
        ok: false,
        reason:
          analyzeVerbs.size === 0
            ? `${options.name} cannot run Explain Analyse; use Explain Plan.`
            : `${options.name} analyses only ${anyOf(options.analyzeVerbs)} statements; use Explain Plan for this ${verb}.`,
      };
    }
    return { ok: true, writes: classifyTokens(statement, options.dialect).kind !== "read" };
  };
  return { explainable };
}

const LINE_BREAK = "\n";

/** The first cell of every row as text, one row per line: what an EXPLAIN printed. */
export function planText(rows: readonly Row[]): string {
  return rows
    .map((row) => {
      const cell = row[0];
      if (cell === null || cell === undefined) return "";
      if (typeof cell === "object") return cell.kind === "json" ? cell.text : JSON.stringify(cell);
      return String(cell);
    })
    .join(LINE_BREAK);
}

/**
 * A plan property's value as one line of text: strings as they are, lists joined with commas,
 * anything nested as JSON. Null for nothing worth showing: null, or an empty list.
 */
export function planPropertyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const flat = value.every((item) => item === null || typeof item !== "object");
    return flat ? value.map((item) => String(item)).join(", ") : JSON.stringify(value);
  }
  return JSON.stringify(value);
}
