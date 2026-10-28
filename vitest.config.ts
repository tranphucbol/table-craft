import { resolve } from "node:path";
import { defineConfig, type TestProjectConfiguration } from "vitest/config";
import { WORKERS_ENV } from "./test/e2e/docker/workers.js";
import { SERIAL_SMOKE_FILES } from "./test/e2e/serialFiles.js";

const WORKSPACE_ROOT = import.meta.dirname;
const TEST_FILES = ["test/**/*.test.ts"];
const DB_TEST_FILES = ["test/db/**"];
const DISPLAY_SETUP = "test/e2e/docker/display.ts";
const TEST_TIMEOUT_MS = 20_000;
/**
 * The smoke suites with databases first check that every seeded server holds its current seed,
 * then get their own TiDB database, as `test:db` does (vitest.db.config.ts).
 */
const SMOKE_DATABASE_SETUP =
  process.env.TABLE_CRAFT_SMOKE_DATABASES === "1"
    ? ["test/support/smokeFixtures.ts", "test/support/tidbScratch.ts"]
    : [];
const CODEMIRROR = resolve(WORKSPACE_ROOT, "packages/desktop/node_modules/@codemirror");
const SERIAL_FILES = Object.keys(SERIAL_SMOKE_FILES);
const SMOKE_WORKERS = Number(process.env[WORKERS_ENV] ?? "1");
/**
 * In the headless box each worker has its own display, so the smoke files run `SMOKE_WORKERS` at a
 * time, then the files that share fixtures run one by one (decision 096). Elsewhere one project.
 */
const SMOKE_PROJECTS: TestProjectConfiguration[] | undefined =
  process.env.TABLE_CRAFT_SMOKE === "1" && process.env.TABLE_CRAFT_HEADLESS === "1"
    ? [
        {
          extends: true,
          test: {
            name: "smoke-parallel",
            include: TEST_FILES,
            exclude: SERIAL_FILES,
            setupFiles: [DISPLAY_SETUP],
            maxWorkers: SMOKE_WORKERS,
            sequence: { groupOrder: 0 },
          },
        },
        {
          extends: true,
          test: {
            name: "smoke-serial",
            include: SERIAL_FILES,
            setupFiles: [DISPLAY_SETUP],
            maxWorkers: 1,
            fileParallelism: false,
            sequence: { groupOrder: 1 },
          },
        },
      ]
    : undefined;

/** One Vitest project over `test/`, two in the headless box; the packages only carry build config. */
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
      // Which kill statement a MySQL-protocol server takes (decision 058), how its warnings read
      // (decision 066), and the catalog it reads from servers without a given column or table.
      {
        find: /^@table-craft\/plugin-mysql\/(server|warnings|introspect)$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/mysql/src/$1.ts"),
      },
      // The MySQL and TiDB function list, which the list tests filter by server version (plan 052).
      {
        find: /^@table-craft\/plugin-mysql\/functions$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/mysql/src/functions/index.ts"),
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
      // Where each dialect locates a failed statement's error (decision 082).
      {
        find: /^@table-craft\/plugin-(sqlite|postgres|mysql)\/errorPosition$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/$1/src/errorPosition.ts"),
      },
      // The Redis plugin's parts, which its unit tests drive without a server (plan 058).
      {
        find: /^@table-craft\/plugin-redis\/(language|tokens|features|replies|routing|readOnly|complete|connect|apply|server|sessions|resp2|read)$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/redis/src/$1.ts"),
      },
      { find: "@table-craft/plugin-redis", replacement: resolve(WORKSPACE_ROOT, "plugins/redis/src/index.ts") },
      // The Oracle plugin's parts, which its unit tests drive without a server (plan 054).
      {
        find: /^@table-craft\/plugin-oracle\/functions$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/oracle/src/functions/index.ts"),
      },
      {
        find: /^@table-craft\/plugin-oracle\/manualIndex$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/oracle/src/functions/manualIndex.ts"),
      },
      {
        find: /^@table-craft\/plugin-oracle\/([A-Za-z]+)$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/oracle/src/$1.ts"),
      },
      { find: "@table-craft/plugin-oracle", replacement: resolve(WORKSPACE_ROOT, "plugins/oracle/src/index.ts") },
      // The SQL Server plugin's parts, which its unit tests drive without a server (plan 055).
      {
        find: "@table-craft/plugin-mssql/functions",
        replacement: resolve(WORKSPACE_ROOT, "plugins/mssql/src/functions/index.ts"),
      },
      {
        find: /^@table-craft\/plugin-mssql\/(batch|bulk|errorPosition|explain|introspect|language|messages|objects|routines|server|sessions|tls|values)$/,
        replacement: resolve(WORKSPACE_ROOT, "plugins/mssql/src/$1.ts"),
      },
      { find: "@table-craft/plugin-mssql", replacement: resolve(WORKSPACE_ROOT, "plugins/mssql/src/index.ts") },
      { find: "@table-craft/plugin-sqlite", replacement: resolve(WORKSPACE_ROOT, "plugins/sqlite/src/index.ts") },
      { find: "@table-craft/plugin-postgres", replacement: resolve(WORKSPACE_ROOT, "plugins/postgres/src/index.ts") },
      { find: "@table-craft/plugin-mysql", replacement: resolve(WORKSPACE_ROOT, "plugins/mysql/src/index.ts") },
      // CodeMirror is the renderer's dependency; renderer tests build editor states with the same copy.
      { find: /^@codemirror\/(.*)$/, replacement: `${CODEMIRROR}/$1` },
    ],
  },
  test: {
    // A project's include adds to this one, so with projects each names its own.
    include: SMOKE_PROJECTS === undefined ? TEST_FILES : [],
    // Needs Docker; `bun run test:db` runs these with their own config (decision 013).
    exclude: DB_TEST_FILES,
    globalSetup: SMOKE_DATABASE_SETUP,
    environment: "node",
    testTimeout: TEST_TIMEOUT_MS,
    projects: SMOKE_PROJECTS,
  },
});
