/**
 * Plan 149's live test: each engine imports only its datasource's plugin, in a development run
 * where every optional plugin is installed. Gated, because it needs a display, a fresh build and,
 * past SQLite, the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/149 bun run test:smoke:db:headless:all test/e2e/onePluginPerEngine.smoke.test.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ETCD35_CONFIG,
  MYSQL_CONFIG,
  POSTGRES_CONFIG,
  REDIS_CONFIG,
  WITHOUT_POSTGRES,
  WITHOUT_REDIS,
} from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  answerSecretPrompt,
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  fillNewDatasource,
  findAction,
  gridText,
  launchApp,
  LAUNCH_TIMEOUT_MS,
  newProfile,
  openConsoleOn,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  testConnection,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { seedManagedPlugin, UNREACHABLE_REGISTRY } from "./pluginFixtures.js";
import { scanned } from "./redisLive.js";

const captureWindow = evidenceFor("149");
const writeEvidence = evidenceTextFor("149");

const LOG_FILE = join("logs", "table-craft.log");
const DEBUG_SETTINGS = { version: 1, log: { level: "debug" } };
const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
const PLUGIN_RECORDS = ["plugin loaded", "plugin unavailable"];
const ENGINE_STARTED = "engine host started";
const ENGINE_PROCESS = "engine:";
const PROBE_PROCESS = "probe:";
/** What the Log tool window's search keeps: main's `plugin found` and each engine's own records. */
const LOG_SEARCH = "plugin";
/** Every plugin a development run installs: the built-ins and `dist/optional-plugins/` (decision 108). */
const EVERY_PLUGIN = ["etcd", "mssql", "mysql", "oracle", "postgres", "redis", "sqlite"];
const OPTIONAL_PLUGINS = EVERY_PLUGIN.filter((id) => id !== "mysql" && id !== "sqlite");
const ENTRY_FILE = "index.js";
/** The test etcd runs without auth, but a saved datasource still prompts once for its password. */
const NO_PASSWORD = "";
const CORRUPT_MARKER = "plan 149: corrupted etcd bundle";
const CORRUPT_ENTRY = `throw new Error(${JSON.stringify(CORRUPT_MARKER)});\n`;

const SQLITE_QUERY = "SELECT id, name FROM customers ORDER BY id";
const MYSQL_QUERY = "SELECT 1 AS answer";
const SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
const REDIS: Datasource = { id: "cache", pluginId: "redis", config: REDIS_CONFIG };

type Config = Readonly<Record<string, string | number | boolean>>;

function withoutPassword(config: Config & { readonly password: string }): Config {
  const { password: _password, ...plain } = config;
  return plain;
}

const MYSQL_SAVED: SavedDatasource = {
  id: "orders",
  name: "orders",
  pluginId: "mysql",
  config: { ...withoutPassword(MYSQL_CONFIG), sslMode: "disable" },
  secretModes: { password: "untilRestart" },
};
const ETCD_SAVED: SavedDatasource = { id: "kv", name: "kv", pluginId: "etcd", config: { ...ETCD35_CONFIG } };

