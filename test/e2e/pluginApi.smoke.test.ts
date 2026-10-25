/**
 * Plan 056's live test: the app on plugin API 1.0.0, a user plugin built for it, and the plugins
 * the semver rule refuses. Gated with the other smoke tests; the MySQL scenario needs the
 * `test/db` containers:
 *
 *   bun run test:smoke:headless test/e2e/pluginApi.smoke.test.ts
 *   bun run test:smoke:db:headless test/e2e/pluginApi.smoke.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_VERSION, parseVersion } from "@table-craft/plugin-api";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedPlugin,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("056");
const writeEvidence = evidenceTextFor("056");

const FROZEN_DIRECTORY = join(import.meta.dirname, "../support/frozen-plugins/sqlite-1.0.0");
const MANIFEST_FILE = "table-craft-plugin.json";
const ENTRY_FILE = "index.js";
/** The bundle's own id constant; a copy under another id must change it with the manifest. */
const BUNDLED_ID = 'var PLUGIN_ID = "sqlite";';
const LOG_FILE = join("logs", "table-craft.log");
const BUILT_IN_IDS = ["mysql", "postgres", "sqlite"];

const HOST = parseVersion(API_VERSION);
const NEWER_MINOR = `${HOST?.major ?? 1}.99.0`;
const OLDER_MAJOR = "0.28.0";

const QUERY = "SELECT id, name FROM customers ORDER BY id";
const QUERY_HEADERS = ["id", "name"];
/** Any count: suites running beside this one add tables to the shared MySQL database. */
const TABLES = /^tables \d+$/;

interface UserPlugin {
  readonly id: string;
  readonly name: string;
  readonly apiVersion: string;
}

const FROZEN_COPY: UserPlugin = { id: "frozen-sqlite", name: "Frozen SQLite", apiVersion: "1.0.0" };
const NEWER: UserPlugin = { id: "future-sqlite", name: "Future SQLite", apiVersion: NEWER_MINOR };
const OLDER: UserPlugin = { id: "legacy-sqlite", name: "Legacy SQLite", apiVersion: OLDER_MAJOR };

/** The frozen SQLite plugin rewritten to `plugin`'s id, name and API version, as a third party would ship it. */
function seedFrozenCopy(userDataDir: string, plugin: UserPlugin): void {
  const manifest = JSON.parse(readFileSync(join(FROZEN_DIRECTORY, MANIFEST_FILE), "utf8")) as Record<string, unknown>;
  const bundle = readFileSync(join(FROZEN_DIRECTORY, ENTRY_FILE), "utf8");
  if (!bundle.includes(BUNDLED_ID)) throw new Error(`The frozen bundle no longer holds ${BUNDLED_ID}.`);
  seedPlugin(userDataDir, plugin.id, {
    [MANIFEST_FILE]: JSON.stringify({ ...manifest, id: plugin.id, name: plugin.name, apiVersion: plugin.apiVersion }),
    [ENTRY_FILE]: bundle.replace(BUNDLED_ID, `var PLUGIN_ID = "${plugin.id}";`),
  });
}

interface LoggedLine {
  readonly msg: string;
  readonly id?: string;
  readonly apiVersion?: string | null;
  readonly reason?: string | null;
}

