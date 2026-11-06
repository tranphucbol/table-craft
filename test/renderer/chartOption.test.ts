import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_THEMES, BUNDLED_THEMES, type Theme } from "@table-craft/desktop/appearance/themes.js";
import type { ChartData, ChartSpec } from "@table-craft/desktop/engine/protocol.js";
import { chartFileName, pngBytes } from "@table-craft/desktop/renderer/actions/chartExport.js";
import { appearanceVariables } from "@table-craft/desktop/renderer/appearance/apply.js";
import { appearanceOf } from "@table-craft/desktop/renderer/appearance/tokens.js";
import { chartPalette, type ChartPalette } from "@table-craft/desktop/renderer/chart/palette.js";
import {
  chartLabel,
  chartNumberText,
  chartOption,
  chartStatusParts,
  chartZooms,
  escapeHtml,
  timeText,
  type ChartColumns,
} from "@table-craft/desktop/renderer/model/chartOption.js";
import { DEFAULT_SETTINGS } from "@table-craft/desktop/settings/settings.js";

const CHART_DIR = join(import.meta.dirname, "../../packages/desktop/src/renderer/chart");
const NO_PREFERENCE = { prefersReducedMotion: false };
const GROUPED = { groupDigits: true };
const PLAIN = { groupDigits: false };
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i;

function paletteFor(theme: Theme): ChartPalette {
  const variables = appearanceVariables(appearanceOf(DEFAULT_SETTINGS, theme, NO_PREFERENCE));
  return chartPalette((variable) => variables[variable]);
}

const DARK = BUILT_IN_THEMES.dark;

function spec(overrides: Partial<ChartSpec>): ChartSpec {
  return { kind: "bar", x: 0, y: [1], groupBy: null, aggregate: "sum", bins: null, ...overrides };
}

function data(overrides: Partial<ChartData>): ChartData {
  return { axis: "category", categories: [], series: [], rows: 0, skipped: 0, truncated: [], ...overrides };
}

const BY_COUNTRY: ChartColumns = { names: ["country", "total"], classes: ["text", "decimal"] };
const BARS = data({
  categories: ["VN", "US", "DE"],
  series: [{ name: "total", values: [1200.5, 900, 15] }],
  rows: 3,
});

