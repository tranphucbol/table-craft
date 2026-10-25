import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { API_VERSION } from "@table-craft/plugin-api";
import { stagePackage } from "../../packages/plugin-api/scripts/build.js";

const STAGE_TIMEOUT_MS = 120_000;
const ROOT_FILES = ["LICENSE", "README.md", "package.json"];
const DIST_PREFIX = "dist/";
const ENTRY_FILES = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/sql/index.js",
  "dist/sql/index.d.ts",
  "dist/testing/index.js",
  "dist/testing/index.d.ts",
];
/** `testing` imports Vitest, which refuses to load outside a run. */
const NODE_ENTRIES = ["dist/index.js", "dist/sql/index.js"];

interface PackResult {
  readonly files: readonly { readonly path: string }[];
}

let staged = "";

beforeAll(() => {
  staged = stagePackage();
}, STAGE_TIMEOUT_MS);

describe("the publishable plugin-api package", () => {
  it("givenStagedPackage_whenPacked_thenListsOnlyDistReadmeLicenseAndManifest", () => {
    const [pack] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: staged, encoding: "utf8" }),
    ) as PackResult[];
    const paths = (pack?.files ?? []).map((file) => file.path);

    expect(paths.filter((path) => !ROOT_FILES.includes(path) && !path.startsWith(DIST_PREFIX))).toEqual([]);
    expect(paths).toEqual(expect.arrayContaining([...ROOT_FILES, ...ENTRY_FILES]));
  });

  it("givenStagedPackage_whenRead_thenVersionIsApiVersionAndExportsPointAtDist", () => {
    const manifest = JSON.parse(readFileSync(join(staged, "package.json"), "utf8")) as {
      version: string;
      private?: boolean;
      exports: Record<string, { types: string; default: string }>;
    };

    expect(manifest.version).toBe(API_VERSION);
    expect(manifest.private).toBeUndefined();
    for (const target of Object.values(manifest.exports)) {
      expect(target.default.startsWith(`./${DIST_PREFIX}`)).toBe(true);
      expect(target.types.startsWith(`./${DIST_PREFIX}`)).toBe(true);
    }
  });

  it("givenStagedPackage_whenImportedByNode_thenEntriesLoad", () => {
    const [main, sql] = NODE_ENTRIES.map((entry) => JSON.stringify(pathToFileURL(join(staged, entry)).href));
    const script = `const main = await import(${main}); await import(${sql}); console.log(main.API_VERSION);`;

    const printed = execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" }).trim();

    expect(printed).toBe(API_VERSION);
  });
});