function pluginLines(userDataDir: string): { readonly raw: string; readonly line: LoggedLine }[] {
  const text = readProfileFile(userDataDir, LOG_FILE) ?? "";
  return (
    text
      .split("\n")
      .filter((raw) => raw !== "")
      .map((raw) => ({ raw, line: JSON.parse(raw) as LoggedLine }))
      // The engine logs the same refusals under `pluginId`; main's report is the one with `id`.
      .filter(({ line }) => line.id !== undefined && (line.msg === "plugin found" || line.msg === "plugin unavailable"))
  );
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

async function expand(page: Page, name: RegExp): Promise<void> {
  const target = explorer(page).getByRole("treeitem", { name });
  await target.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await target.click();
  if ((await target.getAttribute("aria-expanded")) !== "true") await page.keyboard.press("ArrowRight");
  await expect.poll(() => target.getAttribute("aria-expanded")).toBe("true");
}

function kindButton(page: Page, name: string) {
  return dataSourcesDialog(page)
    .getByRole("list", { name: "Database kinds" })
    .getByRole("button", { name: new RegExp(`^${name}`) });
}

async function openKindPicker(page: Page): Promise<void> {
  await explorer(page).getByRole("button", { name: "New Data Source…", exact: true }).click();
  await dataSourcesDialog(page).getByRole("list", { name: "Database kinds" }).waitFor();
}

describe.runIf(SMOKE_ENABLED)("plugin API 1.0 live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource | null, userDataDir = newProfile()): Promise<Page> {
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  async function queryAndBrowse(page: Page, namespace: string): Promise<void> {
    await runStatement(page, QUERY);
    expect((await gridText(page)).headers).toEqual(expect.arrayContaining(QUERY_HEADERS));
    await expect.poll(() => explorer(page).getByRole("treeitem", { name: namespace }).count()).toBeGreaterThan(0);
    await expand(page, TABLES);
  }

  it(
    "givenBuiltInSqlite_whenQueriedAndBrowsed_thenEveryBuiltInIsOnApi1",
    async () => {
      const page = await launch({ id: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } });
      await queryAndBrowse(page, "main");

      const userDataDir = running?.userDataDir ?? "";
      await expect
        .poll(() =>
          pluginLines(userDataDir)
            .filter(({ line }) => line.msg === "plugin found")
            .map(({ line }) => [line.id, line.apiVersion])
            .sort(),
        )
        .toEqual(BUILT_IN_IDS.map((id) => [id, API_VERSION]));
      await captureWindow(page, "01-sqlite-on-api-1-0-0");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenBuiltInMysql_whenQueriedAndBrowsed_thenAnswers",
    async () => {
      const page = await launch({ id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG });
      await queryAndBrowse(page, "table_craft");
      await captureWindow(page, "02-mysql-on-api-1-0-0");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFrozenSqliteUnderAnotherId_whenInstalledAsUserPlugin_thenItsConsoleRuns",
    async () => {
      const userDataDir = newProfile();
      seedFrozenCopy(userDataDir, FROZEN_COPY);
      const page = await launch(
        { id: "frozen", pluginId: FROZEN_COPY.id, config: { path: seededSqliteFile() } },
        userDataDir,
      );
      await queryAndBrowse(page, "main");

      await expect
        .poll(() => pluginLines(userDataDir).map(({ line }) => [line.msg, line.id]))
        .toContainEqual(["plugin found", FROZEN_COPY.id]);
      await captureWindow(page, "03-user-plugin-1-0-0-query");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUserPluginsForNewerMinorAndOlderMajor_whenKindsListed_thenRefusedNamingTheVersions",
    async () => {
      const userDataDir = newProfile();
      for (const plugin of [FROZEN_COPY, NEWER, OLDER]) seedFrozenCopy(userDataDir, plugin);
      const page = await launch(null, userDataDir);
      await openKindPicker(page);

      await expect.poll(() => kindButton(page, FROZEN_COPY.name).isEnabled()).toBe(true);
      const newer = kindButton(page, NEWER.name);
      await expect.poll(() => newer.isDisabled()).toBe(true);
      expect(await newer.getAttribute("title")).toBe(
        `Built for plugin API ${NEWER_MINOR}: needs TableCraft with plugin API ${HOST?.major}.99 or later; ` +
          `this TableCraft provides ${API_VERSION}. Update the app.`,
      );
      const older = kindButton(page, OLDER.name);
      await expect.poll(() => older.isDisabled()).toBe(true);
      expect(await older.getAttribute("title")).toBe(
        `Built for plugin API ${OLDER_MAJOR}, an older major than this TableCraft's ${API_VERSION}. ` +
          `Install a version of the plugin built for plugin API ${HOST?.major}.x.`,
      );
      await captureWindow(page, "04-refused-plugins");

      const refused = () => pluginLines(userDataDir).filter(({ line }) => line.msg === "plugin unavailable");
      await expect
        .poll(() =>
          refused()
            .map(({ line }) => [line.id, line.apiVersion])
            .sort(),
        )
        .toEqual([
          [NEWER.id, NEWER_MINOR],
          [OLDER.id, OLDER_MAJOR],
        ]);
      writeEvidence(
        "04-refused-plugins.log",
        `${refused()
          .map(({ raw }) => raw)
          .join("\n")}\n`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );
});