describe("chart option", () => {
  it("givenChartSources_whenScanned_thenNoColourLiterals", () => {
    const found = readdirSync(CHART_DIR).flatMap((name) =>
      readFileSync(join(CHART_DIR, name), "utf8")
        .split("\n")
        .flatMap((line, index) => (COLOUR_LITERAL.test(line) ? [`${name}:${String(index + 1)}`] : [])),
    );

    expect(found).toEqual([]);
  });

  it("givenThemeVariables_whenPaletteRead_thenDatasourceTintsInOrder", () => {
    const palette = paletteFor(DARK);
    const tints = DARK.colors.datasource;

    expect(palette.series).toEqual([tints.blue, tints.orange, tints.green, tints.violet, tints.red, tints.yellow]);
    expect(palette.ink).toBe(DARK.colors.ink);
    expect(palette.canvas).toBe(DARK.colors.canvas);
  });

  it("givenEveryBundledTheme_whenPaletteRead_thenEveryColourHasAValue", () => {
    for (const theme of Object.values(BUNDLED_THEMES)) {
      const palette = paletteFor(theme);
      const { series, ...named } = palette;
      expect(
        series.every((colour) => colour !== ""),
        theme.id,
      ).toBe(true);
      expect(
        Object.entries(named).filter(([, value]) => value === ""),
        theme.id,
      ).toEqual([]);
    }
  });

  it("givenStock_whenOption_thenRiseSuccessFallDanger", () => {
    const palette = paletteFor(DARK);
    const stock = data({ categories: ["2024-01-02"], series: [{ name: "day", points: [[10, 12, 9, 13]] }], rows: 1 });
    const option = chartOption(
      stock,
      spec({ kind: "stock", y: [1, 2, 3, 4] }),
      { names: ["day", "open", "high", "low", "close"], classes: ["temporal", "float", "float", "float", "float"] },
      palette,
      PLAIN,
    );
    const [candles] = option.series as { type: string; itemStyle: Record<string, string> }[];

    expect(candles?.type).toBe("candlestick");
    expect(candles?.itemStyle).toMatchObject({ color: palette.success, color0: palette.danger });
  });

  it("givenTimeAxis_whenOption_thenUseUtcAndDataZoom", () => {
    const line = data({
      axis: "time",
      categories: null,
      series: [{ name: "orders", points: [[Date.UTC(2024, 0, 1), 3]] }],
      rows: 1,
    });
    const lineSpec = spec({ kind: "line" });
    const option = chartOption(
      line,
      lineSpec,
      { names: ["day", "orders"], classes: ["temporal", "integer"] },
      paletteFor(DARK),
      PLAIN,
    );

    expect(option.useUTC).toBe(true);
    expect(option.xAxis).toMatchObject({ type: "time" });
    expect(chartZooms(line, lineSpec)).toBe(true);
    expect((option.dataZoom as { type: string }[]).map((zoom) => zoom.type)).toEqual(["inside"]);
    expect(chartZooms(BARS, spec({}))).toBe(false);
  });

  it("givenManyPoints_whenOption_thenSliderUnderThePlot", () => {
    const points = Array.from({ length: 90 }, (_, at) => [Date.UTC(2024, 0, 1 + at), at]);
    const line = data({ axis: "time", categories: null, series: [{ name: "orders", points }], rows: points.length });
    const option = chartOption(
      line,
      spec({ kind: "line" }),
      { names: ["day", "orders"], classes: ["temporal", "integer"] },
      paletteFor(DARK),
      PLAIN,
    );

    expect((option.dataZoom as { type: string }[]).map((zoom) => zoom.type)).toEqual(["inside", "slider"]);
  });

  it("givenDates_whenTimeAxisLabels_thenOneDateFormat", () => {
    const days = data({
      axis: "time",
      categories: null,
      series: [
        {
          name: "orders",
          points: [
            [Date.UTC(2024, 0, 1), 1],
            [Date.UTC(2024, 0, 9), 2],
          ],
        },
      ],
      rows: 2,
    });
    const option = chartOption(
      days,
      spec({ kind: "line" }),
      { names: ["day", "orders"], classes: ["temporal", "integer"] },
      paletteFor(DARK),
      PLAIN,
    );
    const axis = option.xAxis as { minInterval: number; axisLabel: { formatter: (value: number) => string } };

    expect(axis.axisLabel.formatter(Date.UTC(2024, 0, 1))).toBe("2024-01-01");
    expect(axis.minInterval).toBe(86_400_000);
  });

  it("givenTimesOnOneDay_whenTimeAxisLabels_thenClockOnly", () => {
    const grain = { unit: 60_000, from: 19_723, to: 19_723 };
    expect(timeText(Date.UTC(2024, 0, 1, 9, 30), grain)).toBe("09:30");
    expect(timeText(Date.UTC(2024, 0, 1, 9, 30), { ...grain, to: 19_724 })).toBe("2024-01-01 09:30");
  });

  it("givenLineAndArea_whenOption_thenNoMarkersAndLightFill", () => {
    const line = data({
      axis: "time",
      categories: null,
      series: [
        { name: "a", points: [[0, 1]] },
        { name: "b", points: [[0, 2]] },
      ],
      rows: 1,
    });
    const option = chartOption(
      line,
      spec({ kind: "area", y: [1, 2] }),
      { names: ["day", "a", "b"], classes: ["temporal", "integer", "integer"] },
      paletteFor(DARK),
      PLAIN,
    );
    const series = option.series as { showSymbol: boolean; areaStyle: { opacity: number } }[];

    expect(series.every((one) => !one.showSymbol)).toBe(true);
    expect(series[0]?.areaStyle.opacity).toBeLessThanOrEqual(0.15);
    expect(option.legend).toMatchObject({ icon: "circle" });
    expect(option.yAxis).toMatchObject({ splitNumber: 4 });
  });

  it("givenGroupDigits_whenTooltipFormats_thenGrouped", () => {
    expect(chartNumberText(1234567.5, GROUPED, false)).toBe("1,234,567.5");
    expect(chartNumberText(1234567.5, PLAIN, false)).toBe("1234567.5");
    expect(chartNumberText(0.1 + 0.2, PLAIN, false)).toBe("0.3");
  });

  it("givenDecimalColumn_whenTooltipFormats_thenApproximateMark", () => {
    const option = chartOption(BARS, spec({}), BY_COUNTRY, paletteFor(DARK), GROUPED);
    const format = (option.tooltip as { valueFormatter: (value: unknown) => string }).valueFormatter;

    expect(format(1200.5)).toBe("≈ 1,200.5");
    expect(chartNumberText(2 ** 60, PLAIN, false)).toMatch(/^≈ /u);
  });

  it("givenCountAggregate_whenTooltipFormats_thenExact", () => {
    const option = chartOption(BARS, spec({ aggregate: "count" }), BY_COUNTRY, paletteFor(DARK), GROUPED);
    const format = (option.tooltip as { valueFormatter: (value: unknown) => string }).valueFormatter;

    expect(format(1200)).toBe("1,200");
  });

  it("givenBarData_whenLabelled_thenAriaLabelNamesKindColumnsAndCount", () => {
    expect(chartLabel(BARS, spec({}), BY_COUNTRY)).toBe("Bar chart of total by country, 3 bars");
    expect(chartLabel(BARS, spec({ kind: "pie", aggregate: "count" }), BY_COUNTRY)).toBe(
      "Pie chart of count of total by country, 3 slices",
    );
  });

  it("givenTruncatedAndSkipped_whenStatus_thenEverythingLeftOutSaid", () => {
    const parts = chartStatusParts(
      data({
        rows: 500,
        skipped: 3,
        truncated: [
          { what: "slices", shown: 19, total: 40 },
          { what: "series", shown: 20, total: 25 },
        ],
      }),
      true,
    );

    expect(parts).toEqual([
      "Plotting 500 rows",
      "more on the server; Fetch All to plot every row",
      "the largest 19 of 40 slices, the rest as Other",
      "the first 20 of 25 series",
      "3 rows skipped: NULL or not a number",
    ]);
  });

  it("givenPie_whenOption_thenNoAxesAndALegend", () => {
    const option = chartOption(BARS, spec({ kind: "pie" }), BY_COUNTRY, paletteFor(DARK), PLAIN);

    expect(option.xAxis).toBeUndefined();
    expect(option.legend).toMatchObject({ type: "scroll" });
    expect((option.series as { data: unknown[] }[])[0]?.data).toEqual([
      { name: "VN", value: 1200.5 },
      { name: "US", value: 900 },
      { name: "DE", value: 15 },
    ]);
  });

  it("givenPie_whenOption_thenTotalInTheHoleAndSharesInTheLegend", () => {
    const option = chartOption(BARS, spec({ kind: "pie" }), BY_COUNTRY, paletteFor(DARK), GROUPED);
    const legend = option.legend as { formatter: (name: string) => string };
    const [ring, hole] = option.series as { silent?: boolean; label: { show: boolean; formatter: string } }[];

    expect(hole?.silent).toBe(true);
    expect(hole?.label.formatter).toBe("{total|≈ 2,115.5}\n{caption|total}");
    expect(option.legend).toMatchObject({ data: ["VN", "US", "DE"] });
    expect(legend.formatter("VN")).toBe("VN  56.7%");
    expect(ring?.label.show).toBe(false);
  });

  it("givenMarkupInName_whenEscaped_thenInert", () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
  });
});

describe("chart export", () => {
  it("givenTabTitle_whenNamed_thenSafeFileName", () => {
    expect(chartFileName("orders by day")).toBe("orders-by-day-chart.png");
    expect(chartFileName("a/b:c")).toBe("a-b-c-chart.png");
    expect(chartFileName("")).toBe("chart.png");
  });

  it("givenPngDataUrl_whenDecoded_thenBytes", () => {
    expect([...pngBytes("data:image/png;base64,iVBORw==")]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(() => pngBytes("data:image/jpeg;base64,AA==")).toThrow("PNG");
  });
});
