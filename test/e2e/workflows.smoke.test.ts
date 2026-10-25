/**
 * Plan 014's daily loop on the development build: SQLite under `bun run test:smoke`, PostgreSQL and
 * MySQL from `test/db/compose.yml` under `bun run test:smoke:db`:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/014 bun run test:smoke:db
 *
 * The loop writes to `edit_probe`; the containers are shared with the other suites, so every run
 * puts it back.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
} from "./harness.js";
import type { RunningApp, SavedDatasource } from "./harness.js";
import { DAILY_LOOP_STEPS, dailyLoop, EDIT_PROBE_RESET, stubSaveDialog } from "./workflows.js";

const captureWindow = evidenceFor("014");
/** The loop is fifteen steps, each up to a launch's patience on a cold database. */
const LOOP_TIMEOUT_MS = SCENARIO_TIMEOUT_MS * 3;
const EXPORT_FILE = "customers.csv";

const { password: POSTGRES_PASSWORD, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;
const { password: MYSQL_PASSWORD, ...MYSQL_PLAIN } = MYSQL_CONFIG;

interface LoopDatabase {
  readonly saved: () => SavedDatasource;
  readonly namespace: string;
  readonly password?: string;
  readonly evidence: string;
  /** Puts `edit_probe` back on a shared database; a fresh SQLite file needs nothing. */
  readonly restore?: () => Promise<void>;
}

async function asOwner(plugin: DatasourcePlugin, config: unknown, statements: readonly string[]): Promise<void> {
  const session = await plugin.connect(config, { readOnly: false });
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const _row of result.rows) {
        // Drained so the statement completes before the next.
      }
    }
  } finally {
    await session.close();
  }
}

const SQLITE: LoopDatabase = {
  saved: () => ({ id: "sqlite", name: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } }),
  namespace: "main",
  evidence: "loop-sqlite",
};

const POSTGRES: LoopDatabase = {
  saved: () => ({
    id: "pg",
    name: "pg",
    pluginId: "postgres",
    config: { ...POSTGRES_PLAIN, sslMode: "disable" },
    secretModes: { password: "untilRestart" },
  }),
  namespace: "public",
  password: POSTGRES_PASSWORD,
  evidence: "loop-postgres",
  restore: () => asOwner(postgres, POSTGRES_CONFIG, EDIT_PROBE_RESET),
};

const MYSQL: LoopDatabase = {
  saved: () => ({
    id: "mysql",
    name: "mysql",
    pluginId: "mysql",
    config: { ...MYSQL_PLAIN, sslMode: "disable" },
    secretModes: { password: "untilRestart" },
  }),
  namespace: "table_craft",
  password: MYSQL_PASSWORD,
  evidence: "loop-mysql",
  restore: () => asOwner(mysql, MYSQL_CONFIG, EDIT_PROBE_RESET),
};

describe.runIf(SMOKE_ENABLED)("daily loop on the development build", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function loopOn(database: LoopDatabase): Promise<void> {
    const saved = database.saved();
    const userDataDir = newProfile();
    seedDatasources(userDataDir, [saved]);
    const folder = mkdtempSync(join(tmpdir(), "table-craft-loop-"));
    scratch.push(folder);
    const exportPath = join(folder, EXPORT_FILE);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await stubSaveDialog(running.app, exportPath);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    const target = { name: saved.name, namespace: database.namespace, exportPath };
    const steps = await dailyLoop(
      running.page,
      database.password === undefined ? target : { ...target, password: database.password },
    );
    expect(steps).toEqual(DAILY_LOOP_STEPS);
    await captureWindow(running.page, database.evidence);
  }

  async function loopAndRestore(database: LoopDatabase): Promise<void> {
    await database.restore?.();
    try {
      await loopOn(database);
    } finally {
      await database.restore?.();
    }
  }

  it(
    "givenDailyLoop_whenRunOnSqlite_thenEveryStepSucceeds",
    async () => {
      await loopAndRestore(SQLITE);
    },
    LOOP_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenDailyLoop_whenRunOnPostgres_thenEveryStepSucceeds",
    async () => {
      await loopAndRestore(POSTGRES);
    },
    LOOP_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenDailyLoop_whenRunOnMysql_thenEveryStepSucceeds",
    async () => {
      await loopAndRestore(MYSQL);
    },
    LOOP_TIMEOUT_MS,
  );
});
