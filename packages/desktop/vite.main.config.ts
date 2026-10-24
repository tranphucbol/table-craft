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
/** The live test's build (plan 020); `src/main/update/build.ts` reads it, the release workflow refuses it. */
const UPDATE_TEST_BUILD = process.env.TABLE_CRAFT_UPDATE_TEST_BUILD === "1";

export default defineConfig({
  plugins: [nativeAddonStubs],
  resolve: { alias: ALIASES, mainFields: NODE_MAIN_FIELDS, conditions: NODE_CONDITIONS },
  define: { ...COMMONJS_GLOBALS, __TABLE_CRAFT_UPDATE_TEST_BUILD__: JSON.stringify(UPDATE_TEST_BUILD) },
  build: {
    target: BUILD_TARGET,
    outDir: resolve(DIST_ROOT, "main"),
    emptyOutDir: true,
    lib: {
      entry: resolve(SOURCE_ROOT, "main/main.ts"),
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
