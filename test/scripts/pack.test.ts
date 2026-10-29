import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { readPackageTarball } from "@table-craft/desktop/main/pluginStore/tarball.js";
import { checkPackage, checkPackages, PackageCheckError } from "../../scripts/plugins/check.js";
import { npmPack, packAll, PLUGIN_KEYWORD, stagePlugin } from "../../scripts/plugins/pack.js";
import { pluginPackageName, release, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";

const FROZEN_SQLITE = join(import.meta.dirname, "..", "support", "frozen-plugins", "sqlite-1.0.0");
const VERSION = "1.4.2";
const PACKED_FILES = ["LICENSE", "README.md", "index.js", "package.json", MANIFEST_FILE];
const NPM_TIMEOUT_MS = 60_000;
const BETA = "1.5.0-beta.1";
const SQLITE = pluginPackageName("sqlite");

describe("plugin packages", () => {
  const scratch: string[] = [];
  let registry: LoopbackRegistry | undefined;

  afterEach(async () => {
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
    await registry?.close();
    registry = undefined;
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
      name: "@tablecraft-app/plugin-sqlite",
      version: VERSION,
      type: "module",
      main: "index.js",
      license: "MIT",
      tableCraft: { id: "sqlite", apiVersion: "1.0.0" },
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

      expect(packed).toMatchObject({ name: "@tablecraft-app/plugin-sqlite", version: VERSION, pluginId: "sqlite" });
      expect(packed.file).toBe(join(paths.root, `tablecraft-app-plugin-sqlite-${VERSION}.tgz`));
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
        name: "@tablecraft-app/plugin-sqlite",
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

  /** The frozen SQLite plugin packed at `version`, as npm would hold it. */
  function published(paths: ReturnType<typeof builtSqlite>, version: string) {
    const packed = npmPack(
      stagePlugin("sqlite", version, paths.built, join(paths.root, "published-stage")),
      paths.root,
      "sqlite",
    );
    return release({ id: "sqlite", version }, undefined, readFileSync(packed.file));
  }

  function packBeta(
    paths: ReturnType<typeof builtSqlite>,
    url: string,
    warn?: (line: string) => void,
    offlineOk = false,
  ) {
    return packAll({
      version: BETA,
      out: paths.out,
      build: false,
      built: paths.built,
      ids: ["sqlite"],
      reuse: { registry: url, fetch, offlineOk, ...(warn === undefined ? {} : { warn }) },
    });
  }

  it(
    "givenUnchangedPlugin_whenPackReuse_thenAttachesPublishedTarball",
    async () => {
      const paths = builtSqlite();
      const stable = published(paths, VERSION);
      registry = await startRegistry({ [SQLITE]: [stable] });

      const [packed] = await packBeta(paths, registry.url);

      expect(packed).toMatchObject({ name: SQLITE, version: VERSION, reused: true });
      expect(readdirSync(paths.out)).toEqual([`tablecraft-app-plugin-sqlite-${VERSION}.tgz`]);
      expect(readFileSync(packed?.file ?? "").equals(stable.bytes)).toBe(true);
      await expect(checkPackage(packed?.file ?? "")).resolves.toMatchObject({ version: VERSION });
    },
    NPM_TIMEOUT_MS,
  );

  it(
    "givenChangedPlugin_whenPackReuse_thenPacksReleaseVersion",
    async () => {
      const paths = builtSqlite();
      registry = await startRegistry({ [SQLITE]: [release({ id: "sqlite", version: VERSION })] });

      const [packed] = await packBeta(paths, registry.url);

      expect(packed).toMatchObject({ name: SQLITE, version: BETA, reused: false });
      expect(readdirSync(paths.out)).toEqual([`tablecraft-app-plugin-sqlite-${BETA}.tgz`]);
    },
    NPM_TIMEOUT_MS,
  );

  it(
    "givenBetaRelease_whenPack_thenNoPluginApi",
    async () => {
      const paths = builtSqlite();
      registry = await startRegistry();

      const packed = await packBeta(paths, registry.url);

      expect(packed.map((entry) => entry.name)).toEqual([SQLITE]);
    },
    NPM_TIMEOUT_MS,
  );

  it(
    "givenRegistryDownOnABranch_whenPackReuse_thenWarnsAndPacksFresh",
    async () => {
      const paths = builtSqlite();
      registry = await startRegistry();
      const { url } = registry;
      await registry.close();
      registry = undefined;
      const warnings: string[] = [];

      const [packed] = await packBeta(paths, url, (line) => warnings.push(line), true);

      expect(packed).toMatchObject({ version: BETA, reused: false });
      expect(warnings).toEqual([expect.stringContaining("could not be reached")]);
    },
    NPM_TIMEOUT_MS,
  );

  it(
    "givenRegistryDownOnATag_whenPackReuse_thenFails",
    async () => {
      const paths = builtSqlite();
      registry = await startRegistry();
      const { url } = registry;
      await registry.close();
      registry = undefined;

      await expect(packBeta(paths, url)).rejects.toMatchObject({ failure: "offline" });
    },
    NPM_TIMEOUT_MS,
  );
});
