/**
 * Builds each built-in plugin into `dist/resources/plugins/<id>/`, and each optional one into
 * `dist/optional-plugins/<id>/`, beside its manifest, so the engine finds it through the same
 * loader as a user plugin (decision 005) and never imports it.
 */
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import {
  ALIASES,
  BUILD_TARGET,
  DIST_ROOT,
  NODE_CONDITIONS,
  NODE_EXTERNALS,
  NODE_MAIN_FIELDS,
  REPOSITORY_ROOT,
} from "./vite.shared.js";

/** Shipped inside every installer (decision 108). */
export const BUILT_IN_PLUGINS = ["sqlite", "mysql"] as const;
/**
 * Published to npm and downloaded on demand (decisions 108-110). A development run and the smoke
 * harness load them from `dist/optional-plugins/`; the packaged app never does.
 */
export const OPTIONAL_PLUGINS = ["postgres", "redis", "oracle", "mssql", "etcd"] as const;
type BuiltPlugin = (typeof BUILT_IN_PLUGINS)[number] | (typeof OPTIONAL_PLUGINS)[number];
/** pg's optional libpq binding; pg only loads it when asked for `pg.native`, which no plugin does. */
const OPTIONAL_DRIVER_MODULES = ["pg-native"];
const PLUGINS_SOURCE_ROOT = resolve(REPOSITORY_ROOT, "plugins");
const BUILT_IN_OUT_DIR = resolve(DIST_ROOT, "resources/plugins");
/** Outside `dist/resources`, so electron-builder's `extraResources` never copies them. */
export const OPTIONAL_OUT_DIR = resolve(DIST_ROOT, "optional-plugins");
const PLUGIN_ENTRY_FILE = "index.js";
const PLUGIN_SOURCE_ENTRY = "src/index.ts";
/** Mirrors `MANIFEST_FILE` in plugin-api; a Vite config loads in plain Node and cannot import TypeScript source. */
const MANIFEST_FILE = "table-craft-plugin.json";

function copyManifest(id: BuiltPlugin, outDir: string): Plugin {
  return {
    name: "table-craft:copy-plugin-manifest",
    async writeBundle() {
      await copyFile(resolve(PLUGINS_SOURCE_ROOT, id, MANIFEST_FILE), resolve(outDir, MANIFEST_FILE));
    },
  };
}

function isBuiltInPlugin(mode: string): mode is (typeof BUILT_IN_PLUGINS)[number] {
  return (BUILT_IN_PLUGINS as readonly string[]).includes(mode);
}

function isBuiltPlugin(mode: string): mode is BuiltPlugin {
  return isBuiltInPlugin(mode) || (OPTIONAL_PLUGINS as readonly string[]).includes(mode);
}

/**
 * One build per plugin, chosen by `--mode <id>`: with code splitting off, Rolldown takes a single
 * input, and splitting has to stay off because a chunk shared between two plugins would land
 * outside both directories, where the loader refuses to follow it (decision 005).
 */
export default defineConfig(({ mode }) => {
  if (!isBuiltPlugin(mode)) {
    const ids = [...BUILT_IN_PLUGINS, ...OPTIONAL_PLUGINS].join(", ");
    throw new Error(`Build one plugin with --mode <id>, one of: ${ids}.`);
  }
  const outDir = resolve(isBuiltInPlugin(mode) ? BUILT_IN_OUT_DIR : OPTIONAL_OUT_DIR, mode);
  return {
    plugins: [copyManifest(mode, outDir)],
    resolve: { alias: ALIASES, mainFields: NODE_MAIN_FIELDS, conditions: NODE_CONDITIONS },
    build: {
      target: BUILD_TARGET,
      outDir,
      emptyOutDir: true,
      lib: {
        entry: resolve(PLUGINS_SOURCE_ROOT, mode, PLUGIN_SOURCE_ENTRY),
        formats: ["es"],
        fileName: () => PLUGIN_ENTRY_FILE,
      },
      sourcemap: true,
      minify: false,
      rolldownOptions: {
        // pg and mysql2 are CommonJS and `require` Node built-ins lazily. Only the node platform
        // gives the ES module output a `require` (from `module.createRequire`); without it the
        // bundle imports fine and then fails on its first connect.
        platform: "node",
        external: [...NODE_EXTERNALS, ...OPTIONAL_DRIVER_MODULES],
        output: { codeSplitting: false },
      },
    },
  };
});
