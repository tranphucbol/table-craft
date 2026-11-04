import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIAGRAM_DIR = join(import.meta.dirname, "../../packages/desktop/src/renderer/diagram");

/** Hex, rgb()/hsl()/oklch() and the CSS named colours a component might reach for instead of a token. */
const COLOUR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(|(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow)(?![\w-])/i;

function diagramSources(): readonly string[] {
  return readdirSync(DIAGRAM_DIR).filter((name) => /\.(?:tsx?|css)$/.test(name));
}

describe("diagram theme", () => {
  it("givenDiagramSources_whenScanned_thenNoColourLiterals", () => {
    const found = diagramSources().flatMap((name) =>
      readFileSync(join(DIAGRAM_DIR, name), "utf8")
        .split("\n")
        .flatMap((line, index) => (COLOUR_LITERAL.test(line) ? [`${name}:${String(index + 1)}: ${line.trim()}`] : [])),
    );

    expect(diagramSources().length).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });
});
