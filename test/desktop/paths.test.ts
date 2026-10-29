import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appPaths } from "@table-craft/desktop/main/paths.js";

const REPOSITORY_DIST = join("/repo", "packages", "desktop", "dist");
const RESOURCES = join("/Applications", "TableCraft.app", "Contents", "Resources");
const ASAR_DIST = join(RESOURCES, "app.asar", "dist");

describe("app paths", () => {
  it("givenDevelopmentRun_whenPathsResolved_thenEverythingUnderDist", () => {
    const paths = appPaths({ isPackaged: false, resourcesPath: "/electron/Resources", distDirectory: REPOSITORY_DIST });

    expect(paths).toEqual({
      engineEntry: join(REPOSITORY_DIST, "engine", "main.js"),
      mcpEntry: join(REPOSITORY_DIST, "mcp", "main.js"),
      preload: join(REPOSITORY_DIST, "preload", "preload.cjs"),
      rendererIndex: join(REPOSITORY_DIST, "renderer", "index.html"),
      builtInPlugins: join(REPOSITORY_DIST, "resources", "plugins"),
      developmentPlugins: join(REPOSITORY_DIST, "optional-plugins"),
      icon: join("/repo", "packages", "desktop", "build", "icon.png"),
    });
  });

  it("givenPackagedRun_whenPathsResolved_thenPluginsUnderResourcesAndBundlesInAsar", () => {
    const paths = appPaths({ isPackaged: true, resourcesPath: RESOURCES, distDirectory: ASAR_DIST });

    expect(paths).toEqual({
      engineEntry: join(ASAR_DIST, "engine", "main.js"),
      mcpEntry: join(ASAR_DIST, "mcp", "main.js"),
      preload: join(ASAR_DIST, "preload", "preload.cjs"),
      rendererIndex: join(ASAR_DIST, "renderer", "index.html"),
      builtInPlugins: join(RESOURCES, "plugins"),
      developmentPlugins: null,
      icon: join(RESOURCES, "icon.png"),
    });
  });
});
