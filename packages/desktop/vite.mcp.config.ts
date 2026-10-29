import { resolve } from "node:path";
import { defineConfig } from "vite";
import {
  ALIASES,
  BUILD_TARGET,
  COMMONJS_GLOBALS,
  DIST_ROOT,
  NODE_CONDITIONS,
  NODE_EXTERNALS,
  NODE_MAIN_FIELDS,
  SOURCE_ROOT,
} from "./vite.shared.js";

const OUT_FILE = "main.js";

/** The MCP host (decision 126): Node only, no plugin and no driver, so no native addon stubs. */
export default defineConfig({
  resolve: { alias: ALIASES, mainFields: NODE_MAIN_FIELDS, conditions: NODE_CONDITIONS },
  define: COMMONJS_GLOBALS,
  build: {
    target: BUILD_TARGET,
    outDir: resolve(DIST_ROOT, "mcp"),
    emptyOutDir: true,
    lib: {
      entry: resolve(SOURCE_ROOT, "mcp/main.ts"),
      formats: ["es"],
      fileName: () => OUT_FILE,
    },
    sourcemap: true,
    minify: false,
    rolldownOptions: { platform: "node", external: NODE_EXTERNALS },
  },
});
