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
  nativeAddonStubs,
  SOURCE_ROOT,
} from "./vite.shared.js";

const OUT_FILE = "main.js";

export default defineConfig({
  plugins: [nativeAddonStubs],
  resolve: { alias: ALIASES, mainFields: NODE_MAIN_FIELDS, conditions: NODE_CONDITIONS },
  define: COMMONJS_GLOBALS,
  build: {
    target: BUILD_TARGET,
    outDir: resolve(DIST_ROOT, "engine"),
    emptyOutDir: true,
    lib: {
      entry: resolve(SOURCE_ROOT, "engine/main.ts"),
      formats: ["es"],
      fileName: () => OUT_FILE,
    },
    sourcemap: true,
    minify: false,
    // ssh2 is CommonJS and `require`s Node built-ins; only the node platform gives the ES module
    // output a `require` (see vite.plugins.config.ts).
    rolldownOptions: { platform: "node", external: NODE_EXTERNALS },
  },
});
