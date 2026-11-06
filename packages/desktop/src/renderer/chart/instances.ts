import type { ECharts } from "@table-craft/desktop/renderer/chart/echarts.js";

export type ChartInstance = ReturnType<ECharts["init"]>;

/** The drawn chart of each result tab, keyed by `chartKey`, so Reset Zoom and Export reach it. */
const instances = new Map<string, ChartInstance>();

export function chartKey(ownerId: string, resultId: string): string {
  return `${ownerId}\u0000${resultId}`;
}

export function chartInstance(ownerId: string, resultId: string): ChartInstance | undefined {
  return instances.get(chartKey(ownerId, resultId));
}

export function keepChart(key: string, chart: ChartInstance): void {
  instances.set(key, chart);
}

export function forgetChart(key: string, chart: ChartInstance): void {
  if (instances.get(key) === chart) instances.delete(key);
}
