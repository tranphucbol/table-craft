import { readFileSync } from "node:fs";
import type { PlanNode, Row } from "@table-craft/plugin-api";
import { explainStatement, planFormat, readJson, readTidbTable, readTree } from "@table-craft/plugin-mysql/explain";
import { explainDialect } from "@table-craft/plugin-mysql/server";
import { readPlan } from "@table-craft/plugin-postgres/explain";
import { readPlanRows } from "@table-craft/plugin-sqlite/explain";
import { describe, expect, it } from "vitest";

/** Captured from the `test:db` containers (postgres:17, mysql:8.4, mariadb:10.11, TiDB v4.0.14) and node:sqlite on the fixture schema. */
function captured(name: string): string {
  return readFileSync(new URL(`../support/plans/${name}`, import.meta.url), "utf8").trimEnd();
}

function shape(node: PlanNode): unknown {
  return { operation: node.operation, children: node.children.map(shape) };
}

describe("plan readers", () => {
  it("givenPostgresJson_whenRead_thenNestedNodesAndSummary", () => {
    const plan = readPlan(captured("postgres-explain.json"), "EXPLAIN (FORMAT JSON) …", false);
    expect(plan.roots.map(shape)).toEqual([
      {
        operation: "Nested Loop",
        children: [
          { operation: "Seq Scan", children: [] },
          { operation: "Index Scan", children: [] },
        ],
      },
    ]);
    const [scan, lookup] = plan.roots[0]?.children ?? [];
    expect(scan).toMatchObject({ target: "orders o", estimatedRows: 2, estimatedCost: 1.04, actualRows: null });
    expect(scan?.properties).toContainEqual({ name: "Filter", value: "(total > '10'::numeric)" });
    expect(lookup).toMatchObject({ target: "customers c", detail: "using customers_pkey" });
    expect(lookup?.properties).toContainEqual({ name: "Index Cond", value: "(id = o.customer_id)" });
    expect(lookup?.properties.map((property) => property.name)).not.toContain("Index Name");
    expect(plan.summary).toEqual([]);
  });

  it("givenPostgresAnalysedJson_whenRead_thenActualsAndTimesInSummary", () => {
    const plan = readPlan(captured("postgres-analyze.json"), "EXPLAIN (ANALYZE, FORMAT JSON) …", true);
    expect(plan.roots[0]).toMatchObject({ actualRows: 2, loops: 1, actualTimeMs: 0.036 });
    expect(plan.roots[0]?.children[1]).toMatchObject({ actualRows: 1, loops: 2 });
    expect(plan.summary).toEqual([
      { name: "Planning Time", value: "1.029 ms" },
      { name: "Execution Time", value: "0.057 ms" },
    ]);
  });

  it("givenMysqlTree_whenRead_thenDepthFromIndent", () => {
    const plan = readTree(captured("mysql-explain.txt"), "EXPLAIN FORMAT=TREE …", false);
    expect(plan.roots.map(shape)).toEqual([
      {
        operation: "Nested loop inner join",
        children: [
          { operation: "Filter", children: [{ operation: "Table scan on o", children: [] }] },
          { operation: "Single-row index lookup on c using PRIMARY (id=o.customer_id)", children: [] },
        ],
      },
    ]);
    expect(plan.roots[0]).toMatchObject({ estimatedCost: 0.9, estimatedRows: 1, actualRows: null });
    expect(plan.roots[0]?.children[0]?.detail).toBe("(o.total > 10.00)");
  });

  it("givenMysqlAnalysedTree_whenRead_thenActualTimeRowsAndLoops", () => {
    const plan = readTree(captured("mysql-analyze.txt"), "EXPLAIN ANALYZE FORMAT=TREE …", true);
    expect(plan.roots[0]).toMatchObject({ actualTimeMs: 0.193, actualRows: 2, loops: 1 });
    expect(plan.roots[0]?.children[1]).toMatchObject({ actualTimeMs: 0.0244, actualRows: 1, loops: 2 });
    const update = readTree(
      "-> Update o (immediate)  (actual time=0.00508..0.00508 rows=0 loops=1)\n" +
        "    -> Rows fetched before execution  (cost=0..0 rows=1) (actual time=125e-6..125e-6 rows=1 loops=1)",
      "",
      true,
    );
    expect(update.roots[0]).toMatchObject({ operation: "Update o (immediate)", estimatedCost: null, loops: 1 });
    expect(update.roots[0]?.children[0]).toMatchObject({ estimatedCost: 0, actualTimeMs: 0.000125 });
  });

  it("givenMysqlUpdateJson_whenRead_thenOneUpdateStepWithItsCondition", () => {
    const plan = readJson(captured("mysql-update.json"), "EXPLAIN FORMAT=JSON …");
    expect(plan.roots).toHaveLength(1);
    expect(plan.roots[0]).toMatchObject({
      operation: "Update",
      target: "orders",
      detail: "range access using PRIMARY",
      estimatedRows: 1,
    });
    expect(plan.roots[0]?.properties).toContainEqual({
      name: "attached_condition",
      value: "(`table_craft`.`orders`.`id` = 1)",
    });
  });

  it("givenMariadbAnalysedJson_whenRead_thenTablesWithActualRowsAndLoops", () => {
    const plan = readJson(captured("mariadb-analyze.json"), "ANALYZE FORMAT=JSON …", true);
    expect(plan.analyzed).toBe(true);
    const [first, joined] = plan.roots[0]?.children ?? [];
    expect(first).toMatchObject({ target: "c", estimatedRows: 2, actualRows: 2, loops: 1 });
    expect(joined).toMatchObject({ target: "o", estimatedRows: 3, actualRows: 3, loops: 1 });
    expect(joined?.properties).toContainEqual({ name: "join_type", value: "BNL" });
  });

  it("givenTidb_whenPlanFormatChosen_thenPlainExplainWithoutFormat", () => {
    const tidb = explainDialect("8.0.11-TiDB-v7.5.1");
    expect(planFormat("SELECT", tidb, false)).toBe("table");
    expect(planFormat("UPDATE", tidb, false)).toBe("table");
    expect(planFormat("UPDATE", explainDialect("8.4.3"), false)).toBe("json");
    expect(explainStatement("SELECT 1", false, "table", tidb)).toBe("EXPLAIN SELECT 1");
    expect(explainStatement("SELECT 1", true, "table", tidb)).toBe("EXPLAIN ANALYZE SELECT 1");
  });

  it("givenServerWithoutTree_whenPlanFormatChosen_thenJson", () => {
    const mariadb = explainDialect("10.11.8-MariaDB-log");
    const mysql57 = explainDialect("5.7.44");
    expect(planFormat("SELECT", mariadb, false)).toBe("json");
    expect(planFormat("SELECT", mysql57, false)).toBe("json");
    expect(planFormat("SELECT", explainDialect("8.0.16"), false)).toBe("tree");
    expect(explainStatement("SELECT 1", true, "json", mariadb)).toBe("ANALYZE FORMAT=JSON SELECT 1");
    expect(() => explainStatement("SELECT 1", true, "json", mysql57)).toThrow(/8\.0\.18/);
    expect(explainDialect("8.0.17").analyze).toBeNull();
    expect(explainDialect(null)).toEqual({ tidb: false, tree: true, analyze: "explainAnalyze" });
  });

  it("givenTidbTable_whenRead_thenTreeFromPrefixesAndAccessObjectAsTarget", () => {
    const plan = readTidbTable(captured("tidb-explain.tsv"), "EXPLAIN …", false);
    expect(plan.roots.map(shape)).toEqual([
      {
        operation: "IndexLookUp_13",
        children: [
          { operation: "Limit_12", children: [{ operation: "IndexFullScan_10", children: [] }] },
          { operation: "TableRowIDScan_11", children: [] },
        ],
      },
    ]);
    const [root] = plan.roots;
    expect(root).toMatchObject({ target: null, detail: "limit embedded(offset:0, count:10)", estimatedRows: 10 });
    expect(root?.properties).toEqual([{ name: "task", value: "root" }]);
    const scan = root?.children[0]?.children[0];
    expect(scan).toMatchObject({
      target: "table:order_events_202601, index:order_events_shop_id(shop_id)",
      detail: "keep order:false, stats:pseudo",
      actualRows: null,
    });
    expect(root?.children[1]?.properties).toEqual([
      { name: "role", value: "Probe" },
      { name: "task", value: "cop[tikv]" },
    ]);
  });

  it("givenTidbJoin_whenRead_thenSiblingsUnderTheirOwnParent", () => {
    const plan = readTidbTable(captured("tidb-join.tsv"), "EXPLAIN …", false);
    expect(plan.roots.map(shape)).toEqual([
      {
        operation: "Sort_8",
        children: [
          {
            operation: "IndexJoin_15",
            children: [
              { operation: "IndexReader_31", children: [{ operation: "IndexRangeScan_30", children: [] }] },
              { operation: "TableReader_14", children: [{ operation: "TableRangeScan_13", children: [] }] },
            ],
          },
        ],
      },
    ]);
    expect(plan.roots[0]?.estimatedRows).toBe(12.5);
  });

  it("givenTidbAnalysedTable_whenRead_thenActualRowsTimeAndExecutionInfo", () => {
    const plan = readTidbTable(captured("tidb-analyze.tsv"), "EXPLAIN ANALYZE …", true);
    const [root] = plan.roots;
    expect(root).toMatchObject({ operation: "IndexLookUp_7", actualRows: 2, actualTimeMs: 1.89, loops: null });
    expect(root?.properties.map((property) => property.name)).toEqual(["task", "execution info", "memory"]);
    expect(root?.children[0]).toMatchObject({ operation: "IndexRangeScan_5", actualRows: 2, actualTimeMs: 0.232 });
    expect(root?.children[0]?.properties.map((property) => property.name)).not.toContain("disk");
  });

  it("givenTidbThreeCountColumn_whenRead_thenItIsTheEstimate", () => {
    const plan = readTidbTable(
      "id\tcount\ttask\toperator info\nTableReader_5\t3.00\troot\tdata:TableScan_4",
      "",
      false,
    );
    expect(plan.roots[0]).toMatchObject({ operation: "TableReader_5", estimatedRows: 3, detail: "data:TableScan_4" });
  });

  it("givenSqliteRows_whenRead_thenTreeFromParent", () => {
    const { rows } = JSON.parse(captured("sqlite-view.json")) as { rows: Row[] };
    const plan = readPlanRows(rows, "EXPLAIN QUERY PLAN …");
    expect(plan.roots.map(shape)).toEqual([
      {
        operation: "CO-ROUTINE customer_totals",
        children: [
          { operation: "SCAN c", children: [] },
          { operation: "BLOOM FILTER ON o (customer_id=?)", children: [] },
          { operation: "SEARCH o USING AUTOMATIC COVERING INDEX (customer_id=?) LEFT-JOIN", children: [] },
        ],
      },
      { operation: "SCAN customer_totals", children: [] },
    ]);
    expect(plan.raw.split("\n")).toEqual([
      "QUERY PLAN",
      "|--CO-ROUTINE customer_totals",
      "|  |--SCAN c",
      "|  |--BLOOM FILTER ON o (customer_id=?)",
      "|  `--SEARCH o USING AUTOMATIC COVERING INDEX (customer_id=?) LEFT-JOIN",
      "`--SCAN customer_totals",
    ]);
  });
});
