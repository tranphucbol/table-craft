import { PluginError, type ExplainedPlan, type PlanNode, type PlanProperty } from "@table-craft/plugin-api";
import { planPropertyValue } from "@table-craft/plugin-api/sql";

/** What MySQL 8.4's EXPLAIN accepts; `DESCRIBE` and `CREATE TABLE … AS` are syntax errors there. */
export const EXPLAIN_VERBS = ["SELECT", "TABLE", "VALUES", "INSERT", "REPLACE", "UPDATE", "DELETE"];
/** `EXPLAIN ANALYZE` times the iterator executor, which runs queries only (decision 031). */
export const ANALYZE_VERBS = ["SELECT", "TABLE"];
/**
 * MySQL 8.4 accepts `FORMAT=TREE` for these but prints only `<not executable by iterator executor>`
 * for a single-table one, so they are explained as JSON.
 */
const JSON_VERBS = new Set(["UPDATE", "DELETE"]);

/**
 * `table` is TiDB's own: it has neither `FORMAT=TREE` nor MySQL's JSON, and prints its plan as
 * rows of a table whose first column draws the tree.
 */
export type PlanFormat = "tree" | "json" | "table";

export function planFormat(verb: string, tidb: boolean): PlanFormat {
  if (tidb) return "table";
  return JSON_VERBS.has(verb) ? "json" : "tree";
}

export function explainStatement(sql: string, analyze: boolean, format: PlanFormat): string {
  if (format === "json") return `EXPLAIN FORMAT=JSON ${sql}`;
  if (format === "table") return analyze ? `EXPLAIN ANALYZE ${sql}` : `EXPLAIN ${sql}`;
  return analyze ? `EXPLAIN ANALYZE FORMAT=TREE ${sql}` : `EXPLAIN FORMAT=TREE ${sql}`;
}

const NODE_LINE = /^( *)-> (.*)$/;
const INDENT = 4;
/** `(cost=0.9 rows=1)`; the cost is a range `0..0` on some steps, whose end is the total. */
const COST = /\s*\(cost=(\S+?)(?: rows=(\S+?))?\)/;
/** `(actual time=0.174..0.193 rows=2 loops=1)`, times in milliseconds, first row then last. */
const ACTUAL = /\s*\(actual time=(\S+?)\.\.(\S+?) rows=(\S+?) loops=(\S+?)\)/;
const NEVER_EXECUTED = /\s*\(never executed\)/;
const RANGE = "..";
const DETAIL_SEPARATOR = ": ";

function number(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number(text.split(RANGE).at(-1));
  return Number.isFinite(value) ? value : null;
}

interface Building {
  readonly depth: number;
  node: Mutable;
}

type Mutable = { -readonly [K in keyof PlanNode]: K extends "children" ? Mutable[] : PlanNode[K] };

function treeNode(line: string): Mutable {
  const cost = COST.exec(line);
  const actual = ACTUAL.exec(line);
  const never = NEVER_EXECUTED.test(line);
  const text = line.replace(COST, "").replace(ACTUAL, "").replace(NEVER_EXECUTED, "").trim();
  const split = text.indexOf(DETAIL_SEPARATOR);
  return {
    operation: split < 0 ? text : text.slice(0, split),
    target: null,
    detail: split < 0 ? null : text.slice(split + DETAIL_SEPARATOR.length),
    estimatedRows: number(cost?.[2]),
    estimatedCost: number(cost?.[1]),
    actualRows: never ? 0 : number(actual?.[3]),
    actualTimeMs: number(actual?.[2]),
    loops: never ? 0 : number(actual?.[4]),
    properties: [],
    children: [],
  };
}

