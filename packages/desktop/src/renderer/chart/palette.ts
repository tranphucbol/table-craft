/** The variables a chart paints with; series take the datasource tints, in an order adjacent ones tell apart. */
export const CHART_PALETTE_VARIABLES = {
  canvas: "--tc-canvas",
  panel: "--tc-panel",
  raised: "--tc-raised",
  border: "--tc-border",
  ink: "--tc-ink",
  inkMuted: "--tc-ink-muted",
  success: "--tc-success",
  danger: "--tc-danger",
  fontUi: "--tc-font-ui",
  fontUiSize: "--tc-font-ui-size",
  fontGrid: "--tc-font-grid",
  motion: "--tc-motion-base",
} as const;

export const CHART_SERIES_VARIABLES = [
  "--tc-ds-blue",
  "--tc-ds-orange",
  "--tc-ds-green",
  "--tc-ds-violet",
  "--tc-ds-red",
  "--tc-ds-yellow",
] as const;

export type ChartPalette = Readonly<Record<keyof typeof CHART_PALETTE_VARIABLES, string>> & {
  readonly series: readonly string[];
};

/** The palette from any reader of CSS variables: the computed style, or a theme's variables in a test. */
export function chartPalette(read: (variable: string) => string | undefined): ChartPalette {
  const value = (variable: string) => (read(variable) ?? "").trim();
  const named = Object.fromEntries(
    Object.entries(CHART_PALETTE_VARIABLES).map(([name, variable]) => [name, value(variable)]),
  ) as Record<keyof typeof CHART_PALETTE_VARIABLES, string>;
  return { ...named, series: CHART_SERIES_VARIABLES.map(value) };
}

/** The theme the app shows right now, read from the variables `applyAppearance` wrote. */
export function readChartPalette(root: HTMLElement = document.documentElement): ChartPalette {
  const style = getComputedStyle(root);
  return chartPalette((variable) => style.getPropertyValue(variable));
}
