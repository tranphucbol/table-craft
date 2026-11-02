import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER = resolve(import.meta.dirname, "../../packages/desktop/src/renderer");
const SOURCE = /\.tsx?$/;
/** A dialog-sized surface rounds through the token so Islands can follow the island (plan 144). */
const DIALOG_SHADOW = "shadow-dialog";
const DIALOG_RADIUS = "rounded-dialog";
const LITERAL_DIALOG_RADIUS = /\brounded-lg\b/;
/** Tailwind's own shadow scale is one 10-25 % black for every theme; floating surfaces cast the elevation tokens. */
const LITERAL_SHADOW = /(?<![\w-])shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl))?(?![\w-])|shadow-\[|drop-shadow|rgb\(0 0 0/;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

function sourceLines(): { where: string; line: string }[] {
  return sources(RENDERER).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .map((line, index) => ({ where: `${relative(RENDERER, path)}:${String(index + 1)}`, line })),
  );
}

describe("floating surface radius tokens", () => {
  it("givenRendererSources_whenScanned_thenNoSurfaceHardCodesRoundedLg", () => {
    const offenders = sourceLines()
      .filter(({ line }) => LITERAL_DIALOG_RADIUS.test(line))
      .map(({ where }) => where);

    expect(offenders).toEqual([]);
  });

  it("givenRendererSources_whenScanned_thenNoSurfaceCastsALiteralShadow", () => {
    const offenders = sourceLines()
      .filter(({ line }) => LITERAL_SHADOW.test(line))
      .map(({ where }) => where);

    expect(offenders).toEqual([]);
  });

  it("givenRendererSources_whenScanned_thenEveryDialogShadowSurfaceIsRoundedDialog", () => {
    const surfaces = sourceLines().filter(({ line }) => line.includes(DIALOG_SHADOW));
    const offenders = surfaces.filter(({ line }) => !line.includes(DIALOG_RADIUS)).map(({ where }) => where);

    expect(surfaces.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
