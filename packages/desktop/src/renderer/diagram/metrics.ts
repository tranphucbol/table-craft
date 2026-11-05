import { useEffect, useState } from "react";
import type { DiagramFont, DiagramMetrics } from "@table-craft/desktop/renderer/model/diagramLayout.js";

/** The header is drawn semibold (`diagram.css`), so it is measured so. */
export const DIAGRAM_HEADER_WEIGHT = 600;
/** Text measured in both fonts to tell whether a font setting changed what a table measures. */
const FONT_PROBE = "customer_id bigint NOT NULL";

function pixels(style: CSSStyleDeclaration, name: string): number {
  return Number.parseFloat(style.getPropertyValue(name)) || 0;
}

function fontOf(style: CSSStyleDeclaration, font: DiagramFont): string {
  const family = style.getPropertyValue(`--tc-font-${font}`).trim();
  const size = style.getPropertyValue(`--tc-font-${font}-size`).trim();
  return font === "ui" ? `${DIAGRAM_HEADER_WEIGHT} ${size} ${family}` : `${size} ${family}`;
}

/** Sizes from the density and font tokens `applyAppearance` wrote, measured on a canvas in those fonts. */
export function readMetrics(root: HTMLElement = document.documentElement): DiagramMetrics {
  const style = getComputedStyle(root);
  const context = document.createElement("canvas").getContext("2d");
  const fonts: Readonly<Record<DiagramFont, string>> = { ui: fontOf(style, "ui"), grid: fontOf(style, "grid") };
  const cache = new Map<string, number>();
  return {
    rowHeight: pixels(style, "--tc-row-height"),
    padding: pixels(style, "--tc-cell-padding"),
    icon: pixels(style, "--tc-icon"),
    measure: (text, font) => {
      const key = `${font}\u0000${text}`;
      const known = cache.get(key);
      if (known !== undefined) return known;
      if (context === null) return 0;
      context.font = fonts[font];
      const width = context.measureText(text).width;
      cache.set(key, width);
      return width;
    },
  };
}

/**
 * The current metrics, measured again whenever the appearance is applied (a theme, density or font
 * setting changes the root element's style), so tables resize without reopening (decision 17).
 */
export function useDiagramMetrics(): DiagramMetrics {
  const [metrics, setMetrics] = useState(readMetrics);
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = readMetrics(root);
        setMetrics((current) =>
          current.rowHeight === next.rowHeight &&
          current.padding === next.padding &&
          current.icon === next.icon &&
          current.measure(FONT_PROBE, "ui") === next.measure(FONT_PROBE, "ui") &&
          current.measure(FONT_PROBE, "grid") === next.measure(FONT_PROBE, "grid")
            ? current
            : next,
        );
      });
    };
    const observer = new MutationObserver(remeasure);
    // A bundled font that finishes loading after the first measure changes every width.
    void document.fonts.ready.then(remeasure);
    observer.observe(root, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return metrics;
}
