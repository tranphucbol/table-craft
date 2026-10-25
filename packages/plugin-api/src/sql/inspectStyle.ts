import type { Problem, QuickFix } from "@table-craft/plugin-api";
import { problem, removal, type StatementInspection, type StatementView } from "./inspectContext.js";
import { referenceName } from "./resolution.js";
import { CLAUSE_WORDS, NO_GROUP, unquote, type Identifier, type Query } from "./scope.js";

const OPEN = "(";
const CLOSE = ")";
const COMMA = ",";
const WHERE = "WHERE";
const NULL = "NULL";
const AND = "AND";
const OR = "OR";
const ON = "ON";
const BETWEEN = "BETWEEN";
const TRUE = "TRUE";
const FALSE = "FALSE";
const ASC = "ASC";
const ELSE = "ELSE";
const END = "END";
const AS = "AS";
const WITH = "WITH";
const ROW = "ROW";
const VALUES_WORDS = new Set(["VALUES", "VALUE"]);
const RECURSIVE = "RECURSIVE";
const CTE_MODIFIERS = new Set(["NOT", "MATERIALIZED"]);
const ORDER_BY = "ORDER BY";
const UNFILTERED_VERBS = new Set(["DELETE", "UPDATE"]);
/** Clauses `WHERE` must come before, so its placeholder goes ahead of them. */
const AFTER_WHERE = new Set(["ORDER", "LIMIT", "RETURNING"]);
const CONDITION_CLAUSES = new Set([WHERE, ON, "HAVING"]);
const NULL_COMPARISON_CLAUSES = new Set([...CONDITION_CLAUSES, "SELECT"]);
const COMPARISONS = new Set(["=", "<>", "!=", "<", ">", "<=", ">="]);
const OPERATOR_CHARACTER = /^[<>=!]$/;
/** Join words that end an `ON` condition without being clause keywords. */
const JOIN_WORDS = new Set(["INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "OUTER"]);
const NUMBER = /^[0-9]+(?:\.[0-9]*)?$/;
const WHERE_PLACEHOLDER = "WHERE ";

/** `INSERT INTO t (a, b) VALUES (1)`: each row against the column list (SqlInsertValues). */
function insertValues(view: StatementView, query: Query): Problem[] {
  if (query.insert === null) return [];
  const { statement } = view;
  const listOpen = view.indexAt(query.insert.from - 1);
  const expected = itemCount(view, listOpen);
  const level = statement.level(view.queries.get(query) ?? NO_GROUP);
  const start = level.indexOf(listOpen) + 1;
  if (start === 0 || !VALUES_WORDS.has(view.word(level[start] ?? -1) ?? "")) return [];
  const problems: Problem[] = [];
  for (let at = start + 1; at < level.length; at += 1) {
    let index = level[at] ?? -1;
    if (view.word(index) === ROW) index = level[++at] ?? -1;
    if (!view.isSymbol(index, OPEN)) break;
    const openToken = view.token(index);
    const closeToken = view.token(statement.closeOf(index));
    const found = itemCount(view, index);
    if (openToken !== undefined && closeToken !== undefined && found !== expected) {
      const noun = expected === 1 ? "value" : "values";
      problems.push(
        problem(
          "SqlInsertValues",
          "error",
          { from: openToken.from, to: closeToken.to },
          `Expected ${String(expected)} ${noun}, found ${String(found)}`,
        ),
      );
    }
    if (!view.isSymbol(level[at + 1] ?? -1, COMMA)) break;
    at += 1;
  }
  return problems;
}

function itemCount(view: StatementView, open: number): number {
  const inside = view.statement.level(open);
  if (inside.length === 0) return 0;
  return inside.filter((index) => view.isSymbol(index, COMMA)).length + 1;
}

/** `DELETE` or `UPDATE` with no `WHERE` at the statement's own level (SqlWithoutWhere). */
function withoutWhere(view: StatementView): Problem[] {
  const verb = view.verb;
  if (verb === null || !UNFILTERED_VERBS.has(verb) || !view.inspected) return [];
  const level = view.statement.level(NO_GROUP);
  const verbIndex = level.find((index) => view.word(index) === verb);
  const verbToken = verbIndex === undefined ? undefined : view.token(verbIndex);
  if (verbIndex === undefined || verbToken === undefined) return [];
  const after = level.filter((index) => index > verbIndex);
  if (after.some((index) => view.word(index) === WHERE)) return [];
  const before = after.find((index) => AFTER_WHERE.has(view.word(index) ?? ""));
  const beforeToken = before === undefined ? undefined : view.token(before);
  const fix: QuickFix =
    beforeToken === undefined
      ? {
          title: "Add WHERE clause",
          edits: [{ from: view.end, to: view.end, insert: ` ${WHERE_PLACEHOLDER}` }],
          caret: view.end + WHERE_PLACEHOLDER.length + 1,
        }
      : {
          title: "Add WHERE clause",
          edits: [{ from: beforeToken.from, to: beforeToken.from, insert: `${WHERE_PLACEHOLDER} ` }],
          caret: beforeToken.from + WHERE_PLACEHOLDER.length,
        };
  return [problem("SqlWithoutWhere", "warning", verbToken, `${verb} without WHERE affects all rows`, [fix])];
}

function adjacent(view: StatementView, left: number, right: number): boolean {
  const a = view.token(left);
  const b = view.token(right);
  return a !== undefined && b !== undefined && a.to === b.from;
}

/** The comparison operator ending at `last`, as `{ first, operator }`; null for anything else. */
function operatorEndingAt(view: StatementView, last: number): { first: number; operator: string } | null {
  const token = view.token(last);
  if (token?.kind !== "symbol") return null;
  let first = last;
  while (first > 0 && OPERATOR_CHARACTER.test(view.raw(first - 1)) && adjacent(view, first - 1, first)) first -= 1;
  const start = view.token(first);
  if (start === undefined) return null;
  const operator = view.text.slice(start.from, token.to);
  return COMPARISONS.has(operator) ? { first, operator } : null;
}

/** `x = NULL` and `x <> NULL`, which are never true (SqlNullComparison). */
function nullComparisons(view: StatementView): Problem[] {
  const problems: Problem[] = [];
  view.tokens.forEach((token, index) => {
    const clause = view.places[index]?.clause ?? null;
    if (view.word(index) !== NULL || clause === null || !NULL_COMPARISON_CLAUSES.has(clause)) return;
    const found = operatorEndingAt(view, index - 1);
    const start = found === null ? undefined : view.token(found.first);
    if (
      found === null ||
      start === undefined ||
      (found.operator !== "=" && found.operator !== "<>" && found.operator !== "!=")
    )
      return;
    const test = found.operator === "=" ? "IS NULL" : "IS NOT NULL";
    const span = { from: start.from, to: token.to };
    const fix: QuickFix = { title: `Replace with ${test}`, edits: [{ from: span.from, to: span.to, insert: test }] };
    problems.push(
      problem("SqlNullComparison", "warning", span, `'${found.operator} NULL' is never true; use ${test}`, [fix]),
    );
  });
  return problems;
}

/** The token indices directly in a condition clause's body, a nested group standing as its `(`. */
function conditionBody(view: StatementView, keyword: number): number[] {
  const { statement } = view;
  const group = view.places[keyword]?.group ?? NO_GROUP;
  const body: number[] = [];
  for (let index = keyword + 1; index < view.tokens.length; index += 1) {
    if (view.places[index]?.group !== group) break;
    const word = view.word(index);
    if (word !== null && ((CLAUSE_WORDS.has(word) && word !== ON) || JOIN_WORDS.has(word))) break;
    if (view.isSymbol(index, CLOSE)) break;
    body.push(index);
    if (view.isSymbol(index, OPEN)) index = statement.closeOf(index);
  }
  return body;
}

/** A body split at its top-level `AND` and `OR`, a `BETWEEN`'s own `AND` kept in its operand. */
function conjuncts(view: StatementView, body: readonly number[]): number[][] {
  const parts: number[][] = [[]];
  let between = false;
  for (const index of body) {
    const word = view.word(index);
    if (word === BETWEEN) between = true;
    if ((word === AND && !between) || word === OR) {
      parts.push([]);
      continue;
    }
    if (word === AND) between = false;
    parts.at(-1)?.push(index);
  }
  return parts.filter((part) => part.length > 0);
}

function literalValue(view: StatementView, index: number): string | number | null {
  const token = view.token(index);
  const raw = view.raw(index);
  if (token?.kind === "string" && raw.startsWith("'")) return unquote(raw);
  if (token?.kind === "word" && NUMBER.test(raw)) return Number(raw);
  return null;
}

function compare(left: string | number, operator: string, right: string | number): boolean | null {
  if (typeof left !== typeof right) return null;
  switch (operator) {
    case "=":
      return left === right;
    case "<>":
    case "!=":
      return left !== right;
    case "<":
      return left < right;
    case ">":
      return left > right;
    case "<=":
      return left <= right;
    default:
      return left >= right;
  }
}

/** Whether a conjunct is a constant, and its value when one can be told: `TRUE`, `1 = 1`, `'a' <> 'b'`. */
function constantValue(view: StatementView, part: readonly number[]): boolean | null | undefined {
  const [first] = part;
  if (first === undefined) return undefined;
  if (part.length === 1) {
    const word = view.word(first);
    return word === TRUE ? true : word === FALSE ? false : undefined;
  }
  const last = part.at(-1) ?? first;
  const left = literalValue(view, first);
  const right = literalValue(view, last);
  const operator = operatorEndingAt(view, last - 1);
  if (left === null || right === null || operator === null || operator.first !== first + 1) return undefined;
  if (part.length !== last - first + 1) return undefined;
  return compare(left, operator.operator, right);
}

function constantFix(view: StatementView, keyword: number, part: readonly number[]): QuickFix | null {
  const first = part[0];
  const last = part.at(-1);
  if (first === undefined || last === undefined) return null;
  const before = view.word(first - 1);
  const after = view.word(last + 1);
  if (before === OR || after === OR) return null;
  if (before === AND) return removal("Remove condition", view.withLeadingSpace(first - 1, last));
  const next = view.token(last + 2);
  if (after === AND && next !== undefined) {
    return removal("Remove condition", { from: view.token(first)?.from ?? 0, to: next.from });
  }
  if (view.word(keyword) === ON) return null;
  return removal("Remove condition", view.withLeadingSpace(keyword, last));
}

/** `WHERE 1 = 1`, `WHERE TRUE` and other literal-only conditions (SqlConstantCondition). */
function constantConditions(view: StatementView): Problem[] {
  const problems: Problem[] = [];
  view.tokens.forEach((_, keyword) => {
    const word = view.word(keyword);
    if (word === null || !CONDITION_CLAUSES.has(word)) return;
    for (const part of conjuncts(view, conditionBody(view, keyword))) {
      const value = constantValue(view, part);
      const start = view.token(part[0] ?? -1);
      const end = view.token(part.at(-1) ?? -1);
      if (value === undefined || start === undefined || end === undefined) continue;
      const text = view.text.slice(start.from, end.to);
      const message =
        value === null ? `Condition '${text}' is constant` : `Condition '${text}' is always ${String(value)}`;
      const fix = value === false ? null : constantFix(view, keyword, part);
      problems.push(
        problem(
          "SqlConstantCondition",
          "warning",
          { from: start.from, to: end.to },
          message,
          fix === null ? [] : [fix],
        ),
      );
    }
  });
  return problems;
}

/** The `)` of a CTE's body, given its name's token. */
function cteBodyClose(view: StatementView, nameIndex: number): number | null {
  let index = nameIndex + 1;
  if (view.isSymbol(index, OPEN)) index = view.statement.closeOf(index) + 1;
  if (view.word(index) === AS) index += 1;
  while (CTE_MODIFIERS.has(view.word(index) ?? "")) index += 1;
  if (!view.isSymbol(index, OPEN)) return null;
  const close = view.statement.closeOf(index);
  return view.token(close) === undefined ? null : close;
}

function identifierAt(view: StatementView, index: number): Identifier | null {
  const token = view.token(index);
  if (token === undefined || (token.kind !== "word" && token.kind !== "quoted")) return null;
  const raw = view.raw(index);
  return {
    name: token.kind === "quoted" ? unquote(raw) : raw,
    quoted: token.kind === "quoted",
    from: token.from,
    to: token.to,
  };
}

function cteRemoval(view: StatementView, nameIndex: number, close: number): QuickFix | null {
  const closeToken = view.token(close);
  const nameToken = view.token(nameIndex);
  if (closeToken === undefined || nameToken === undefined) return null;
  const before = view.token(nameIndex - 1);
  if (view.isSymbol(nameIndex - 1, COMMA) && before !== undefined)
    return removal("Remove CTE", { from: before.from, to: closeToken.to });
  const following = view.token(close + 1);
  if (view.isSymbol(close + 1, COMMA)) {
    const next = view.token(close + 2);
    return next === undefined ? null : removal("Remove CTE", { from: nameToken.from, to: next.from });
  }
  const withIndex = view.word(nameIndex - 1) === RECURSIVE ? nameIndex - 2 : nameIndex - 1;
  const withToken = view.token(withIndex);
  if (view.word(withIndex) !== WITH || withToken === undefined || following === undefined) return null;
  return removal("Remove CTE", { from: withToken.from, to: following.from });
}

/** CTEs nothing outside their own body reads (SqlUnusedCte). */
function unusedCtes(view: StatementView): Problem[] {
  const problems: Problem[] = [];
  for (const query of view.queries.keys()) {
    for (const cte of query.ctes) {
      const nameIndex = view.indexAt(cte.name.from);
      const close = cteBodyClose(view, nameIndex);
      if (nameIndex < 0 || close === null) continue;
      const used = view.tokens.some((_, index) => {
        if (index >= nameIndex && index <= close) return false;
        const identifier = identifierAt(view, index);
        return identifier !== null && view.rules.sameIdentifier(identifier, cte.name);
      });
      if (used) continue;
      const fix = cteRemoval(view, nameIndex, close);
      problems.push(
        problem("SqlUnusedCte", "warning", cte.name, `CTE '${cte.name.name}' is never used`, fix === null ? [] : [fix]),
      );
    }
  }
  return problems;
}

/** Two sources one query refers to by the same name (SqlDuplicateAlias) and an alias equal to its table (SqlRedundantAlias). */
function aliases(view: StatementView): Problem[] {
  const problems: Problem[] = [];
  for (const query of view.queries.keys()) {
    const seen: Identifier[] = [];
    for (const source of query.sources) {
      if (source.kind === "relation") {
        const role = view.roleOf(source);
        if (role === "target" || role === "notRelation") continue;
        const alias = source.alias;
        if (alias !== null && view.rules.sameIdentifier(alias, source.name)) {
          const fix = removal("Remove alias", { from: source.name.to, to: alias.to });
          problems.push(problem("SqlRedundantAlias", "weak", alias, `Redundant alias '${alias.name}'`, [fix]));
        }
      }
      const reference = referenceName(source);
      if (reference === null) continue;
      if (seen.some((other) => view.rules.sameIdentifier(other, reference)))
        problems.push(problem("SqlDuplicateAlias", "error", reference, `Duplicate table alias '${reference.name}'`));
      seen.push(reference);
    }
  }
  return problems;
}

/** `ASC` in an `ORDER BY` (SqlRedundantOrderingDirection) and `ELSE NULL` before `END` (SqlRedundantElseNull). */
function redundantWords(view: StatementView): Problem[] {
  const problems: Problem[] = [];
  view.tokens.forEach((token, index) => {
    const word = view.word(index);
    if (word === ASC && view.places[index]?.clause === ORDER_BY) {
      const fix = removal("Remove ASC", view.withLeadingSpace(index));
      problems.push(problem("SqlRedundantOrderingDirection", "weak", token, "Redundant ordering direction", [fix]));
    }
    const nullToken = view.token(index + 1);
    if (word === ELSE && view.word(index + 1) === NULL && view.word(index + 2) === END && nullToken !== undefined) {
      const fix = removal("Remove ELSE NULL", view.withLeadingSpace(index, index + 1));
      problems.push(
        problem("SqlRedundantElseNull", "weak", { from: token.from, to: nullToken.to }, "Redundant ELSE NULL", [fix]),
      );
    }
  });
  return problems;
}

/** Every inspection here; each runs on an inspected statement only. */
export const STYLE_INSPECTIONS: readonly StatementInspection[] = [
  (view: StatementView) => [...view.queries.keys()].flatMap((query) => insertValues(view, query)),
  withoutWhere,
  nullComparisons,
  constantConditions,
  unusedCtes,
  aliases,
  redundantWords,
].map(
  (inspection): StatementInspection =>
    (view) =>
      view.inspected ? inspection(view) : [],
);
