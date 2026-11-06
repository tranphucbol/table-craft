# 160: Charts draw with ECharts, and the engine shapes the series

Status: Accepted. Plan 155. Amends 003.

## Decision

A result tab can show its rows as a chart: bar, line, area, pie, scatter, histogram and stock.

- **The engine shapes, the renderer draws.** `result.chart { handle, spec }` runs core's pure
  `chartData(rows, classes, names, spec)` over the rows the tab shows (its sort and local filter
  included) and answers `ChartData`: the axis kind, categories, series and the counts of rows
  plotted, skipped and cut. Rows never cross to the renderer (decision 009); a chart costs one
  message the size of what it draws.
- **The rows already fetched.** A chart plots what the grid holds, says when more wait on the
  server, and grows with Fetch All. It never runs the statement again or opens a second cursor.
- **Caps.** 1,000 categories, 20 series, a pie's largest 19 slices and Other, 5 to 100 histogram
  bins on round edges. Each cut is named in the status line.
- **Library.** Apache ECharts 6, modular (`echarts/core` with the bar, candlestick, line, pie and
  scatter charts, grid, legend, tooltip and data zoom), on the canvas renderer, loaded by a dynamic
  `import()` the first time a chart shows, so the window does not pay for it at launch.
- **Look.** No colour literal: the series take the datasource tints in a fixed order, axes, text
  and tooltips the theme's ink, border and raised surface, candles `--tc-success` and
  `--tc-danger`, read from the CSS variables on each draw, so a theme switch repaints in place.
- **State.** `ResultTab.chart { shown, spec }` belongs to the tab beside its layout; Rerun keeps it
  when the spec's columns are still there, else keeps the chart shown and suggests again.

## Rationale

The renderer is a view (decision 002): folding thousands of rows by category, binning them or
picking the largest slices in the renderer would mean shipping the rows to it, which decision 009
forbids. Core already holds the shown rows and their type classes, so a pure function there is
testable without a window and the same for every plugin.

Among the libraries, ECharts is the one that draws all seven kinds, candlesticks included, with
data zoom, large-data sampling and a canvas renderer that keeps tens of thousands of points
responsive. It runs under the window's CSP (`script-src 'self'`) with no `eval` or worker in the
modules used. Recharts and Nivo render SVG through React, slow past a few thousand points, and lack
a candlestick; uPlot is fast but draws only lines and bars; Chart.js needs a plugin for financial
charts and is weaker at axis-dense time series. Tree-shaken and split into its own chunk, ECharts
loads only when asked.

## Consequences

- The renderer stack (decision 003) gains `echarts`, in `renderer/chart/` only.
- A new chart kind is a core shape plus an option builder in `renderer/model/chartOption.ts`;
  registering another ECharts chart or component goes through `renderer/chart/echartsSetup.ts`.
- Pivoting, drawing beyond the fetched rows, and saving a chart with a console are out of scope.
