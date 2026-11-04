import type { ExplainedPlan, PlanNode, PlanProperty, Row } from "@table-craft/plugin-api";
import { CREATE_TABLE_AS } from "@table-craft/plugin-api/sql";

/** What DuckDB's `EXPLAIN` plans; anything else answers an empty tree. */
export const EXPLAIN_VERBS = [
  "SELECT",
  "FROM",
  "WITH",
  "VALUES",
  "TABLE",
  "PIVOT",
  "UNPIVOT",
  "INSERT",
  "UPDATE",
  "DELETE",
  CREATE_TABLE_AS,
];

export function explainStatement(sql: string, analyze: boolean): string {
  return analyze ? `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}` : `EXPLAIN (FORMAT JSON) ${sql}`;
}

/** `EXPLAIN` answers `explain_key, explain_value`; the JSON is in the value. */
const VALUE = 1;
const ESTIMATED_CARDINALITY = "Estimated Cardinality";
/** The scan's relation, in the order DuckDB's operators name it. */
const TARGET_KEYS = ["Table", "Function", "Text"];
/** `EXPLAIN ANALYZE` wraps the plan in these, which say nothing about the statement; `EXECUTE` when it had parameters. */
const ANALYZE_WRAPPERS = new Set(["RESULT_COLLECTOR", "EXPLAIN_ANALYZE", "EXECUTE"]);
/** DuckDB profiles each operator once, its rows and time totalled over the whole run. */
const ANALYZED_LOOPS = 1;
const MS_PER_SECOND = 1_000;

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join(", ");
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The plan's text; `EXPLAIN ANALYZE` types its column `JSON`, which arrives as the `json` kind. */
function cellText(value: unknown): string {
  if (isObject(value) && value.kind === "json" && typeof value.text === "string") return value.text;
  return typeof value === "string" ? value : "";
}

function numberOr(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function node(json: JsonObject, analyzed: boolean): PlanNode {
  const extra = isObject(json.extra_info) ? json.extra_info : {};
  const targetKey = TARGET_KEYS.find((key) => typeof extra[key] === "string");
  const properties: PlanProperty[] = Object.entries(extra)
    .filter(([name]) => name !== ESTIMATED_CARDINALITY && name !== targetKey)
    .map(([name, value]) => ({ name, value: text(value) }));
  const children = Array.isArray(json.children) ? json.children.filter(isObject) : [];
  const timing = numberOr(json.timing);
  return {
    operation: text(json.name ?? json.type ?? ""),
    target: targetKey === undefined ? null : text(extra[targetKey]),
    detail: null,
    estimatedRows: numberOr(extra[ESTIMATED_CARDINALITY]),
    estimatedCost: null,
    actualRows: analyzed ? numberOr(json.operator_cardinality ?? json.intermediate_rows) : null,
    actualTimeMs: analyzed && timing !== null ? timing * MS_PER_SECOND : null,
    loops: analyzed ? ANALYZED_LOOPS : null,
    properties,
    children: children.map((child) => node(child, analyzed)),
  };
}

function unwrapped(roots: readonly JsonObject[]): readonly JsonObject[] {
  const [only] = roots;
  if (roots.length !== 1 || only === undefined || !ANALYZE_WRAPPERS.has(text(only.type))) return roots;
  return unwrapped(Array.isArray(only.children) ? only.children.filter(isObject) : []);
}

function summaryOf(json: JsonObject): PlanProperty[] {
  const query = isObject(json.query) ? json.query : {};
  const summary: PlanProperty[] = [];
  const total = numberOr(query.total_time ?? json.latency);
  if (total !== null) summary.push({ name: "Execution Time", value: `${(total * MS_PER_SECOND).toFixed(3)} ms` });
  const scanned = numberOr(query.total_rows_scanned ?? json.cumulative_rows_scanned);
  if (scanned !== null) summary.push({ name: "Rows Scanned", value: String(scanned) });
  return summary;
}

/**
 * Reads `EXPLAIN (FORMAT JSON)`, an array of operator trees, or `EXPLAIN (ANALYZE, FORMAT JSON)`,
 * one profile whose `operator` (DuckDB 2) or `children` (DuckDB 1) holds the tree.
 */
export function readPlanRows(rows: readonly Row[], statement: string, analyzed: boolean): ExplainedPlan {
  const raw = rows.map((row) => cellText(row[VALUE])).join("\n");
  const parsed: unknown = raw === "" ? [] : JSON.parse(raw);
  if (Array.isArray(parsed)) {
    const roots = parsed.filter(isObject).map((json) => node(json, analyzed));
    return { statement, analyzed, roots, summary: [], raw };
  }
  const profile = isObject(parsed) ? parsed : {};
  const operators = Array.isArray(profile.operator) ? profile.operator : profile.children;
  const trees = Array.isArray(operators) ? operators.filter(isObject) : [];
  return {
    statement,
    analyzed,
    roots: unwrapped(trees).map((json) => node(json, analyzed)),
    summary: summaryOf(profile),
    raw,
  };
}
