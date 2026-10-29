import { join } from "node:path";

/** Every file main hands to Electron or the engine, resolved once for where the app runs (decision 033). */
export interface AppPaths {
  readonly engineEntry: string;
  /** The MCP host, started only while Settings › MCP Server is on (decision 126). */
  readonly mcpEntry: string;
  readonly preload: string;
  readonly rendererIndex: string;
  readonly builtInPlugins: string;
  /**
   * The optional plugins `vite.plugins.config.ts` builds for development runs and smoke tests
   * (decision 108); null when packaged, where they come from npm instead.
   */
  readonly developmentPlugins: string | null;
  /** The window and dock icon; a packaged macOS app takes its `.icns` from the bundle instead. */
  readonly icon: string;
}

export interface AppPathsInput {
  readonly isPackaged: boolean;
  /** `process.resourcesPath`: the directory holding `app.asar` and, packaged, `plugins/`. */
  readonly resourcesPath: string;
  /** The `dist/` directory main was loaded from, in development or inside `app.asar`. */
  readonly distDirectory: string;
}

const ENGINE_ENTRY = "engine/main.js";
const MCP_ENTRY = "mcp/main.js";
const PRELOAD = "preload/preload.cjs";
const RENDERER_INDEX = "renderer/index.html";
/** Where `vite.plugins.config.ts` builds the built-in plugins. */
const DEVELOPMENT_PLUGINS = "resources/plugins";
/** Where `vite.plugins.config.ts` builds the optional plugins; never packaged. */
const DEVELOPMENT_OPTIONAL_PLUGINS = "optional-plugins";
/** Where electron-builder's `extraResources` puts them, outside the archive. */
const PACKAGED_PLUGINS = "plugins";
/** `build/icon.png` beside `dist/`; `extraResources` copies it to the resources directory. */
const DEVELOPMENT_ICON = "../build/icon.png";
const PACKAGED_ICON = "icon.png";

export function appPaths(input: AppPathsInput): AppPaths {
  const dist = (relative: string) => join(input.distDirectory, relative);
  return {
    engineEntry: dist(ENGINE_ENTRY),
    mcpEntry: dist(MCP_ENTRY),
    preload: dist(PRELOAD),
    rendererIndex: dist(RENDERER_INDEX),
    builtInPlugins: input.isPackaged ? join(input.resourcesPath, PACKAGED_PLUGINS) : dist(DEVELOPMENT_PLUGINS),
    developmentPlugins: input.isPackaged ? null : dist(DEVELOPMENT_OPTIONAL_PLUGINS),
    icon: input.isPackaged ? join(input.resourcesPath, PACKAGED_ICON) : dist(DEVELOPMENT_ICON),
  };
}