/** Reads `FORMAT=TREE`: one step per `->` line, nested by its indent of four spaces a level. */
export function readTree(raw: string, statement: string, analyzed: boolean): ExplainedPlan {
  const roots: Mutable[] = [];
  const open: Building[] = [];
  let last: Mutable | null = null;
  for (const line of raw.split("\n")) {
    const match = NODE_LINE.exec(line);
    if (match === null) {
      // A step's text that wrapped onto its own line belongs to the step above it.
      if (last !== null && line.trim() !== "") last.detail = [last.detail, line.trim()].filter(Boolean).join(" ");
      continue;
    }
    const depth = Math.floor((match[1] ?? "").length / INDENT);
    const node = treeNode(match[2] ?? "");
    while (open.length > 0 && (open.at(-1)?.depth ?? 0) >= depth) open.pop();
    const parent = open.at(-1);
    if (parent === undefined) roots.push(node);
    else parent.node.children.push(node);
    open.push({ depth, node });
    last = node;
  }
  return { statement, analyzed, roots, summary: [], raw };
}

const CELL_SEPARATOR = "\t";
const LINE_BREAK = "\n";
/** The tree TiDB draws in front of a step's id, two characters a level: `└─`, `├─`, `│ ` or spaces. */
const TREE_PREFIX = /^[\s│├└─]*/u;
/** `IndexRangeScan_5(Build)`: the step's id, then the side of a join or lookup it feeds. */
const STEP_ID = /^(.*?)(?:\((Build|Probe)\))?$/;
const TREE_LEVEL = 2;
/** TiDB 4 calls the estimate `estRows`; TiDB 3 called it `count`. */
const ESTIMATE_COLUMNS = ["estRows", "count"];
const TIDB_MAPPED = new Set(["id", ...ESTIMATE_COLUMNS, "actRows", "access object", "operator info"]);
/** What TiDB prints in a cell it has nothing for. */
const NOTHING = new Set(["", "N/A"]);
/** `time:1.21ms` at the start of `execution info`, the step's wall time over all its loops. */
const EXECUTION_TIME = /(?:^|,\s*)time:\s*([\d.]+)(ns|µs|us|ms|s)\b/;
const MILLISECONDS_PER: Readonly<Record<string, number>> = { ns: 1e-6, µs: 1e-3, us: 1e-3, ms: 1, s: 1e3 };

/** A TiDB plan's rows as `readTidbTable` reads them: a header line, then one line a step, cells tab-separated. */
export function tableText(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  return [columns, ...rows].map((cells) => cells.join(CELL_SEPARATOR)).join(LINE_BREAK);
}

function present(value: string | undefined): string | null {
  return value === undefined || NOTHING.has(value) ? null : value;
}

function executionTime(info: string | null): number | null {
  const match = info === null ? null : EXECUTION_TIME.exec(info);
  if (match === null) return null;
  return Number(match[1]) * (MILLISECONDS_PER[match[2] ?? ""] ?? Number.NaN);
}

function tidbNode(cells: ReadonlyMap<string, string>): { depth: number; node: Mutable } {
  const id = cells.get("id") ?? "";
  const prefix = TREE_PREFIX.exec(id)?.[0] ?? "";
  const step = STEP_ID.exec(id.slice(prefix.length));
  const role = step?.[2];
  const estimate = ESTIMATE_COLUMNS.map((name) => cells.get(name)).find((value) => value !== undefined);
  const executionInfo = present(cells.get("execution info"));
  const properties = [
    ...(role === undefined ? [] : [{ name: "role", value: role }]),
    ...[...cells].flatMap(([name, value]) =>
      TIDB_MAPPED.has(name) || present(value) === null ? [] : [{ name, value }],
    ),
  ];
  return {
    depth: Math.floor([...prefix].length / TREE_LEVEL),
    node: {
      operation: step?.[1] ?? id,
      target: present(cells.get("access object")),
      detail: present(cells.get("operator info")),
      estimatedRows: number(present(estimate) ?? undefined),
      estimatedCost: null,
      actualRows: number(present(cells.get("actRows")) ?? undefined),
      actualTimeMs: executionTime(executionInfo),
      loops: null,
      properties,
      children: [],
    },
  };
}

