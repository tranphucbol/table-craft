import type { echarts } from "@table-craft/desktop/renderer/chart/echartsSetup.js";

export type ECharts = typeof echarts;

let loading: Promise<ECharts> | null = null;

/**
 * ECharts with only the charts and components a result chart uses, loaded the first time a chart
 * shows (plan 155 decision 3): the grid never pays for it.
 */
export function loadECharts(): Promise<ECharts> {
  loading ??= import("@table-craft/desktop/renderer/chart/echartsSetup.js").then(
    (module) => module.echarts,
    (cause: unknown) => {
      loading = null;
      throw cause;
    },
  );
  return loading;
}
