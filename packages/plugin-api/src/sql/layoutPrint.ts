import type { FormatOptions } from "@table-craft/plugin-api";
import { EXPLAIN_VERBS } from "./words.js";
import {
  firstTok,
  isWord,
  lastTok,
  spells,
  Unsupported,
  type CaseNode,
  type Group,
  type Node,
  type Tok,
} from "./layoutNodes.js";
import { Writer } from "./layoutWriter.js";

/** Past this width an aliased expression neither pads to the alias column nor pushes it right. */
export const ALIAS_ALIGN_LIMIT = 80;
/** A `CASE` up to this width stays on one line. */
export const CASE_INLINE_LIMIT = 60;
/** A parenthesised condition group ending past this column opens one condition per line (DataGrip's margin). */
export const RIGHT_MARGIN = 120;

const COMMA = ",";
const CAST = "::";
const EQUALS = "=";
/** Operators written with one space on each side; any other run of operator characters keeps its source spacing. */
const SPACED_OPERATORS = new Set(["=", "<", ">", "<=", ">=", "<>", "!=", "<=>", ":="]);
const SET_OPERATORS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);
const SET_QUANTIFIERS = new Set(["ALL", "DISTINCT"]);
const SELECT_MODIFIERS = new Set([
  "ALL",
  "DISTINCT",
  "DISTINCTROW",
  "HIGH_PRIORITY",
  "STRAIGHT_JOIN",
  "SQL_SMALL_RESULT",
  "SQL_BIG_RESULT",
  "SQL_BUFFER_RESULT",
  "SQL_NO_CACHE",
  "SQL_CACHE",
  "SQL_CALC_FOUND_ROWS",
]);
const JOIN_WORDS = new Set(["JOIN", "STRAIGHT_JOIN"]);
const JOIN_MODIFIERS = new Set(["NATURAL", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS"]);
const CONDITION_OPERATORS = new Set(["AND", "OR"]);
const QUERY_VERBS = new Set(["SELECT", "WITH", "INSERT", "REPLACE", "UPDATE", "DELETE"]);
const EXPLAIN_WORDS = new Set([
  "EXPLAIN",
  "DESCRIBE",
  "DESC",
  "ANALYZE",
  "ANALYSE",
  "VERBOSE",
  "FORMAT",
  "EXTENDED",
  "PARTITIONS",
  "QUERY",
  "PLAN",
]);
const INDEX_WORDS = new Set(["INDEX", "KEY"]);
const DELETE_MODIFIERS = new Set(["LOW_PRIORITY", "QUICK", "IGNORE"]);

interface Clause {
  readonly name: string;
  readonly keywords: Tok[];
  readonly body: Node[];
}

/** How many tokens at `index` open a clause named by them, or 0. */
type ClauseMatcher = (nodes: readonly Node[], index: number, current: string) => number;

interface Condition {
  readonly operator: Tok | null;
  readonly nodes: Node[];
}

interface Split {
  readonly parts: Node[][];
  readonly commas: Tok[];
}

function wordAt(nodes: readonly Node[], index: number): string {
  const node = nodes[index];
  return node?.type === "tok" && node.kind === "word" ? node.upper : "";
}

function keywordAt(nodes: readonly Node[], index: number): string {
  const node = nodes[index];
  return node?.type === "tok" && node.keyword ? node.upper : "";
}

function selectClauses(nodes: readonly Node[], index: number, current: string): number {
  const word = keywordAt(nodes, index);
  switch (word) {
    case "SELECT":
    case "INTO":
    case "FROM":
    case "WHERE":
    case "HAVING":
    case "WINDOW":
    case "LIMIT":
    case "FETCH":
      return 1;
    case "GROUP":
    case "ORDER":
      return wordAt(nodes, index + 1) === "BY" ? 2 : 0;
    case "OFFSET":
      return current === "LIMIT" ? 0 : 1;
    case "FOR":
      return INDEX_WORDS.has(wordAt(nodes, index - 1)) || current === "FOR" ? 0 : 1;
    case "LOCK":
      return wordAt(nodes, index + 1) === "IN" ? 1 : 0;
    default:
      return 0;
  }
}

function updateClauses(nodes: readonly Node[], index: number): number {
  const word = keywordAt(nodes, index);
  if (word === "UPDATE" || word === "SET" || word === "FROM" || word === "WHERE" || word === "LIMIT") return 1;
  if (word === "RETURNING") return 1;
  return word === "ORDER" && wordAt(nodes, index + 1) === "BY" ? 2 : 0;
}

function deleteClauses(nodes: readonly Node[], index: number): number {
  const word = keywordAt(nodes, index);
  if (word === "DELETE" || word === "FROM" || word === "USING" || word === "WHERE" || word === "LIMIT") return 1;
  if (word === "RETURNING") return 1;
  return word === "ORDER" && wordAt(nodes, index + 1) === "BY" ? 2 : 0;
}

function splitClauses(nodes: readonly Node[], matcher: ClauseMatcher): { head: Node[]; clauses: Clause[] } {
  const head: Node[] = [];
  const clauses: { name: string; keywords: Tok[]; body: Node[] }[] = [];
  for (let index = 0; index < nodes.length;) {
    const count = matcher(nodes, index, clauses.at(-1)?.name ?? "");
    if (count > 0) {
      const keywords = nodes.slice(index, index + count) as Tok[];
      for (const keyword of keywords) keyword.keyword = true;
      clauses.push({ name: keywords.map((keyword) => keyword.upper).join(" "), keywords, body: [] });
      index += count;
      continue;
    }
    const node = nodes[index];
    if (node !== undefined) (clauses.at(-1)?.body ?? head).push(node);
    index += 1;
  }
  return { head, clauses };
}

function splitTop(nodes: readonly Node[], separator: string): Split {
  const parts: Node[][] = [[]];
  const commas: Tok[] = [];
  for (const node of nodes) {
    if (node.type === "tok" && node.text === separator) {
      commas.push(node);
      parts.push([]);
    } else {
      parts[parts.length - 1]?.push(node);
    }
  }
  return { parts, commas };
}

/** Top-level `AND` / `OR`, but not the `AND` of `BETWEEN a AND b`. */
function splitConditions(nodes: readonly Node[]): Condition[] {
  const conditions: { operator: Tok | null; nodes: Node[] }[] = [{ operator: null, nodes: [] }];
  let between = false;
  for (const node of nodes) {
    if (isWord(node, "BETWEEN")) between = true;
    if (node.type === "tok" && node.keyword && CONDITION_OPERATORS.has(node.upper)) {
      if (between && node.upper === "AND") {
        between = false;
      } else {
        conditions.push({ operator: node, nodes: [] });
        continue;
      }
    }
    conditions[conditions.length - 1]?.nodes.push(node);
  }
  return conditions;
}

function isQueryStart(nodes: readonly Node[]): boolean {
  const first = nodes[0];
  if (first === undefined) return false;
  if (first.type === "group") return isQueryStart(first.children);
  return first.type === "tok" && (isWord(first, "SELECT") || isWord(first, "WITH"));
}

function isSubquery(group: Group): boolean {
  return isQueryStart(group.children);
}

function isSpacedOperator(tok: Tok): boolean {
  return tok.kind === "symbol" && SPACED_OPERATORS.has(tok.text);
}

function casedKeyword(text: string, options: FormatOptions): string {
  if (options.keywordCase === "upper") return text.toUpperCase();
  if (options.keywordCase === "lower") return text.toLowerCase();
  return text;
}

interface InlineOptions {
  /** The source's own spacing between every two tokens (the `EXPLAIN` prefix, where `FORMAT=JSON` stays). */
  readonly preserve?: boolean;
  /** A `(` after a name gets a space (`INSERT INTO t (a, b)`, `WITH x (a) AS`). */
  readonly spaceBeforeGroup?: boolean;
}

/** The aligned layout of one statement (decision 061). Throws `Unsupported` for what it does not read. */
export class AlignedPrinter {
  constructor(readonly options: FormatOptions) {}

  text(tok: Tok): string {
    return tok.keyword ? casedKeyword(tok.text, this.options) : tok.text;
  }

  print(nodes: readonly Node[], tail: readonly string[]): { text: string; endsInLineComment: boolean } {
    const writer = new Writer(0);
    const prefixEnd = this.#explainPrefixEnd(nodes);
    if (prefixEnd > 0) {
      this.inline(writer, nodes.slice(0, prefixEnd), false, { preserve: true });
      writer.newline(0);
    }
    this.statement(writer, nodes.slice(prefixEnd), 0);
    for (const comment of tail) writer.comment(comment, 0);
    return { text: writer.out, endsInLineComment: writer.endsInLineComment };
  }

  #explainPrefixEnd(nodes: readonly Node[]): number {
    if (!EXPLAIN_VERBS.has(wordAt(nodes, 0))) return 0;
    const start = nodes.findIndex(
      (node) =>
        (node.type === "tok" && node.kind === "word" && QUERY_VERBS.has(node.upper)) ||
        (node.type === "group" && isSubquery(node)),
    );
    if (start <= 0) throw new Unsupported("an EXPLAIN of no query");
    for (const node of nodes.slice(0, start)) this.#markExplainWords(node);
    return start;
  }

  #markExplainWords(node: Node): void {
    if (node.type === "tok") {
      if (node.kind === "word" && EXPLAIN_WORDS.has(node.upper)) node.keyword = true;
    } else if (node.type === "group") {
      for (const child of node.children) this.#markExplainWords(child);
    }
  }

  statement(writer: Writer, nodes: readonly Node[], base: number): void {
    const first = nodes[0];
    if (first === undefined) throw new Unsupported("an empty statement");
    if (first.type === "group") {
      this.setQuery(writer, nodes, base);
      return;
    }
    switch (first.type === "tok" && first.kind === "word" ? first.upper : "") {
      case "WITH":
        this.withQuery(writer, nodes, base);
        return;
      case "SELECT":
        this.setQuery(writer, nodes, base);
        return;
      case "INSERT":
      case "REPLACE":
        this.insert(writer, nodes, base);
        return;
      case "UPDATE":
        this.update(writer, nodes, base);
        return;
      case "DELETE":
        this.delete(writer, nodes, base);
        return;
      default:
        throw new Unsupported("a statement the aligned layout does not read");
    }
  }

  withQuery(writer: Writer, nodes: readonly Node[], base: number): void {
    let index = 0;
    const keywords: Tok[] = [];
    while (index < nodes.length && (isWord(nodes[index], "WITH") || isWord(nodes[index], "RECURSIVE"))) {
      keywords.push(nodes[index] as Tok);
      index += 1;
    }
    keywords.forEach((keyword, at) => {
      writer.tok(keyword, this.text(keyword), at > 0);
    });
    const column = writer.column + 1;
    const saved = writer.indent;
    writer.indent = column;
    let first = true;
    for (;;) {
      const bodyAt = nodes.findIndex(
        (node, at) =>
          at > index && node.type === "group" && (isWord(nodes[at - 1], "AS") || isWord(nodes[at - 1], "MATERIALIZED")),
      );
      const body = nodes[bodyAt];
      if (body?.type !== "group") throw new Unsupported("a WITH without its query");
      const asAt = nodes.slice(index, bodyAt).findIndex((node) => isWord(node, "AS")) + index;
      if (asAt < index) throw new Unsupported("a common table expression without AS");
      this.inline(writer, nodes.slice(index, asAt), first, { spaceBeforeGroup: true });
      this.inline(writer, nodes.slice(asAt, bodyAt), true);
      writer.tok(body.open, this.text(body.open), true);
      this.#nested(writer, body.children);
      writer.tok(body.close, this.text(body.close), false);
      first = false;
      index = bodyAt + 1;
      const next = nodes[index];
      if (next?.type === "tok" && next.text === COMMA) {
        writer.tok(next, next.text, false);
        writer.newline(column);
        index += 1;
        continue;
      }
      break;
    }
    writer.indent = saved;
    if (index >= nodes.length) throw new Unsupported("a WITH without its main statement");
    writer.newline(base);
    this.statement(writer, nodes.slice(index), base);
  }

  /** A statement inside parentheses, laid out at the column after `(`. */
  #nested(writer: Writer, nodes: readonly Node[]): void {
    const saved = writer.indent;
    const column = writer.column;
    writer.indent = column;
    this.statement(writer, nodes, column);
    writer.indent = saved;
  }

  setQuery(writer: Writer, nodes: readonly Node[], base: number): void {
    const parts: Node[][] = [[]];
    const operators: Tok[][] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined) continue;
      if (node.type === "tok" && node.keyword && SET_OPERATORS.has(node.upper)) {
        const operator = [node];
        const quantifier = nodes[index + 1];
        if (quantifier?.type === "tok" && quantifier.keyword && SET_QUANTIFIERS.has(quantifier.upper)) {
          operator.push(quantifier);
          index += 1;
        }
        operators.push(operator);
        parts.push([]);
        continue;
      }
      parts[parts.length - 1]?.push(node);
    }
    parts.forEach((part, at) => {
      const operator = operators[at - 1];
      if (operator !== undefined) {
        writer.newline(base);
        operator.forEach((tok, position) => {
          writer.tok(tok, this.text(tok), position > 0);
        });
        writer.newline(base);
      }
      this.select(writer, part, base);
    });
  }

  select(writer: Writer, nodes: readonly Node[], base: number): void {
    const first = nodes[0];
    if (first === undefined) throw new Unsupported("an empty query");
    let rest = nodes;
    let started = false;
    if (first.type === "group") {
      if (!isQueryStart(first.children)) throw new Unsupported("a parenthesised query of no SELECT");
      writer.tok(first.open, first.open.text, false);
      this.#nested(writer, first.children);
      writer.tok(first.close, first.close.text, false);
      rest = nodes.slice(1);
      started = true;
    } else if (!isWord(first, "SELECT")) {
      throw new Unsupported("a query that does not start with SELECT");
    }
    const { head, clauses } = splitClauses(rest, selectClauses);
    if (head.length > 0) throw new Unsupported("tokens before the first clause");
    clauses.forEach((clause, at) => {
      if (at > 0 || started) writer.newline(base);
      writer.indent = base;
      this.clause(writer, clause);
    });
  }

  clause(writer: Writer, clause: Clause): void {
    switch (clause.name) {
      case "SELECT":
        this.selectClause(writer, clause);
        return;
      case "FROM":
      case "UPDATE":
        this.#keywords(writer, clause.keywords);
        this.fromItems(writer, clause.body, writer.column + 1);
        return;
      case "WHERE":
      case "HAVING":
        this.#keywords(writer, clause.keywords);
        this.conditions(writer, clause.body, writer.column - this.#width(clause.keywords), writer.column);
        return;
      case "SET":
        this.#keywords(writer, clause.keywords);
        this.assignments(writer, clause.body, writer.column + 1);
        return;
      default:
        this.#keywords(writer, clause.keywords);
        this.#inlineBody(writer, clause.body);
    }
  }

  #keywords(writer: Writer, keywords: readonly Tok[], leadSpace = false): void {
    keywords.forEach((keyword, at) => {
      writer.tok(keyword, this.text(keyword), at > 0 || leadSpace);
    });
  }

  /** The width of `keywords` written on one line. */
  #width(keywords: readonly Tok[]): number {
    return keywords.map((keyword) => this.text(keyword)).join(" ").length;
  }

  #inlineBody(writer: Writer, body: readonly Node[]): void {
    const saved = writer.indent;
    writer.indent = writer.column + 1;
    this.inline(writer, body, true);
    writer.indent = saved;
  }

  selectClause(writer: Writer, clause: Clause): void {
    const keywords = [...clause.keywords];
    let index = 0;
    for (; index < clause.body.length; index += 1) {
      const node = clause.body[index];
      if (node?.type !== "tok" || !node.keyword || !SELECT_MODIFIERS.has(node.upper)) break;
      keywords.push(node);
      if (node.upper === "DISTINCT" && isWord(clause.body[index + 1], "ON")) {
        keywords.push(clause.body[index + 1] as Tok);
        index += 1;
      }
    }
    this.#keywords(writer, keywords);
    const distinctOn = clause.body[index];
    if (isWord(clause.body[index - 1], "ON") && distinctOn?.type === "group") {
      this.node(writer, distinctOn, true);
      index += 1;
    }
    this.selectList(writer, clause.body.slice(index), writer.column + 1);
  }

  /** One item per line under the first; aliases after `AS` line up (rule 5). */
  selectList(writer: Writer, nodes: readonly Node[], column: number): void {
    const { parts, commas } = splitTop(nodes, COMMA);
    const items = parts.map((part) => {
      const as = part[part.length - 2];
      const name = part[part.length - 1];
      const aliased = part.length >= 3 && isWord(as, "AS") && name?.type === "tok" && name.kind !== "symbol";
      const expression = aliased ? part.slice(0, -2) : part;
      const width = aliased ? this.#singleLineWidth(column, expression) : null;
      return { part, expression, alias: aliased ? part.slice(-2) : [], width };
    });
    const target = this.#alignment(items.map((item) => item.width));
    const saved = writer.indent;
    writer.indent = column;
    items.forEach((item, at) => {
      if (at > 0) writer.newline(column);
      this.inline(writer, item.expression, at === 0);
      if (item.alias.length > 0) {
        if (target !== null && item.width !== null) writer.pad(target - item.width);
        this.inline(writer, item.alias, true);
      }
      const comma = commas[at];
      if (comma !== undefined) writer.tok(comma, comma.text, false);
    });
    writer.indent = saved;
  }

  /** The width every aligned item pads to, or null when nothing aligns. */
  #alignment(widths: readonly (number | null)[]): number | null {
    if (!this.options.alignAliases) return null;
    const aligned = widths.filter((width): width is number => width !== null);
    return aligned.length === 0 ? null : Math.max(...aligned);
  }

  /** The width of `nodes` written inline at `column`, or null when that spans lines or passes the limit. */
  #singleLineWidth(column: number, nodes: readonly Node[]): number | null {
    const measured = this.measure(column, (scratch) => {
      this.inline(scratch, nodes, false);
    });
    return measured.multiline || measured.width > ALIAS_ALIGN_LIMIT ? null : measured.width;
  }

  measure(column: number, render: (writer: Writer) => void): { width: number; multiline: boolean } {
    const scratch = new Writer(column);
    render(scratch);
    return {
      width: scratch.out.length,
      multiline: scratch.out.includes("\n") || scratch.endsInLineComment,
    };
  }

  /** `SET a = 1,` with each further assignment under the first and the `=` lined up like aliases. */
  assignments(writer: Writer, nodes: readonly Node[], column: number): void {
    const { parts, commas } = splitTop(nodes, COMMA);
    const items = parts.map((part) => {
      const equals = part.findIndex((node) => node.type === "tok" && node.text === EQUALS);
      const target = equals > 0 ? part.slice(0, equals) : part;
      return {
        target,
        rest: equals > 0 ? part.slice(equals) : [],
        width: equals > 0 ? this.#singleLineWidth(column, target) : null,
      };
    });
    const target = this.#alignment(items.map((item) => item.width));
    const saved = writer.indent;
    writer.indent = column;
    items.forEach((item, at) => {
      if (at > 0) writer.newline(column);
      this.inline(writer, item.target, at === 0);
      if (item.rest.length > 0) {
        if (target !== null && item.width !== null) writer.pad(target - item.width);
        this.inline(writer, item.rest, true);
      }
      const comma = commas[at];
      if (comma !== undefined) writer.tok(comma, comma.text, false);
    });
    writer.indent = saved;
  }

  /** Tables one per line under the first; each join on its own line at the same column (rules 7-8). */
  fromItems(writer: Writer, nodes: readonly Node[], column: number): void {
    const { parts, commas } = splitTop(nodes, COMMA);
    const saved = writer.indent;
    writer.indent = column;
    parts.forEach((part, at) => {
      if (at > 0) writer.newline(column);
      this.#fromItem(writer, part, column, at === 0);
      const comma = commas[at];
      if (comma !== undefined) writer.tok(comma, comma.text, false);
    });
    writer.indent = saved;
  }

  #fromItem(writer: Writer, nodes: readonly Node[], column: number, leadSpace: boolean): void {
    const starts: number[] = [];
    nodes.forEach((node, at) => {
      if (node.type !== "tok" || !node.keyword || !JOIN_WORDS.has(node.upper)) return;
      let start = at;
      while (start > 0 && JOIN_MODIFIERS.has(keywordAt(nodes, start - 1))) start -= 1;
      starts.push(start);
    });
    const bounds = [0, ...starts, nodes.length];
    for (let segment = 0; segment + 1 < bounds.length; segment += 1) {
      const part = nodes.slice(bounds[segment], bounds[segment + 1]);
      if (part.length === 0) continue;
      if (segment === 0) {
        this.inline(writer, part, leadSpace);
        continue;
      }
      writer.newline(column);
      writer.indent = column;
      const on = part.findIndex((node) => isWord(node, "ON"));
      if (on < 0) {
        this.inline(writer, part, false);
        continue;
      }
      this.inline(writer, part.slice(0, on + 1), false);
      const keyword = part[on] as Tok;
      this.conditions(writer, part.slice(on + 1), writer.column - this.text(keyword).length, writer.column);
    }
  }

  /**
   * The first condition on the keyword's line, each further `AND` / `OR` on its own line ending
   * where the keyword ends, or starting under it when the keyword is shorter (rule 9).
   */
  conditions(writer: Writer, nodes: readonly Node[], keywordStart: number, keywordEnd: number): void {
    const saved = writer.indent;
    splitConditions(nodes).forEach((condition) => {
      let anchor = keywordStart;
      if (condition.operator !== null) {
        const text = this.text(condition.operator);
        anchor = Math.max(keywordStart, keywordEnd - text.length);
        writer.newline(anchor);
        writer.tok(condition.operator, text, false);
      }
      writer.indent = writer.column + 1;
      this.condition(writer, condition.nodes, anchor, true);
    });
    writer.indent = saved;
  }

  /** A parenthesised group of conditions too wide for its line opens one condition per line (rule 10). */
  condition(writer: Writer, nodes: readonly Node[], anchor: number, leadSpace: boolean): void {
    const group = nodes[nodes.length - 1];
    const prefix = nodes.slice(0, -1);
    const expandable =
      group?.type === "group" &&
      !isSubquery(group) &&
      prefix.every((node) => isWord(node, "NOT")) &&
      splitConditions(group.children).length > 1;
    if (!expandable) {
      this.inline(writer, nodes, leadSpace);
      return;
    }
    const start = writer.column + (leadSpace ? 1 : 0);
    const measured = this.measure(start, (scratch) => {
      this.inline(scratch, nodes, false);
    });
    if (!measured.multiline && start + measured.width <= RIGHT_MARGIN) {
      this.inline(writer, nodes, leadSpace);
      return;
    }
    this.inline(writer, prefix, leadSpace);
    writer.tok(group.open, group.open.text, prefix.length > 0 || leadSpace);
    const inner = anchor + this.options.indentWidth;
    const saved = writer.indent;
    const parts = splitConditions(group.children);
    parts.forEach((part, at) => {
      writer.newline(inner);
      writer.indent = inner;
      this.condition(writer, part.nodes, inner, false);
      const next = parts[at + 1]?.operator ?? null;
      if (next !== null) writer.tok(next, this.text(next), true);
    });
    writer.tok(group.close, group.close.text, false);
    writer.indent = saved;
  }

  insert(writer: Writer, nodes: readonly Node[], base: number): void {
    let index = 0;
    const headEnd = nodes.findIndex(
      (node, at) =>
        at > 0 &&
        ((node.type === "tok" &&
          node.kind === "word" &&
          (node.upper === "VALUES" ||
            node.upper === "VALUE" ||
            isWord(node, "SET") ||
            isWord(node, "SELECT") ||
            isWord(node, "WITH") ||
            (isWord(node, "DEFAULT") && spells(nodes[at + 1], "VALUES")))) ||
          (node.type === "group" && isSubquery(node))),
    );
    const end = headEnd < 0 ? nodes.length : headEnd;
    const verb = nodes[0] as Tok;
    verb.keyword = true;
    this.inline(writer, nodes.slice(0, end), false, { spaceBeforeGroup: true });
    index = end;
    if (index >= nodes.length) return;
    const tailAt = nodes.findIndex(
      (node, at) =>
        at > index &&
        (isWord(node, "RETURNING") ||
          (isWord(node, "ON") && (spells(nodes[at + 1], "DUPLICATE") || spells(nodes[at + 1], "CONFLICT")))),
    );
    const bodyEnd = tailAt < 0 ? nodes.length : tailAt;
    const body = nodes.slice(index, bodyEnd);
    writer.newline(base);
    writer.indent = base;
    const first = body[0];
    if (first?.type === "tok" && (first.upper === "VALUES" || first.upper === "VALUE")) {
      first.keyword = true;
      writer.tok(first, this.text(first), false);
      this.#rows(writer, body.slice(1), writer.column + 1);
    } else if (isWord(first, "SET")) {
      writer.tok(first, this.text(first), false);
      this.assignments(writer, body.slice(1), writer.column + 1);
    } else if (isWord(first, "DEFAULT")) {
      for (const node of body) if (node.type === "tok") node.keyword = true;
      this.inline(writer, body, false);
    } else {
      this.statement(writer, body, base);
    }
    if (tailAt >= 0) this.#insertTail(writer, nodes.slice(tailAt), base);
  }

  #insertTail(writer: Writer, nodes: readonly Node[], base: number): void {
    const returning = nodes.findIndex((node, at) => at > 0 && isWord(node, "RETURNING"));
    const clauses = returning < 0 ? [nodes] : [nodes.slice(0, returning), nodes.slice(returning)];
    for (const clause of clauses) {
      writer.newline(base);
      writer.indent = base;
      if (isWord(clause[0], "ON") && spells(clause[1], "DUPLICATE")) {
        const keywords = clause.slice(0, 4) as Tok[];
        if (!keywords.every((node) => node.type === "tok") || !spells(clause[3], "UPDATE")) {
          throw new Unsupported("an ON DUPLICATE KEY without UPDATE");
        }
        for (const keyword of keywords) keyword.keyword = true;
        this.#keywords(writer, keywords);
        this.assignments(writer, clause.slice(4), writer.column + 1);
      } else {
        this.inline(writer, clause, false);
      }
    }
  }

  #rows(writer: Writer, nodes: readonly Node[], column: number, leadSpace = true): void {
    const { parts, commas } = splitTop(nodes, COMMA);
    const saved = writer.indent;
    writer.indent = column;
    parts.forEach((part, at) => {
      if (at > 0) writer.newline(column);
      this.inline(writer, part, at === 0 && leadSpace);
      const comma = commas[at];
      if (comma !== undefined) writer.tok(comma, comma.text, false);
    });
    writer.indent = saved;
  }

  update(writer: Writer, nodes: readonly Node[], base: number): void {
    const { head, clauses } = splitClauses(nodes, updateClauses);
    if (head.length > 0) throw new Unsupported("tokens before UPDATE");
    clauses.forEach((clause, at) => {
      if (at > 0) writer.newline(base);
      writer.indent = base;
      this.clause(writer, clause);
    });
  }

  delete(writer: Writer, nodes: readonly Node[], base: number): void {
    const { head, clauses } = splitClauses(nodes, deleteClauses);
    if (head.length > 0) throw new Unsupported("tokens before DELETE");
    const [verb, from] = clauses;
    const sameLine =
      from?.name === "FROM" &&
      (verb?.body.every((node) => node.type === "tok" && node.kind === "word" && DELETE_MODIFIERS.has(node.upper)) ??
        false);
    clauses.forEach((clause, at) => {
      if (at === 1 && sameLine) {
        this.#keywords(writer, clause.keywords, true);
        this.fromItems(writer, clause.body, writer.column + 1);
        return;
      }
      if (at > 0) writer.newline(base);
      writer.indent = base;
      this.clause(writer, clause);
    });
  }

  inline(writer: Writer, nodes: readonly Node[], leadSpace: boolean, options: InlineOptions = {}): void {
    let previous: Node | null = null;
    for (const node of nodes) {
      const space = previous === null ? leadSpace : this.#spaceBetween(previous, node, options);
      if (isWord(previous ?? undefined, "IN") && node.type === "group" && options.preserve !== true) {
        this.#inList(writer, node, space);
      } else {
        this.node(writer, node, space, options);
      }
      previous = node;
    }
  }

  node(writer: Writer, node: Node, space: boolean, options: InlineOptions = {}): void {
    if (node.type === "tok") writer.tok(node, this.text(node), space);
    else if (node.type === "group") this.#group(writer, node, space, options);
    else this.#case(writer, node, space);
  }

  #group(writer: Writer, group: Group, space: boolean, options: InlineOptions): void {
    writer.tok(group.open, group.open.text, space);
    if (isSubquery(group) && options.preserve !== true) {
      this.#nested(writer, group.children);
    } else {
      this.inline(writer, group.children, false, { preserve: options.preserve ?? false });
    }
    writer.tok(group.close, group.close.text, false);
  }

  /** Two or more values after `IN` go one per line under the first, whatever the width (decision 147). */
  #inList(writer: Writer, group: Group, space: boolean): void {
    if (isSubquery(group) || splitTop(group.children, COMMA).parts.length < 2) {
      this.#group(writer, group, space, {});
      return;
    }
    writer.tok(group.open, group.open.text, space);
    this.#rows(writer, group.children, writer.column, false);
    writer.tok(group.close, group.close.text, false);
  }

  /** Inline when it fits `CASE_INLINE_LIMIT`; else `WHEN` / `ELSE` one per line under `CASE`, `END` at its column (rule 14). */
  #case(writer: Writer, node: CaseNode, space: boolean): void {
    const start = writer.column + (space ? 1 : 0);
    const measured = this.measure(start, (scratch) => {
      this.#caseInline(scratch, node, false);
    });
    if (!measured.multiline && measured.width <= CASE_INLINE_LIMIT) {
      this.#caseInline(writer, node, space);
      return;
    }
    const headText = this.text(node.head);
    writer.tok(node.head, headText, space);
    const column = writer.column - headText.length;
    const branches: Node[][] = [[]];
    for (const child of node.children) {
      if (isWord(child, "WHEN") || isWord(child, "ELSE")) branches.push([]);
      branches[branches.length - 1]?.push(child);
    }
    const [operand = [], ...rest] = branches;
    this.inline(writer, operand, true);
    const saved = writer.indent;
    const inner = column + this.options.indentWidth;
    for (const branch of rest) {
      writer.newline(inner);
      writer.indent = inner;
      this.inline(writer, branch, false);
    }
    writer.newline(column);
    writer.indent = saved;
    writer.tok(node.end, this.text(node.end), false);
  }

  #caseInline(writer: Writer, node: CaseNode, space: boolean): void {
    writer.tok(node.head, this.text(node.head), space);
    this.inline(writer, node.children, true);
    writer.tok(node.end, this.text(node.end), true);
  }

  #spaceBetween(previous: Node, current: Node, options: InlineOptions): boolean {
    const before = lastTok(previous);
    const after = firstTok(current);
    if (options.preserve === true) return after.spaced;
    if (after.text === COMMA) return false;
    if (before.text === COMMA) return true;
    if (before.text === CAST || after.text === CAST) return false;
    if (current.type === "group") {
      if (before.kind === "word") {
        if (before.keyword) return true;
        return options.spaceBeforeGroup === true && previous.type === "tok";
      }
      if (before.kind === "quoted" && options.spaceBeforeGroup === true) return true;
      if (isSpacedOperator(before)) return true;
      return after.spaced;
    }
    if (isSpacedOperator(before) || isSpacedOperator(after)) return true;
    if (before.kind === "word" && after.kind === "word") return true;
    if (previous.type !== "tok" && after.kind === "word") return true;
    return after.spaced;
  }
}
