import { readFileSync } from "node:fs";
import { readPlanRows } from "@table-craft/plugin-duckdb/explain";
import { describe, expect, it } from "vitest";

/** `explain_value` of `SELECT status, count(*) AS n FROM 'orders.parquet' WHERE customer_id = 3 GROUP BY status`. */
function captured(name: string): string {
  return readFileSync(new URL(`../support/plans/${name}`, import.meta.url), "utf8").trimEnd();
}

describe("DuckDB plans", () => {
  it("givenExplainJson_whenReadPlan_thenTreeWithParquetScanLeaf", () => {
    const plan = readPlanRows([["physical_plan", captured("duckdb-explain.json")]], "EXPLAIN …", false);

    const group = plan.roots[0];
    const scan = group?.children[0]?.children[0];
    expect(group?.operation).toBe("HASH_GROUP_BY");
    expect(scan).toMatchObject({ operation: "PARQUET_SCAN", target: "PARQUET_SCAN", estimatedRows: 143 });
    expect(scan?.properties).toContainEqual({ name: "Filters", value: "(customer_id = 3)" });
    expect(plan.analyzed).toBe(false);
  });

  it("givenExplainAnalyzeJson_whenReadPlan_thenTimingAndCardinality", () => {
    const plan = readPlanRows([["analyzed_plan", captured("duckdb-analyze.json")]], "EXPLAIN …", true);

    const group = plan.roots[0];
    const scan = group?.children[0]?.children[0];
    expect(plan.roots).toHaveLength(1);
    expect(group).toMatchObject({ operation: "HASH_GROUP_BY", actualRows: 3, estimatedRows: 90, loops: 1 });
    expect(group?.actualTimeMs).toBeCloseTo(1.234, 3);
    expect(scan).toMatchObject({ operation: "TABLE_SCAN", actualRows: 143 });
    expect(plan.summary.map((property) => property.name)).toEqual(["Execution Time", "Rows Scanned"]);
  });
});
