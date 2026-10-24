import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

const DB_TEST_FILES = ["test/db/**/*.test.ts"];
/** A cancel case waits on a statement that sleeps; a cold container answers its first query slowly. */
const DB_TEST_TIMEOUT_MS = 60_000;
/** The run's own TiDB database, so a shared TiDB keeps its data (test/db/tidbTarget.ts). */
const TIDB_SCRATCH_SETUP = "test/support/tidbScratch.ts";

/** The contract suite against the `test/db/compose.yml` databases; `bun run test:db` starts them first. */
export default defineConfig({
  resolve: base.resolve,
  test: {
    include: DB_TEST_FILES,
    globalSetup: [TIDB_SCRATCH_SETUP],
    environment: "node",
    testTimeout: DB_TEST_TIMEOUT_MS,
    hookTimeout: DB_TEST_TIMEOUT_MS,
  },
});
