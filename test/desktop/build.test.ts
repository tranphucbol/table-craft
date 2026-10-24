import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import type { UserConfig } from "vite";
import engineConfig from "../../packages/desktop/vite.engine.config.js";
import mainConfig from "../../packages/desktop/vite.main.config.js";
import { BUILT_IN_PLUGINS } from "../../packages/desktop/vite.plugins.config.js";
import { COMMONJS_GLOBALS } from "../../packages/desktop/vite.shared.js";

const PLUGINS_ROOT = new URL("../../plugins/", import.meta.url);
const DESKTOP_PACKAGE = new URL("../../packages/desktop/package.json", import.meta.url);

async function pluginDirectories(): Promise<string[]> {
  const entries = await readdir(PLUGINS_ROOT, { withFileTypes: true });
  const withManifest = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const files = await readdir(new URL(`${entry.name}/`, PLUGINS_ROOT));
        return files.includes(MANIFEST_FILE) ? entry.name : null;
      }),
  );
  return withManifest.filter((name) => name !== null);
}

describe("desktop build", () => {
  it("givenPluginDirectories_whenComparedWithBuiltInList_thenEveryPluginIsBuilt", async () => {
    expect([...BUILT_IN_PLUGINS].sort()).toEqual((await pluginDirectories()).sort());
  });

  it("givenBuildScript_whenRead_thenBuildsEveryBuiltInPlugin", async () => {
    const manifest = JSON.parse(await readFile(DESKTOP_PACKAGE, "utf8")) as { scripts: { build: string } };
    for (const id of BUILT_IN_PLUGINS) {
      expect(manifest.scripts.build).toContain(`--config vite.plugins.config.ts --mode ${id}`);
    }
  });

  it("givenMainAndEngineBundles_whenConfigured_thenBuiltForNodeSoInlinedCommonJsLoads", () => {
    for (const config of [engineConfig, mainConfig] as UserConfig[]) {
      expect(config.build?.rolldownOptions?.platform).toBe("node");
      expect(config.define).toMatchObject(COMMONJS_GLOBALS);
    }
  });
});
