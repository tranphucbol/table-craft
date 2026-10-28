import type { PlanNode, PlanProperty } from "@table-craft/plugin-api";
import { CREATE_TABLE_AS } from "@table-craft/plugin-api/sql";

/** What `EXPLAIN PLAN` accepts (SQL Language Reference, EXPLAIN PLAN), and what Explain Analyse runs. */
export const EXPLAIN_VERBS = ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", CREATE_TABLE_AS];

export function explainStatement(sql: string, statementId: string): string {
  return `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${sql}`;
}

/** The rows `EXPLAIN PLAN` wrote, in the order `DBMS_XPLAN` prints them. */
export const PLAN_ROWS_SQL = `
  SELECT id AS "id", parent_id AS "parentId", operation AS "operation", options AS "options",
    object_owner AS "objectOwner", object_name AS "objectName", object_alias AS "objectAlias",
    cost AS "cost", cardinality AS "cardinality", bytes AS "bytes", time AS "time",
    access_predicates AS "accessPredicates", filter_predicates AS "filterPredicates"
  FROM plan_table WHERE statement_id = :id ORDER BY id`;

export const PLAN_TEXT_SQL = "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL'))";
export const PLAN_CLEANUP_SQL = "DELETE FROM plan_table WHERE statement_id = :id";

/** Every row source is timed and counted while statistics level is ALL, without editing the statement's hints. */
export const STATISTICS_ON_SQL = "ALTER SESSION SET STATISTICS_LEVEL = ALL";
export const STATISTICS_OFF_SQL = "ALTER SESSION SET STATISTICS_LEVEL = TYPICAL";
/** The cursor this session ran last before this query: the analysed statement. */
export const LAST_CURSOR_SQL = `SELECT prev_sql_id AS "sqlId", prev_child_number AS "child"
  FROM v$session WHERE sid = SYS_CONTEXT('USERENV', 'SID')`;
/** Probes the grant the analysed plan needs before the statement runs. */
export const ANALYZE_GRANT_PROBE_SQL = "SELECT 1 FROM v$sql_plan_statistics_all WHERE ROWNUM = 1";
export const ANALYZED_ROWS_SQL = `
  SELECT id AS "id", parent_id AS "parentId", operation AS "operation", options AS "options",
    object_owner AS "objectOwner", object_name AS "objectName", object_alias AS "objectAlias",
    cost AS "cost", cardinality AS "cardinality", bytes AS "bytes", time AS "time",
    access_predicates AS "accessPredicates", filter_predicates AS "filterPredicates",
    last_output_rows AS "actualRows", last_starts AS "starts", last_elapsed_time AS "elapsedMicros",
    last_cr_buffer_gets AS "bufferGets"
  FROM v$sql_plan_statistics_all WHERE sql_id = :sqlId AND child_number = :child ORDER BY id`;
export const ANALYZED_TEXT_SQL =
  "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:sqlId, :child, 'ALLSTATS LAST'))";

/** The hint a refused Explain Analyse gives: the views it reads need this role. */
export function analyzeGrantHint(user: string): string {
  return `Explain Analyse reads V$SQL_PLAN_STATISTICS_ALL, which needs a catalog grant: ask for GRANT SELECT_CATALOG_ROLE TO ${user}, or use Explain Plan.`;
}

/** One row of `PLAN_TABLE` or `V$SQL_PLAN_STATISTICS_ALL`; the statistics are null for a plain plan. */
export interface PlanRow {
  readonly id: number;
  readonly parentId: number | null;
  readonly operation: string;
  readonly options: string | null;
  readonly objectOwner: string | null;
  readonly objectName: string | null;
  readonly objectAlias: string | null;
  readonly cost: number | null;
  readonly cardinality: number | null;
  readonly bytes: number | null;
  readonly time: number | null;
  readonly accessPredicates: string | null;
  readonly filterPredicates: string | null;
  readonly actualRows?: number | null;
  readonly starts?: number | null;
  readonly elapsedMicros?: number | null;
  readonly bufferGets?: number | null;
}

const MICROS_PER_MS = 1000;
const INDEX_OPERATION = /^INDEX\b/;

function property(name: string, value: string | number | null | undefined): PlanProperty[] {
  return value === null || value === undefined || value === "" ? [] : [{ name, value: String(value) }];
}

/** The `@` suffix `DBMS_XPLAN` adds to an alias names the query block, not the alias the user wrote. */
function alias(row: PlanRow): string | null {
  const written = row.objectAlias?.split("@")[0]?.replace(/"/g, "") ?? null;
  return written === null || written === "" || written === row.objectName ? null : written;
}

function nodeOf(row: PlanRow, children: readonly PlanNode[], analyzed: boolean): PlanNode {
  const index = INDEX_OPERATION.test(row.operation);
  const shownAlias = alias(row);
  const target =
    row.objectName === null || index ? null : shownAlias === null ? row.objectName : `${row.objectName} ${shownAlias}`;
  return {
    operation: row.options === null ? row.operation : `${row.operation} ${row.options}`,
    target,
    detail: index && row.objectName !== null ? `using ${row.objectName}` : null,
    estimatedRows: row.cardinality,
    estimatedCost: row.cost,
    actualRows: analyzed ? (row.actualRows ?? null) : null,
    actualTimeMs: analyzed && row.elapsedMicros != null ? row.elapsedMicros / MICROS_PER_MS : null,
    loops: analyzed ? (row.starts ?? null) : null,
    properties: [
      ...property("Id", row.id),
      ...property("Owner", row.objectOwner),
      ...property("Bytes", row.bytes),
      ...property("Time (s)", row.time),
      ...property("Access", row.accessPredicates),
      ...property("Filter", row.filterPredicates),
      ...(analyzed ? property("Buffers", row.bufferGets) : []),
    ],
    children,
  };
}

/** The plan rows as a tree: each row under its `parent_id`, the roots those without one. */
export function planTree(rows: readonly PlanRow[], analyzed: boolean): PlanNode[] {
  const childrenOf = new Map<number | null, PlanRow[]>();
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    const parent = row.parentId !== null && ids.has(row.parentId) ? row.parentId : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), row]);
  }
  const build = (row: PlanRow): PlanNode => nodeOf(row, (childrenOf.get(row.id) ?? []).map(build), analyzed);
  return (childrenOf.get(null) ?? []).map(build);
}