interface LoggedLine {
  readonly ts: string;
  readonly level: string;
  readonly process: string;
  readonly scope: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

function logLines(userDataDir: string): { readonly raw: string; readonly line: LoggedLine }[] {
  const text = readProfileFile(userDataDir, LOG_FILE) ?? "";
  return text
    .split("\n")
    .filter((raw) => raw !== "")
    .map((raw) => ({ raw, line: JSON.parse(raw) as LoggedLine }));
}

function pluginRecords(userDataDir: string, process: (name: string) => boolean) {
  return logLines(userDataDir).filter(({ line }) => PLUGIN_RECORDS.includes(line.msg) && process(line.process));
}

function engineOf(datasourceId: string): (name: string) => boolean {
  return (name) => name === `${ENGINE_PROCESS}${datasourceId}`;
}

/** `[msg, pluginId]` of each plugin record an engine or probe wrote. */
function recordsOf(userDataDir: string, process: (name: string) => boolean): [string, unknown][] {
  return pluginRecords(userDataDir, process).map(({ line }) => [line.msg, line["pluginId"]]);
}

/** The plugin ids main reported at launch, once for the whole app. */
function mainFound(userDataDir: string): string[] {
  return logLines(userDataDir)
    .filter(({ line }) => line.msg === "plugin found")
    .map(({ line }) => String(line["id"]))
    .sort();
}

/** Milliseconds from main spawning `datasourceId`'s engine to that engine's last plugin record. */
function pluginLoadMs(userDataDir: string, datasourceId: string): number | null {
  const lines = logLines(userDataDir);
  const started = lines.find(({ line }) => line.msg === ENGINE_STARTED && line["datasourceId"] === datasourceId);
  const last = pluginRecords(userDataDir, engineOf(datasourceId)).at(-1);
  if (started === undefined || last === undefined) return null;
  return Date.parse(last.line.ts) - Date.parse(started.line.ts);
}

/** The engine's working set in KB, as main's `app.getAppMetrics` reports it. */
async function engineMemoryKb(app: ElectronApplication, datasourceId: string): Promise<number | null> {
  return app.evaluate(
    ({ app: electronApp }, name) =>
      electronApp.getAppMetrics().find((metric) => metric.name === name)?.memory.workingSetSize ?? null,
    `table-craft-engine-${datasourceId}`,
  );
}

function excerpt(file: string, userDataDir: string, process: (name: string) => boolean, extra = ""): void {
  const raws = pluginRecords(userDataDir, process).map(({ raw }) => raw);
  const found = logLines(userDataDir)
    .filter(({ line }) => line.msg === "plugin found")
    .map(({ raw }) => raw);
  writeEvidence(
    file,
    `# main, once at launch (${String(found.length)} records)\n${found.join("\n")}\n\n` +
      `# engine plugin records\n${raws.join("\n")}\n${extra}`,
  );
}

/** Shows the plugin records in the Log tool window, with the newest `selected` record opened whole. */
async function showPluginLog(page: Page, selected: string): Promise<void> {
  await findAction(page, "Show Log");
  const log = toolWindow(page, "Log");
  await log.waitFor();
  await chooseOption(log.getByLabel("Level", { exact: true }), "debug");
  await log.getByLabel("Search log", { exact: true }).fill(LOG_SEARCH);
  await log.getByRole("log", { name: "Log records" }).getByRole("button").filter({ hasText: selected }).first().click();
  await log.getByLabel("Log record", { exact: true }).waitFor();
}

describe.runIf(SMOKE_ENABLED)("plan 149: one plugin per engine", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(
    datasource: Datasource | null,
    userDataDir: string,
    env?: Readonly<Record<string, string>>,
  ): Promise<Page> {
    running = await launchApp(datasource, { userDataDir, ...(env === undefined ? {} : { env }) });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  function debugProfile(saved: readonly SavedDatasource[] = [], settings: object = {}): string {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { ...DEBUG_SETTINGS, ...settings });
    if (saved.length > 0) seedDatasources(userDataDir, saved);
    return userDataDir;
  }

  it(
    "givenEveryPluginInstalled_whenSqliteOpened_thenItsEngineLoadsOnlySqlite",
    async () => {
      const userDataDir = debugProfile();
      const page = await launch(SQLITE, userDataDir);
      await runStatement(page, SQLITE_QUERY);
      expect((await gridText(page)).headers).toEqual(expect.arrayContaining(["id", "name"]));

      await expect.poll(() => mainFound(userDataDir), { timeout: LAUNCH_TIMEOUT_MS }).toEqual(EVERY_PLUGIN);
      await expect
        .poll(() => recordsOf(userDataDir, engineOf(SQLITE.id)), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([["plugin loaded", "sqlite"]]);

      const memory = running === null ? null : await engineMemoryKb(running.app, SQLITE.id);
      const loadMs = pluginLoadMs(userDataDir, SQLITE.id);
      await showPluginLog(page, "plugin loaded");
      await captureWindow(page, "01-sqlite-log");
      excerpt(
        "01-sqlite-log.log",
        userDataDir,
        engineOf(SQLITE.id),
        `\n# engine:${SQLITE.id} working set ${String(memory)} KB; spawn to last plugin record ${String(loadMs)} ms\n`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenSqliteOpen_whenMysqlOpenedBesideIt_thenEachEngineLoadsOnlyItsOwnAndBothRun",
    async () => {
      const userDataDir = debugProfile([MYSQL_SAVED]);
      const page = await launch(SQLITE, userDataDir);
      await runStatement(page, SQLITE_QUERY);

      await openConsoleOn(page, MYSQL_SAVED.name);
      await answerSecretPrompt(page, MYSQL_SAVED.name, MYSQL_CONFIG.password);
      await runStatement(page, MYSQL_QUERY);
      expect((await gridText(page)).headers).toEqual(["answer"]);

      await expect
        .poll(() => recordsOf(userDataDir, engineOf(MYSQL_SAVED.id)), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([["plugin loaded", "mysql"]]);
      expect(recordsOf(userDataDir, engineOf(SQLITE.id))).toEqual([["plugin loaded", "sqlite"]]);

      await showPluginLog(page, "plugin loaded");
      await captureWindow(page, "02-mysql-log");
      excerpt(
        "02-mysql-log.log",
        userDataDir,
        (name) => name === `${ENGINE_PROCESS}${SQLITE.id}` || name === `${ENGINE_PROCESS}${MYSQL_SAVED.id}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED && !WITHOUT_REDIS)(
    "givenOptionalRedis_whenOpened_thenItsEngineLoadsOnlyRedisAndKeysLoad",
    async () => {
      const userDataDir = debugProfile();
      const page = await launch(REDIS, userDataDir);
      await scanned(page, /^db0/);

      await expect
        .poll(() => recordsOf(userDataDir, engineOf(REDIS.id)), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([["plugin loaded", "redis"]]);

      await showPluginLog(page, "plugin loaded");
      await captureWindow(page, "03-redis-log");
      excerpt("03-redis-log.log", userDataDir, engineOf(REDIS.id));
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED && !WITHOUT_POSTGRES)(
    "givenNewPostgres_whenTestConnection_thenTheProbeLoadsOnlyPostgres",
    async () => {
      const userDataDir = debugProfile();
      const page = await launch(null, userDataDir);
      await fillNewDatasource(page, {
        kind: "PostgreSQL",
        name: "probe-target",
        fields: {
          Host: POSTGRES_CONFIG.host,
          Port: String(POSTGRES_CONFIG.port),
          Database: POSTGRES_CONFIG.database,
          User: POSTGRES_CONFIG.user,
        },
        password: POSTGRES_CONFIG.password,
      });
      const tested = await testConnection(page);
      expect(tested.ok, tested.text).toBe(true);

      const probe = (name: string) => name.startsWith(PROBE_PROCESS);
      await expect
        .poll(() => recordsOf(userDataDir, probe), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([["plugin loaded", "postgres"]]);

      await captureWindow(page, "04-probe");
      excerpt("04-probe.log", userDataDir, probe);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCorruptEtcdInProfile_whenSqliteAndEtcdOpened_thenSqliteConnectsAndEtcdIsUnavailable",
    async () => {
      const userDataDir = debugProfile([ETCD_SAVED], { plugins: { registryUrl: UNREACHABLE_REGISTRY } });
      for (const id of OPTIONAL_PLUGINS) seedManagedPlugin(userDataDir, id);
      writeFileSync(join(userDataDir, "managed-plugins", "etcd", "0.0.0", ENTRY_FILE), CORRUPT_ENTRY);

      const page = await launch(SQLITE, userDataDir, NO_OPTIONAL_ROOT);
      await runStatement(page, SQLITE_QUERY);
      expect((await gridText(page)).headers).toEqual(expect.arrayContaining(["id", "name"]));
      await expect.poll(() => mainFound(userDataDir), { timeout: LAUNCH_TIMEOUT_MS }).toEqual(EVERY_PLUGIN);
      expect(recordsOf(userDataDir, engineOf(SQLITE.id))).toEqual([["plugin loaded", "sqlite"]]);

      await treeNode(page, ETCD_SAVED.name).click();
      await page.keyboard.press("ArrowRight");
      await answerSecretPrompt(page, ETCD_SAVED.name, NO_PASSWORD);
      await expect
        .poll(() => recordsOf(userDataDir, engineOf(ETCD_SAVED.id)), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([["plugin unavailable", "etcd"]]);
      const failed = treeNode(page, ETCD_SAVED.name);
      await expect
        .poll(() => failed.getAttribute("title"), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/^Plugin "etcd" is unavailable: /);
      expect(await failed.getAttribute("title")).toContain(CORRUPT_MARKER);
      expect(await failed.getAttribute("aria-label")).toBe(`${ETCD_SAVED.name}, failed`);
      expect(readProfileFile(userDataDir, LOG_FILE)).not.toMatch(
        new RegExp(`"process":"${ENGINE_PROCESS}${SQLITE.id}"[^\\n]*${CORRUPT_MARKER}`),
      );

      await showPluginLog(page, "plugin unavailable");
      await captureWindow(page, "05-broken-other");
      excerpt(
        "05-broken-other.log",
        userDataDir,
        (name) => name === `${ENGINE_PROCESS}${SQLITE.id}` || name === `${ENGINE_PROCESS}${ETCD_SAVED.id}`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );
});
