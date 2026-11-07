import {
  CHART_MAX_CATEGORIES,
  CHART_MAX_SERIES,
  HISTOGRAM_MAX_BINS,
  PIE_MAX_SLICES,
  PIE_OTHER_LABEL,
  binEdges,
  chartData,
  chartSpecProblem,
  type ChartSpec,
  type TypeClass,
} from "@table-craft/core";
import type { Row } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";

const BASE: ChartSpec = { kind: "bar", x: 0, y: [1], groupBy: null, aggregate: "sum", bins: null };

function spec(overrides: Partial<ChartSpec>): ChartSpec {
  return { ...BASE, ...overrides };
}

const TEXT_NUMBER: readonly TypeClass[] = ["text", "integer"];
const NAMES = ["label", "value", "group"];

describe("chartData", () => {
  it("givenCategoryX_whenLabelsRepeat_thenSummedInFirstAppearanceOrder", () => {
    const rows: Row[] = [
      ["b", 1],
      ["a", 2],
      ["b", 3],
    ];

    const data = chartData(rows, TEXT_NUMBER, NAMES, BASE);

    expect(data.axis).toBe("category");
    expect(data.categories).toEqual(["b", "a"]);
    expect(data.series).toEqual([{ name: "value", values: [4, 2] }]);
    expect(data.skipped).toBe(0);
  });

  it("givenCategoryX_whenAggregateCount_thenRowsCountedIgnoringY", () => {
    const rows: Row[] = [
      ["a", null],
      ["a", 5],
      [null, 1],
    ];

    const data = chartData(rows, TEXT_NUMBER, NAMES, spec({ aggregate: "count" }));

    expect(data.series[0]?.values).toEqual([2]);
    expect(data.skipped).toBe(1);
  });

  it("givenCategoryX_whenAggregateAvg_thenMeanPerCategory", () => {
    const rows: Row[] = [
      ["a", 1],
      ["a", 4],
    ];

    expect(chartData(rows, TEXT_NUMBER, NAMES, spec({ aggregate: "avg" })).series[0]?.values).toEqual([2.5]);
  });

  it("givenTemporalX_whenDateValues_thenEpochMillisWithoutZoneShift", () => {
    const rows: Row[] = [
      [{ kind: "date", iso: "2026-03-02T10:30:00.000+07:00" }, 1],
      [{ kind: "date", iso: "2026-03-01T00:00:00.000Z" }, 2],
    ];

    const data = chartData(rows, ["temporal", "integer"], NAMES, spec({ kind: "line" }));

    expect(data.axis).toBe("time");
    expect(data.series[0]?.points).toEqual([
      [Date.UTC(2026, 2, 1), 2],
      [Date.UTC(2026, 2, 2, 10, 30), 1],
    ]);
  });

  it("givenTemporalX_whenStringWithoutOffset_thenReadAsUtc", () => {
    const rows: Row[] = [
      ["2026-01-05 08:00:00", 1],
      ["2026-01-06", 2],
      ["not a date", 3],
    ];

    const data = chartData(rows, ["temporal", "integer"], NAMES, spec({ kind: "scatter" }));

    expect(data.series[0]?.points).toEqual([
      [Date.UTC(2026, 0, 5, 8), 1],
      [Date.UTC(2026, 0, 6), 2],
    ]);
    expect(data.skipped).toBe(1);
  });

  it("givenNumericX_whenScatter_thenValueAxisPoints", () => {
    const rows: Row[] = [
      [1.5, 2],
      [3, 4],
    ];

    const data = chartData(rows, ["float", "integer"], NAMES, spec({ kind: "scatter" }));

    expect(data.axis).toBe("value");
    expect(data.categories).toBeNull();
    expect(data.series[0]?.points).toEqual([
      [1.5, 2],
      [3, 4],
    ]);
  });

  it("givenBigIntAndDecimalY_whenPlotted_thenDoubles", () => {
    const rows: Row[] = [
      ["a", { kind: "bigint", value: "9007199254740993" }],
      ["b", "12.5"],
      ["c", "1e3"],
    ];

    const data = chartData(rows, ["text", "decimal"], NAMES, BASE);

    expect(data.series[0]?.values).toEqual([9007199254740992, 12.5, 1000]);
  });

  it("givenNullOrTextY_whenPlotted_thenRowSkippedAndCounted", () => {
    const rows: Row[] = [
      ["a", null],
      ["b", "n/a"],
      ["c", { kind: "json", text: "{}" }],
      ["d", 1],
    ];

    const data = chartData(rows, TEXT_NUMBER, NAMES, BASE);

    expect(data.skipped).toBe(3);
    expect(data.series[0]?.values).toEqual([null, null, null, 1]);
  });

  it("givenGroupBy_whenThreeValues_thenThreeSeries", () => {
    const rows: Row[] = [
      ["jan", 1, "x"],
      ["jan", 2, "y"],
      ["feb", 3, "z"],
      ["feb", 4, "x"],
    ];

    const data = chartData(rows, ["text", "integer", "text"], NAMES, spec({ groupBy: 2 }));

    expect(data.categories).toEqual(["jan", "feb"]);
    expect(data.series).toEqual([
      { name: "x", values: [1, 4] },
      { name: "y", values: [2, null] },
      { name: "z", values: [null, 3] },
    ]);
  });

  it("givenGroupBy_whenPastSeriesCap_thenTruncatedSeries", () => {
    const groups = CHART_MAX_SERIES + 5;
    const rows: Row[] = Array.from({ length: groups }, (_, at) => ["a", at, `g${String(at)}`]);

    const data = chartData(rows, ["text", "integer", "text"], NAMES, spec({ groupBy: 2 }));

    expect(data.series).toHaveLength(CHART_MAX_SERIES);
    expect(data.truncated).toEqual([{ what: "series", shown: CHART_MAX_SERIES, total: groups }]);
  });

  it("givenCategories_whenPastCap_thenFirstThousandAndTruncated", () => {
    const total = CHART_MAX_CATEGORIES + 200;
    const rows: Row[] = Array.from({ length: total }, (_, at) => [`c${String(at)}`, at]);

    const data = chartData(rows, TEXT_NUMBER, NAMES, BASE);

    expect(data.categories).toHaveLength(CHART_MAX_CATEGORIES);
    expect(data.categories?.[0]).toBe("c0");
    expect(data.truncated).toEqual([{ what: "categories", shown: CHART_MAX_CATEGORIES, total }]);
  });

  it("givenPie_whenPastSliceCap_thenLargestPlusOther", () => {
    const total = PIE_MAX_SLICES + 5;
    const rows: Row[] = Array.from({ length: total }, (_, at) => [`s${String(at)}`, at + 1]);

    const data = chartData(rows, TEXT_NUMBER, NAMES, spec({ kind: "pie" }));

    expect(data.categories).toHaveLength(PIE_MAX_SLICES);
    expect(data.categories?.[0]).toBe(`s${String(total - 1)}`);
    expect(data.categories?.at(-1)).toBe(PIE_OTHER_LABEL);
    expect(data.series[0]?.values?.at(-1)).toBe(1 + 2 + 3 + 4 + 5 + 6);
    expect(data.truncated).toEqual([{ what: "slices", shown: PIE_MAX_SLICES - 1, total }]);
  });

  it("givenHistogram_whenNoBins_thenSturgesOnRoundEdges", () => {
    const rows: Row[] = Array.from({ length: 10_000 }, (_, at) => [at]);

    const data = chartData(rows, ["integer"], ["total"], spec({ kind: "histogram", x: null, y: [0] }));

    expect(data.categories).toHaveLength(10);
    expect(data.categories?.[0]).toBe("0 – 1000");
    expect(data.series[0]?.values?.reduce((sum, value) => (sum ?? 0) + (value ?? 0), 0)).toBe(10_000);
    expect(
      chartData(rows.slice(0, 3), ["integer"], ["total"], spec({ kind: "histogram", x: null, y: [0] })).categories,
    ).toEqual(["0 – 0.5", "0.5 – 1", "1 – 1.5", "1.5 – 2"]);
  });

  it("givenOddRange_whenBinned_thenNiceStepFromRoundStart", () => {
    expect(binEdges(0.62, 99.4, 20)).toEqual({ start: 0, step: 5, bins: 20 });
    expect(binEdges(13, 87, 10)).toEqual({ start: 10, step: 10, bins: 8 });
    expect(binEdges(0, 1, HISTOGRAM_MAX_BINS).bins).toBeLessThanOrEqual(HISTOGRAM_MAX_BINS);
  });

  it("givenValueOnUpperEdge_whenBinned_thenLastBinHoldsIt", () => {
    const rows: Row[] = [[0], [5], [10]];

    const data = chartData(rows, ["integer"], ["total"], spec({ kind: "histogram", x: null, y: [0], bins: 2 }));

    expect(data.categories).toEqual(["0 – 5", "5 – 10"]);
    expect(data.series[0]?.values).toEqual([1, 2]);
  });

  it("givenTemporalX_whenBar_thenDatesFoldAsCategories", () => {
    const rows: Row[] = [
      ["2026-01-05", 1],
      ["2026-01-05", 2],
      ["2026-01-06", 4],
    ];

    const data = chartData(rows, ["temporal", "integer"], NAMES, BASE);

    expect(data.axis).toBe("category");
    expect(data.categories).toEqual(["2026-01-05", "2026-01-06"]);
    expect(data.series[0]?.values).toEqual([3, 4]);
  });

  it("givenHistogram_whenOneDistinctValue_thenOneBin", () => {
    const rows: Row[] = [[7], [7], [null]];

    const data = chartData(rows, ["integer"], ["total"], spec({ kind: "histogram", x: null, y: [0] }));

    expect(data.categories).toEqual(["7"]);
    expect(data.series[0]?.values).toEqual([2]);
    expect(data.skipped).toBe(1);
  });

  it("givenStock_whenOhlcColumns_thenOpenCloseLowHighOrder", () => {
    const rows: Row[] = [
      ["2026-01-02", 10, 15, 9, 12],
      ["2026-01-03", 12, 13, 8, null],
    ];

    const data = chartData(
      rows,
      ["temporal", "float", "float", "float", "float"],
      ["day", "open", "high", "low", "close"],
      spec({ kind: "stock", y: [1, 2, 3, 4] }),
    );

    expect(data.categories).toEqual(["2026-01-02"]);
    expect(data.series[0]?.points).toEqual([[10, 12, 9, 15]]);
    expect(data.skipped).toBe(1);
  });

  it("givenEmptyRows_whenCharted_thenNoPoints", () => {
    const data = chartData([], TEXT_NUMBER, NAMES, BASE);

    expect(data.rows).toBe(0);
    expect(data.categories).toEqual([]);
    expect(data.series[0]?.values).toEqual([]);
  });

  it("givenSpecsNotFittingTheirKind_whenChecked_thenProblemNamesWhatTheKindTakes", () => {
    expect(chartSpecProblem(spec({ kind: "pie", y: [1, 2] }))).toMatch(/exactly one value/u);
    expect(chartSpecProblem(spec({ kind: "stock", y: [1] }))).toMatch(/open, high, low, close/u);
    expect(chartSpecProblem(spec({ kind: "line", x: null }))).toMatch(/X column/u);
    expect(chartSpecProblem(BASE)).toBeNull();
  });
});
