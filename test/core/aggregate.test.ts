import { aggregateCells } from "@table-craft/core";
import { describe, expect, it } from "vitest";

describe("aggregateCells", () => {
  it("givenNumericSelection_whenAggregate_thenSumAvgExactForDecimal", () => {
    const rows = [["0.10"], ["0.20"], ["12345678901234567890.0001"], [null]];

    const aggregates = aggregateCells(rows, ["decimal"]);

    expect(aggregates).toEqual({
      cells: 4,
      distinct: 3,
      kind: "numeric",
      sum: "12345678901234567890.3001",
      avg: "4115226300411522630.1000333333",
      min: "0.10",
      max: "12345678901234567890.0001",
    });
  });

  it("givenIntegersAndBigInts_whenAggregate_thenExactSum", () => {
    const rows = [[9007199254740991, { kind: "bigint" as const, value: "9007199254740993" }]];

    const aggregates = aggregateCells(rows, ["integer", "integer"]);

    expect(aggregates.sum).toBe("18014398509481984");
    expect(aggregates.avg).toBe("9007199254740992");
    expect(aggregates.min).toBe(9007199254740991);
  });

  it("givenNegativeDecimals_whenAggregate_thenRoundsAverageHalfAwayFromZero", () => {
    const aggregates = aggregateCells([["-1"], ["-1"], ["-0.5"]], ["decimal"]);

    expect(aggregates.sum).toBe("-2.5");
    expect(aggregates.avg).toBe("-0.8333333");
  });

  it("givenFloatColumn_whenAggregate_thenDoubleArithmetic", () => {
    const aggregates = aggregateCells([[0.1], [0.2]], ["float"]);

    expect(aggregates.sum).toBe(String(0.1 + 0.2));
    expect(aggregates.avg).toBe(String((0.1 + 0.2) / 2));
  });

  it("givenMixedSelection_whenAggregate_thenCountAndDistinctOnly", () => {
    const rows = [
      [1, "a"],
      [1, "a"],
      [2, null],
    ];

    const aggregates = aggregateCells(rows, ["integer", "text"]);

    expect(aggregates).toEqual({
      cells: 6,
      distinct: 3,
      kind: "other",
      sum: null,
      avg: null,
      min: null,
      max: null,
    });
  });

  it("givenTemporalSelection_whenAggregate_thenMinAndMaxWithoutSum", () => {
    const rows = [
      [{ kind: "date" as const, iso: "2024-03-01T00:00:00.000Z" }],
      [{ kind: "date" as const, iso: "2023-12-31T00:00:00.000Z" }],
    ];

    const aggregates = aggregateCells(rows, ["temporal"]);

    expect(aggregates.kind).toBe("temporal");
    expect(aggregates.sum).toBeNull();
    expect(aggregates.min).toEqual({ kind: "date", iso: "2023-12-31T00:00:00.000Z" });
    expect(aggregates.max).toEqual({ kind: "date", iso: "2024-03-01T00:00:00.000Z" });
  });

  it("givenNonNumericTextInNumericColumn_whenAggregate_thenNoSum", () => {
    const aggregates = aggregateCells([[1], ["n/a"]], ["integer"]);

    expect(aggregates.sum).toBeNull();
    expect(aggregates.min).toBe(1);
  });

  it("givenOnlyNulls_whenAggregate_thenNoSum", () => {
    expect(aggregateCells([[null], [null]], ["integer"])).toMatchObject({ cells: 2, distinct: 0, sum: null });
  });
});