/** Reads TiDB's plan table, as `tableText` writes it: each step nested under the one its tree prefix hangs from. */
export function readTidbTable(raw: string, statement: string, analyzed: boolean): ExplainedPlan {
  const [header = "", ...lines] = raw.split(LINE_BREAK);
  const columns = header.split(CELL_SEPARATOR);
  const roots: Mutable[] = [];
  const open: Building[] = [];
  for (const line of lines) {
    if (line === "") continue;
    const values = line.split(CELL_SEPARATOR);
    const { depth, node } = tidbNode(new Map(columns.map((name, index) => [name, values[index] ?? ""])));
    while (open.length > 0 && (open.at(-1)?.depth ?? 0) >= depth) open.pop();
    const parent = open.at(-1);
    if (parent === undefined) roots.push(node);
    else parent.node.children.push(node);
    open.push({ depth, node });
  }
  return { statement, analyzed, roots, summary: [], raw };
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TABLE = "table";
const NESTED_LOOP = "nested_loop";
const COST_INFO = "cost_info";
/** The keys a table step has a `PlanNode` field for; the rest become properties. */
const TABLE_MAPPED = new Set([
  "table_name",
  "update",
  "delete",
  "access_type",
  "key",
  "rows_examined_per_scan",
  COST_INFO,
]);
const BLOCK_MAPPED = new Set([TABLE, NESTED_LOOP, COST_INFO, "select_id"]);

function properties(json: Json, skip: ReadonlySet<string>): PlanProperty[] {
  return Object.entries(json).flatMap(([name, value]) => {
    const shown = skip.has(name) ? null : planPropertyValue(value);
    return shown === null ? [] : [{ name, value: shown }];
  });
}

function costOf(json: Json, key: string): number | null {
  const info = json[COST_INFO];
  return isJson(info) ? number(planPropertyValue(info[key]) ?? undefined) : null;
}

function tableNode(table: Json): PlanNode {
  const access = planPropertyValue(table.access_type);
  const key = planPropertyValue(table.key);
  const operation = table.update === true ? "Update" : table.delete === true ? "Delete" : "Read";
  const detail = [access === null ? null : `${access} access`, key === null ? null : `using ${key}`]
    .filter((part) => part !== null)
    .join(" ");
  return {
    operation,
    target: planPropertyValue(table.table_name),
    detail: detail === "" ? null : detail,
    estimatedRows: number(planPropertyValue(table.rows_examined_per_scan) ?? undefined),
    estimatedCost: costOf(table, "prefix_cost"),
    actualRows: null,
    actualTimeMs: null,
    loops: null,
    properties: properties(table, TABLE_MAPPED),
    children: [],
  };
}

function blockNodes(block: Json): PlanNode[] {
  if (isJson(block[TABLE])) return [tableNode(block[TABLE])];
  const loop = block[NESTED_LOOP];
  if (Array.isArray(loop)) {
    const children = loop.flatMap((entry) => (isJson(entry) && isJson(entry[TABLE]) ? [tableNode(entry[TABLE])] : []));
    return [
      {
        operation: "Nested loop",
        target: null,
        detail: null,
        estimatedRows: null,
        estimatedCost: costOf(block, "query_cost"),
        actualRows: null,
        actualTimeMs: null,
        loops: null,
        properties: [],
        children,
      },
    ];
  }
  return [];
}

/** Reads `FORMAT=JSON` (version 1): the query block's tables, which is all an UPDATE or DELETE has. */
export function readJson(raw: string, statement: string): ExplainedPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new PluginError("statementFailed", "MySQL printed a plan that is not JSON; run the EXPLAIN with Run.", {
      cause,
    });
  }
  const block = isJson(parsed) && isJson(parsed.query_block) ? parsed.query_block : {};
  const cost = costOf(block, "query_cost");
  return {
    statement,
    analyzed: false,
    roots: blockNodes(block),
    summary: [
      ...(cost === null ? [] : [{ name: "Query cost", value: String(cost) }]),
      ...properties(block, BLOCK_MAPPED),
    ],
    raw,
  };
}
