import { describe, expect, it } from "vitest";
import type { ChartSpec, Column, TypeClass } from "@table-craft/desktop/engine/protocol.js";
import {
  carriedChart,
  effectiveSpec,
  specProblem,
  suggestChart,
  valueColumns,
  withKind,
} from "@table-craft/desktop/renderer/model/chartSpec.js";

function columnsOf(...names: string[]): Column[] {
  return names.map((name) => ({ name, type: null }));
}

function spec(overrides: Partial<ChartSpec>): ChartSpec {
  return { kind: "bar", x: 0, y: [1], groupBy: null, aggregate: "sum", bins: null, ...overrides };
}

describe("chart suggestion", () => {
  it("givenOhlcAndTemporal_whenSuggested_thenStock", () => {
    const columns = columnsOf("day", "open", "high", "low", "close", "volume");
    const classes: TypeClass[] = ["temporal", "decimal", "decimal", "decimal", "decimal", "integer"];

    expect(suggestChart(columns, classes)).toEqual(spec({ kind: "stock", x: 0, y: [1, 2, 3, 4] }));
  });

  it("givenTemporalAndNumeric_whenSuggested_thenLineOverTime", () => {
    const columns = columnsOf("day", "orders", "revenue");
    const classes: TypeClass[] = ["temporal", "integer", "decimal"];

    expect(suggestChart(columns, classes)).toEqual(spec({ kind: "line", x: 0, y: [1, 2] }));
  });

  it("givenTextAndNumeric_whenSuggested_thenBar", () => {
    const columns = columnsOf("country", "total");
    const classes: TypeClass[] = ["text", "decimal"];

    expect(suggestChart(columns, classes)).toEqual(spec({ kind: "bar", x: 0, y: [1] }));
  });

  it("givenTwoNumerics_whenSuggested_thenScatter", () => {
    const columns = columnsOf("weight", "price");
    const classes: TypeClass[] = ["float", "decimal"];

    expect(suggestChart(columns, classes)).toEqual(spec({ kind: "scatter", x: 0, y: [1] }));
  });

  it("givenOneNumeric_whenSuggested_thenHistogram", () => {
    const columns = columnsOf("total");

    expect(suggestChart(columns, ["decimal"])).toEqual(spec({ kind: "histogram", x: null, y: [0] }));
  });

  it("givenOnlyText_whenSuggested_thenNothingToPlot", () => {
    expect(suggestChart(columnsOf("name", "email"), ["text", "text"])).toBeNull();
  });

  it("givenIdColumns_whenSuggested_thenKeysSkippedForY", () => {
    const columns = columnsOf("id", "customer_id", "country", "total", "orderId");
    const classes: TypeClass[] = ["integer", "integer", "text", "decimal", "integer"];

    expect(valueColumns(columns, classes)).toEqual([3, 0, 1, 4]);
    expect(suggestChart(columns, classes)).toEqual(spec({ kind: "bar", x: 2, y: [3] }));
  });

  it("givenOnlyKeys_whenSuggested_thenKeysStillPlotted", () => {
    expect(suggestChart(columnsOf("id"), ["integer"])).toEqual(spec({ kind: "histogram", x: null, y: [0] }));
  });

  it("givenNoSpecChosen_whenEffective_thenSuggestion", () => {
    const columns = columnsOf("country", "total");
    const classes: TypeClass[] = ["text", "decimal"];
    const chosen = spec({ kind: "pie" });

    expect(effectiveSpec({ shown: true, spec: null }, columns, classes)).toEqual(spec({}));
    expect(effectiveSpec({ shown: true, spec: chosen }, columns, classes)).toBe(chosen);
  });
});

describe("chart spec", () => {
  it("givenRerunWithSameColumns_whenSpecChecked_thenKept", () => {
    const chart = { shown: true, spec: spec({ x: 0, y: [2], groupBy: 1 }) };

    expect(carriedChart(chart, ["country", "city", "total"], ["city", "country", "total"])).toEqual({
      shown: true,
      spec: spec({ x: 1, y: [2], groupBy: 0 }),
    });
  });

  it("givenRerunWithoutXColumn_whenSpecChecked_thenDropped", () => {
    const chart = { shown: true, spec: spec({ x: 0, y: [1] }) };

    expect(carriedChart(chart, ["country", "total"], ["region", "total"])).toEqual({ shown: true, spec: null });
  });

  it("givenNoChart_whenCarried_thenNone", () => {
    expect(carriedChart(undefined, ["a"], ["a"])).toBeUndefined();
  });

  it("givenBarSpec_whenKindSwitchedToPie_thenFirstYKept", () => {
    const columns = columnsOf("country", "orders", "total");
    const classes: TypeClass[] = ["text", "integer", "decimal"];

    expect(withKind(spec({ x: 0, y: [2, 1], groupBy: 0 }), "pie", columns, classes)).toEqual(
      spec({ kind: "pie", x: 0, y: [2], groupBy: null }),
    );
  });

  it("givenTwoNumerics_whenKindSwitchedToStock_thenRefused", () => {
    const columns = columnsOf("day", "orders", "total");
    const classes: TypeClass[] = ["temporal", "integer", "decimal"];

    expect(withKind(spec({ kind: "line", x: 0, y: [1, 2] }), "stock", columns, classes)).toBeNull();
  });

  it("givenLine_whenKindSwitchedToHistogram_thenNoXAndOneValue", () => {
    const columns = columnsOf("day", "orders", "total");
    const classes: TypeClass[] = ["temporal", "integer", "decimal"];

    expect(withKind(spec({ kind: "line", x: 0, y: [1, 2] }), "histogram", columns, classes)).toEqual(
      spec({ kind: "histogram", x: null, y: [1] }),
    );
  });

  it("givenSpecs_whenChecked_thenOnlyDrawableOnesPass", () => {
    expect(specProblem(spec({}))).toBe(false);
    expect(specProblem(spec({ x: null }))).toBe(true);
    expect(specProblem(spec({ y: [] }))).toBe(true);
    expect(specProblem(spec({ kind: "pie", y: [1, 2] }))).toBe(true);
    expect(specProblem(spec({ kind: "stock", y: [1, 2, 3] }))).toBe(true);
    expect(specProblem(spec({ kind: "histogram", x: null, y: [1] }))).toBe(false);
  });
});
