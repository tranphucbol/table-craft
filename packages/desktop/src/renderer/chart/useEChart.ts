import type { EChartsOption } from "echarts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadECharts } from "@table-craft/desktop/renderer/chart/echarts.js";
import { forgetChart, keepChart, type ChartInstance } from "@table-craft/desktop/renderer/chart/instances.js";

/**
 * `data-chart-settled` on the plot: "true" once the last option has finished drawing, its
 * animation included, so a screenshot or a test never catches a chart halfway.
 */
const SETTLED = "chartSettled";

/**
 * An ECharts instance on the returned element for as long as it is mounted, drawing `option`. It
 * follows the element's size, and `failed` says why ECharts did not load.
 */
export function useEChart(key: string, option: EChartsOption | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<ChartInstance | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The option the window was narrowed on: a new option draws the whole axis again.
  const [zoomedOn, setZoomedOn] = useState<EChartsOption | null>(null);
  const drawing = useRef<EChartsOption | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    let disposed = false;
    let chart: ChartInstance | null = null;
    let observer: ResizeObserver | null = null;
    loadECharts().then(
      (echarts) => {
        if (disposed) return;
        const created = echarts.init(element, null, { renderer: "canvas" });
        created.on("finished", () => {
          element.dataset[SETTLED] = "true";
        });
        created.on("datazoom", () => setZoomedOn(windowNarrowed(created) ? drawing.current : null));
        chart = created;
        keepChart(key, created);
        observer = new ResizeObserver(() => created.resize());
        observer.observe(element);
        setFailed(null);
        setInstance(created);
      },
      (cause: unknown) => {
        if (!disposed) setFailed(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      disposed = true;
      observer?.disconnect();
      if (chart !== null) {
        forgetChart(key, chart);
        chart.dispose();
      }
      setInstance(null);
    };
  }, [key]);

  // In the commit that changes the plot's attributes, so no reader sees the new kind still settled.
  useLayoutEffect(() => {
    if (instance === null || option === null) return;
    const element = ref.current;
    if (element !== null) element.dataset[SETTLED] = "false";
    instance.setOption(option, { notMerge: true });
    drawing.current = option;
  }, [instance, option]);

  return { ref, failed, ready: instance !== null, zoomed: zoomedOn !== null && zoomedOn === option };
}

const FULL_WINDOW = { start: 0, end: 100 } as const;

/** Whether a zoom window shows less than the whole axis. */
function windowNarrowed(chart: ChartInstance): boolean {
  const zooms = (chart.getOption() as { dataZoom?: readonly { start?: number; end?: number }[] }).dataZoom ?? [];
  return zooms.some(
    (zoom) => (zoom.start ?? FULL_WINDOW.start) > FULL_WINDOW.start || (zoom.end ?? FULL_WINDOW.end) < FULL_WINDOW.end,
  );
}

/** Bumped whenever the root's variables change, so a canvas repaints in a theme it cannot follow by itself. */
export function useAppearanceVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((was) => was + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => observer.disconnect();
  }, []);
  return version;
}
