import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { listPackage } from "@electron/asar";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import { packagedExecutable } from "../../packages/desktop/scripts/packaged-executable.js";
import { BUILT_IN_PLUGINS, OPTIONAL_PLUGINS } from "../../packages/desktop/vite.plugins.config.js";

const EXECUTABLE = packagedExecutable(process.platform, process.arch);
/** macOS keeps resources in `Contents/Resources`, beside `Contents/MacOS`; the others beside the executable. */
const RESOURCES =
  process.platform === "darwin" ? join(dirname(EXECUTABLE), "..", "Resources") : join(dirname(EXECUTABLE), "resources");
const ARCHIVE = join(RESOURCES, "app.asar");
const BUNDLES = [
  "dist/main/main.js",
  "dist/engine/main.js",
  "dist/mcp/main.js",
  "dist/preload/preload.cjs",
  "dist/renderer/index.html",
];

/** `bun run desktop:package:dir` builds the app these read; without it there is nothing to list. */
const PACKAGED = existsSync(ARCHIVE);

function archiveEntries(): string[] {
  return listPackage(ARCHIVE, { isPack: false }).map((entry) => entry.split(sep).join("/").replace(/^\//, ""));
}

describe.skipIf(!PACKAGED)("packaged app", () => {
  it("givenPackagedApp_whenListed_thenBundlesInTheArchive", () => {
    expect(archiveEntries()).toEqual(expect.arrayContaining(BUNDLES));
  });

  it("givenPackagedApp_whenListed_thenNoNodeModulesAndNoSourceMaps", () => {
    const entries = archiveEntries();

    expect(entries.filter((entry) => entry.split("/").includes("node_modules"))).toEqual([]);
    expect(entries.filter((entry) => entry.endsWith(".map"))).toEqual([]);
  });

  it("givenPackagedApp_whenListed_thenEveryBuiltInPluginBesideTheArchive", () => {
    for (const plugin of BUILT_IN_PLUGINS) {
      expect(existsSync(join(RESOURCES, "plugins", plugin, MANIFEST_FILE)), plugin).toBe(true);
      expect(existsSync(join(RESOURCES, "plugins", plugin, "index.js.map")), plugin).toBe(false);
    }
  });

  it("givenPackagedApp_whenListed_thenNoOptionalPluginBesideOrInsideTheArchive", () => {
    const entries = archiveEntries();
    for (const plugin of OPTIONAL_PLUGINS) {
      expect(existsSync(join(RESOURCES, "plugins", plugin)), plugin).toBe(false);
    }
    expect(entries.filter((entry) => entry.startsWith("dist/optional-plugins/"))).toEqual([]);
  });
});
