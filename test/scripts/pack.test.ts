import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_VERSION, MANIFEST_FILE } from "@table-craft/plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { readPackageTarball } from "@table-craft/desktop/main/pluginStore/tarball.js";
import { checkPackage, checkPackages, PackageCheckError } from "../../scripts/plugins/check.js";
import { npmPack, PLUGIN_KEYWORD, stagePlugin } from "../../scripts/plugins/pack.js";

const FROZEN_SQLITE = join(import.meta.dirname, "..", "support", "frozen-plugins", "sqlite-1.0.0");
const VERSION = "1.4.2";
const PACKED_FILES = ["LICENSE", "README.md", "index.js", "package.json", MANIFEST_FILE];
const NPM_TIMEOUT_MS = 60_000;

describe("plugin packages", () => {
  const scratch: string[] = [];

  afterEach(() => {
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** A build output holding the frozen SQLite plugin as `built/sqlite/`, its bundle ending in a map comment. */
  function builtSqlite(manifest?: (json: Record<string, unknown>) => Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "table-craft-pack-"));
    scratch.push(root);
    const built = join(root, "built");
    cpSync(FROZEN_SQLITE, join(built, "sqlite"), { recursive: true });
    const entry = join(built, "sqlite", "index.js");
    writeFileSync(entry, `${readFileSync(entry, "utf8")}\n//# sourceMappingURL=index.js.map\n`);
    if (manifest !== undefined) {
      const path = join(built, "sqlite", MANIFEST_FILE);
      writeFileSync(path, JSON.stringify(manifest(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)));
    }
    return { root, built, stage: join(root, "stage"), out: join(root, "out") };
  }

  it("givenBuiltPlugin_whenStaged_thenPackageJsonNamesThePluginWithNoDependenciesOrScripts", () => {
    const paths = builtSqlite();

    const directory = stagePlugin("sqlite", VERSION, paths.built, paths.stage);

    const json = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
    expect(json).toMatchObject({
      name: "@table-craft/plugin-sqlite",
      version: VERSION,
      type: "module",
      main: "index.js",
      license: "MIT",
      tableCraft: { id: "sqlite", apiVersion: API_VERSION },
      repository: { type: "git", directory: "plugins/sqlite" },
    });
    expect(json.keywords).toContain(PLUGIN_KEYWORD);
    expect(json).not.toHaveProperty("dependencies");
    expect(json).not.toHaveProperty("scripts");
    expect(json).not.toHaveProperty("private");
  });

  it("givenBuiltPlugin_whenStaged_thenManifestCarriesTheReleaseVersionAndTheBundleNoMapComment", () => {
    const paths = builtSqlite();

    const directory = stagePlugin("sqlite", VERSION, paths.built, paths.stage);

    expect(JSON.parse(readFileSync(join(directory, MANIFEST_FILE), "utf8"))).toMatchObject({
      id: "sqlite",
      version: VERSION,
    });
    expect(readFileSync(join(directory, "index.js"), "utf8")).not.toContain("sourceMappingURL");
    expect(readFileSync(join(directory, "README.md"), "utf8")).toContain("Install from File");
  });

  it(
    "givenStagedPlugin_whenPacked_thenTarballHoldsExactlyTheBundleManifestReadmeLicenseAndPackageJson",
    async () => {
      const paths = builtSqlite();

      const packed = npmPack(stagePlugin("sqlite", VERSION, paths.built, paths.stage), paths.root, "sqlite");

      expect(packed).toMatchObject({ name: "@table-craft/plugin-sqlite", version: VERSION, pluginId: "sqlite" });
      expect(packed.file).toBe(join(paths.root, `table-craft-plugin-sqlite-${VERSION}.tgz`));
      expect(packed.integrity).toMatch(/^sha512-/);
      expect(packed.files).toEqual([...PACKED_FILES].sort());
      const entries = readPackageTarball(await readFile(packed.file)).map((file) => file.path);
      expect(entries.sort()).toEqual([...PACKED_FILES].sort());
    },
    NPM_TIMEOUT_MS,
  );

  it(
    "givenPackedPlugin_whenChecked_thenItLoadsThroughTheRealLoader",
    async () => {
      const paths = builtSqlite();
      const packed = npmPack(stagePlugin("sqlite", VERSION, paths.built, paths.stage), paths.root, "sqlite");

      const [checked] = await checkPackages(paths.root);

      expect(checked).toEqual({
        file: packed.file,
        name: "@table-craft/plugin-sqlite",
        version: VERSION,
        pluginId: "sqlite",
      });
    },
    NPM_TIMEOUT_MS,
  );

  it(
    "givenBranchBuildVersion_whenPackedAndChecked_thenManifestTakesTheReleasePartAndStillLoads",
    async () => {
      const paths = builtSqlite();
      const directory = stagePlugin("sqlite", "0.0.0-dev.abc1234", paths.built, paths.stage);
      const packed = npmPack(directory, paths.root, "sqlite");

      expect(JSON.parse(readFileSync(join(directory, MANIFEST_FILE), "utf8"))).toMatchObject({ version: "0.0.0" });
      await expect(checkPackage(packed.file)).resolves.toMatchObject({ version: "0.0.0-dev.abc1234" });
    },
    NPM_TIMEOUT_MS,
  );

  it(
    "givenPluginForANewerApi_whenChecked_thenTheCheckFailsNamingWhy",
    async () => {
      const paths = builtSqlite((manifest) => ({ ...manifest, apiVersion: "9.0.0" }));
      const packed = npmPack(stagePlugin("sqlite", VERSION, paths.built, paths.stage), paths.root, "sqlite");

      const failure = checkPackage(packed.file);

      await expect(failure).rejects.toBeInstanceOf(PackageCheckError);
      await expect(failure).rejects.toThrow(/does not load/);
    },
    NPM_TIMEOUT_MS,
  );

  it("givenEmptyFolder_whenChecked_thenRefusedWithWhatToRunFirst", async () => {
    const paths = builtSqlite();

    await expect(checkPackages(paths.root)).rejects.toThrow(/run scripts\/plugins\/pack.ts first/);
  });
});
