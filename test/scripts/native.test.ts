import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import { checkPackage, PackageCheckError } from "../../scripts/plugins/check.js";
import { fetchBinding, lockedPackage, type NativeBinding } from "../../scripts/plugins/native.js";
import { npmPack, stageNativePlugin } from "../../scripts/plugins/pack.js";
import { sha512, tarball } from "../support/pluginRegistry.js";

const VERSION = "1.4.2";
const NPM_TIMEOUT_MS = 60_000;
const LINUX = "linux-x64";
const LICENSE = "MIT License\n\nCopyright DuckDB Labs\n";

function binding(files: readonly string[]): NativeBinding {
  return {
    packageName: `@duckdb/node-bindings-${LINUX}`,
    version: "2.0.0-r.1",
    files: files.map((path) => ({ path, data: Buffer.from(`${path} bytes`) })),
    license: LICENSE,
  };
}

describe("native plugin packages", () => {
  const scratch: string[] = [];

  afterEach(() => {
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  /** A build output holding the DuckDB manifest and a stand-in bundle as `built/duckdb/`. */
  function builtDuckdb() {
    const root = mkdtempSync(join(tmpdir(), "table-craft-native-"));
    scratch.push(root);
    const built = join(root, "built");
    mkdirSync(join(built, "duckdb"), { recursive: true });
    writeFileSync(join(built, "duckdb", "index.js"), "export default {};\n");
    writeFileSync(join(built, "duckdb", MANIFEST_FILE), readFileSync(join("plugins", "duckdb", MANIFEST_FILE)));
    return { root, built, stage: join(root, "stage") };
  }

  it(
    "givenNativePlugin_whenPackedForAPlatform_thenItsPackageNamesThePlatformAndCarriesItsBinding",
    () => {
      const paths = builtDuckdb();

      const directory = stageNativePlugin(
        "duckdb",
        LINUX,
        VERSION,
        paths.built,
        paths.stage,
        binding(["duckdb.node", "libduckdb.so"]),
      );
      const packed = npmPack(directory, paths.root, "duckdb");

      const json = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
      expect(json).toMatchObject({
        name: `@tablecraft-app/plugin-duckdb-${LINUX}`,
        os: ["linux"],
        cpu: ["x64"],
        tableCraft: { id: "duckdb", platform: LINUX },
      });
      expect(json).not.toHaveProperty("dependencies");
      expect(json).not.toHaveProperty("scripts");
      expect(packed.files).toEqual(
        [
          "LICENSE",
          "README.md",
          "THIRD-PARTY-NOTICES",
          "duckdb.node",
          "index.js",
          "libduckdb.so",
          "package.json",
          MANIFEST_FILE,
        ].sort(),
      );
      expect(readFileSync(join(directory, "THIRD-PARTY-NOTICES"), "utf8")).toContain("Copyright DuckDB Labs");
    },
    NPM_TIMEOUT_MS,
  );

  it(
    "givenNativePackageWithoutItsLibrary_whenChecked_thenRefusedNamingTheMissingFile",
    async () => {
      const paths = builtDuckdb();
      const directory = stageNativePlugin("duckdb", LINUX, VERSION, paths.built, paths.stage, binding(["duckdb.node"]));
      const packed = npmPack(directory, paths.root, "duckdb");

      const failure = checkPackage(packed.file);

      await expect(failure).rejects.toBeInstanceOf(PackageCheckError);
      await expect(failure).rejects.toThrow(/lacks libduckdb\.so/);
    },
    NPM_TIMEOUT_MS,
  );

  it("givenPlatformTheCatalogDoesNotList_whenStaged_thenRefused", () => {
    const paths = builtDuckdb();

    expect(() =>
      stageNativePlugin("duckdb", "freebsd-x64", VERSION, paths.built, paths.stage, binding(["duckdb.node"])),
    ).toThrow(/not published for freebsd-x64/);
  });

  it("givenLockfile_whenBindingLookedUp_thenItsPinnedVersionAndSha512", () => {
    const locked = lockedPackage(readFileSync("bun.lock", "utf8"), `@duckdb/node-bindings-${LINUX}`);

    expect(locked.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(locked.integrity).toMatch(/^sha512-/);
  });

  it("givenDownloadNotMatchingTheLockfile_whenFetched_thenRefusedAndNothingCached", async () => {
    const cache = mkdtempSync(join(tmpdir(), "table-craft-native-cache-"));
    scratch.push(cache);
    const bytes = tarball([{ path: "package/duckdb.node", data: "binary" }]);
    const name = `@duckdb/node-bindings-${LINUX}`;
    const lock = `    "${name}": ["${name}@2.0.0", "", { "os": "linux" }, "sha512-${"A".repeat(86)}=="],\n`;

    const failure = fetchBinding("duckdb", LINUX, {
      registry: "http://127.0.0.1:9",
      fetch: () => Promise.resolve(new Response(bytes)),
      cache,
      lock,
    });

    await expect(failure).rejects.toBeInstanceOf(PluginInstallError);
    expect(sha512(bytes)).not.toBe(lockedPackage(lock, name).integrity);
    expect(readdirSync(cache)).toEqual([]);
  });
});
