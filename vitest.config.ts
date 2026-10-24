import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const WORKSPACE_ROOT = import.meta.dirname;
const TEST_FILES = ["test/**/*.test.ts"];
const DB_TEST_FILES = ["test/db/**"];
const TEST_TIMEOUT_MS = 20_000;
/** The smoke suites with databases get their own TiDB database, as `test:db` does (vitest.db.config.ts). */
const TIDB_SCRATCH_SETUP = process.env.TABLE_CRAFT_SMOKE_DATABASES === "1" ? ["test/support/tidbScratch.ts"] : [];
const CODEMIRROR = resolve(WORKSPACE_ROOT, "packages/desktop/node_modules/@codemirror");

/** One Vitest project over `test/`; the packages only carry build config. */
export default defineConfig({
  resolve: {
    alias: [
      { find: "@table-craft/plugin-api", replacement: resolve(WORKSPACE_ROOT, "packages/plugin-api/src") },
      { find: "@table-craft/core", replacement: resolve(WORKSPACE_ROOT, "packages/core/src") },
      { find: "@table-craft/desktop", replacement: resolve(WORKSPACE_ROOT, "packages/desktop/src") },
      // The plan readers, which the plan-reader tests feed captured EXPLAIN output (plan 012).
      {
        find: /^@table-craft\/plugin-(sqlite|postgres|mysql)\/explain$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/$1/src/explain.ts"),
      },
      // The bulk writers' row encoders, which the encoder tests feed exporter text (plan 021).
      {
        find: /^@table-craft\/plugin-(postgres|mysql)\/bulk$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/$1/src/bulk.ts"),
      },
      // Which kill statement a MySQL-protocol server takes (decision 058), and how its warnings read (decision 066).
      {
        find: /^@table-craft\/plugin-mysql\/(server|warnings)$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/mysql/src/$1.ts"),
      },
      {
        find: /^@table-craft\/plugin-postgres\/notices$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/postgres/src/notices.ts"),
      },
      // The session-list readers, which the row tests feed captured server rows (plan 045).
      {
        find: /^@table-craft\/plugin-(postgres|mysql)\/sessions$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/$1/src/sessions.ts"),
      },
      { find: "@table-craft/plugin-sqlite", replacement: resolve(WORKSPACE_ROOT, "plugins/sqlite/src/index.ts") },
      { find: "@table-craft/plugin-postgres", replacement: resolve(WORKSPACE_ROOT, "plugins/postgres/src/index.ts") },
      { find: "@table-craft/plugin-mysql", replacement: resolve(WORKSPACE_ROOT, "plugins/mysql/src/index.ts") },
      // CodeMirror is the renderer's dependency; renderer tests build editor states with the same copy.
      { find: /^@codemirror\/(.*)$/, replacement: `${CODEMIRROR}/$1` },
    ],
  },
  test: {
    include: TEST_FILES,
    // Needs Docker; `bun run test:db` runs these with their own config (decision 013).
    exclude: DB_TEST_FILES,
    globalSetup: TIDB_SCRATCH_SETUP,
    environment: "node",
    testTimeout: TEST_TIMEOUT_MS,
  },
});
