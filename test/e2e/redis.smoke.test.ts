/**
 * Plan 058's live test: the Redis plugin against the `test/db/compose.yml` Redis services, 7.4 and
 * 6.2, standalone and Cluster. Gated, because it needs a display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/058 bun run test:smoke:db:headless:redis test/e2e/redis.smoke.test.ts
 *
 * Scratch keys live under `live:` and are removed by the suite.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "@table-craft/plugin-api";
import redis from "@table-craft/plugin-redis";
import {
  REDIS6_CLUSTER_CONFIG,
  REDIS6_CONFIG,
  REDIS_CLUSTER_CONFIG,
  REDIS_CONFIG,
  WITHOUT_REDIS,
} from "../support/databases.js";
import { pluginPackageName, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";
import {
  activeEditorTab,
  answerSecretPrompt,
  cancelButton,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  dataSourcesDialog,
  datasourceStatus,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import { builtRelease } from "./pluginFixtures.js";
import {
  attributes,
  BASIC_COMPLETION,
  dialog,
  editKeyCell,
  expand,
  explorer,
  keyButton,
  keyCell,
  keyHeaders,
  keyTab,
  onRedis,
  openKey,
  outputLog,
  runCommand,
  scanned,
  showFromDatasourceMenu,
  treeRow,
  treeRows,
} from "./redisLive.js";

const captureWindow = evidenceFor("058");

const REDIS: Datasource = { id: "redis", pluginId: "redis", config: REDIS_CONFIG };
const REDIS6: Datasource = { id: "redis6", pluginId: "redis", config: REDIS6_CONFIG };
const CLUSTER: Datasource = { id: "cluster", pluginId: "redis", config: REDIS_CLUSTER_CONFIG };
const CLUSTER6: Datasource = { id: "cluster6", pluginId: "redis", config: REDIS6_CLUSTER_CONFIG };

const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
const EDIT_KEY = "live:edit";
const TTL_KEY = "live:ttl";
const DELETE_PREFIX = "live:del:";
const DELETE_COUNT = 30;
const TTL_SECONDS = 3;

describe.runIf(DATABASES_ENABLED)("redis live test", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;
  let holder: Session | null = null;

  beforeAll(async () => {
    if (WITHOUT_REDIS) return;
    await onRedis(REDIS_CONFIG, [`DEL ${EDIT_KEY} ${TTL_KEY}`]);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    if (WITHOUT_REDIS) return;
    const deletes = Array.from({ length: DELETE_COUNT }, (_, index) => `${DELETE_PREFIX}${String(index)}`);
    await onRedis(REDIS_CONFIG, [`DEL ${EDIT_KEY} ${TTL_KEY} live:queue ${deletes.join(" ")}`]);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await registry?.close();
    registry = null;
    await holder?.close().catch(() => undefined);
    holder = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_REDIS)(
    "givenRegistryFixture_whenRedisDownloaded_thenModeHidesDatabaseAndRedissSetsTls",
    async () => {
      registry = await startRegistry({ [pluginPackageName("redis")]: [builtRelease("redis", "1.0.0")] });
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: registry.url } });
      running = await launchApp(null, { userDataDir, env: NO_OPTIONAL_ROOT });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      const page = running.page;

      await explorer(page).getByRole("button", { name: "New Data Source…", exact: true }).click();
      const form = dataSourcesDialog(page);
      await form.locator('button[data-download="redis"]').click();
      await form.getByLabel("Mode", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await form.getByLabel("Mode", { exact: true }).selectOption("cluster");
      await expect.poll(() => form.getByLabel("Database", { exact: true }).count()).toBe(0);
      expect(await form.getByLabel("Node address map", { exact: true }).count()).toBe(1);
      await form.getByLabel("Mode", { exact: true }).selectOption("standalone");
      await form.getByLabel("Database", { exact: true }).waitFor();

      await form.getByLabel("URL", { exact: true }).fill("rediss://ann:secret@cache.example.com:6380/2");
      await form.getByLabel("URL", { exact: true }).press("Enter");
      await expect.poll(() => form.getByLabel("Host", { exact: true }).inputValue()).toBe("cache.example.com");
      expect(await form.getByLabel("Port", { exact: true }).inputValue()).toBe("6380");
      expect(await form.getByLabel("Database", { exact: true }).inputValue()).toBe("2");
      expect(await form.getByLabel("TLS mode", { exact: true }).inputValue()).toBe("require");
      await captureWindow(page, "01-form");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenStandalone_whenConnected_thenDatabasesFoldersBadgesAndTtls",
    async () => {
      const page = await launch(REDIS);
      await scanned(page, /^db0/);

      expect(await treeRow(page, "keyDatabase", /^db1/).count()).toBe(1);
      expect(await treeRow(page, "keyDatabase", /^db0/).first().getAttribute("aria-label")).toMatch(
        /^db0 [\d,]+ keys$/,
      );
      expect(await treeRow(page, "keyFolder", "page:").first().getAttribute("aria-label")).toBe("page: 5000");
      await expand(page, treeRow(page, "keyFolder", "type_probe:"));
      await expect
        .poll(() => attributes(treeRows(page, "keyEntry").locator("[data-key-type]"), "data-key-type"))
        .toEqual(expect.arrayContaining(["hash", "list", "set", "zset", "stream", "string"]));
      await expand(page, treeRow(page, "keyFolder", "user:"));
      await expand(page, treeRow(page, "keyFolder", "user:{42}:"));
      await expect
        .poll(() => treeRow(page, "keyEntry", "session").first().getAttribute("aria-label"))
        .toMatch(/^STR session, \d+ d$/);
      await captureWindow(page, "02-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenCluster_whenConnected_thenDb0AndClusterNodesWithRolesAndSlots",
    async () => {
      const page = await launch(CLUSTER);
      await scanned(page, /^db0/);

      await expand(page, treeRow(page, "clusterNodes", "Cluster nodes"));
      const nodes = treeRows(page, "clusterNode");
      await expect.poll(() => nodes.count()).toBe(6);
      const labels = await nodes.allTextContents();
      expect(labels.filter((label) => / primary \d+–\d+$/.test(label))).toHaveLength(3);
      expect(labels.filter((label) => / replica of /.test(label))).toHaveLength(3);
      await captureWindow(page, "03-cluster-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenFilterUserHash_whenEntered_thenOnlyHashesUnderUser",
    async () => {
      const page = await launch(REDIS);
      await scanned(page, /^db0/);

      const filter = explorer(page).getByTestId("key-filter").first();
      await filter.fill("user:*");
      await filter.press("Enter");
      await expect
        .poll(() => attributes(treeRows(page, "keyFolder"), "aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(["user: 3"]);

      await explorer(page).getByTestId("key-type-filter").first().selectOption("hash");
      await expect
        .poll(() => attributes(treeRows(page, "keyFolder"), "aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(["user: 2"]);
      expect(await treeRow(page, "keyFolder", "user:").first().getAttribute("aria-label")).toBe("user: 2");
      await expand(page, treeRow(page, "keyFolder", "user:"));
      await expand(page, treeRow(page, "keyFolder", "user:{42}:"));
      await captureWindow(page, "04-filter");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenHashKey_whenOpened_thenHeaderGridAndJsonValue",
    async () => {
      const page = await launch(REDIS);
      await openKey(page, "type_probe:hash");

      expect(await keyHeaders(page)).toEqual(["field", "value", "ttl"]);
      expect(await keyTab(page).getByTestId("key-ttl").textContent()).toBe("no TTL");
      expect(await keyTab(page).getByTestId("key-info").textContent()).toMatch(/^3 fields · \d+ bytes · listpack/);
      expect(await activeEditorTab(page).textContent()).toContain("type_probe:hash");
      await keyCell(page, 2, 1).click();
      await page.keyboard.press("Shift+Enter");
      await expect.poll(() => page.getByTestId("value-editor").textContent()).toContain('"theme"');
      await captureWindow(page, "05-hash");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenZsetListStreamAndBinary_whenOpened_thenTheirColumnsAndHexValue",
    async () => {
      const page = await launch(REDIS);
      await openKey(page, "leaderboard");
      expect(await keyHeaders(page)).toEqual(["#", "member", "score"]);
      await expect.poll(() => keyCell(page, 0, 1).textContent()).toBe("bob");

      await openKey(page, "type_probe:list");
      expect(await keyHeaders(page)).toEqual(["#", "value"]);

      await openKey(page, "type_probe:stream");
      expect(await keyHeaders(page)).toEqual(["id", "event", "user", "reason"]);

      await openKey(page, "type_probe:binary");
      const value = keyTab(page).getByTestId("string-value");
      await value.waitFor();
      await expect.poll(() => value.getByTestId("value-format").inputValue()).toBe("auto");
      await expect.poll(() => value.getByTestId("value-formatted").getAttribute("data-format")).toBe("hex");
      await captureWindow(page, "06-types");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenHashEditAndNewField_whenPreviewedAndSubmitted_thenOneMulti",
    async () => {
      await onRedis(REDIS_CONFIG, [`DEL ${EDIT_KEY}`, `HSET ${EDIT_KEY} name Ann`]);
      const page = await launch(REDIS);
      await openKey(page, EDIT_KEY);

      expect(await keyTab(page).getByTestId("tx-mode").textContent()).toBe("Submit applies changes atomically · not undoable");
      await editKeyCell(page, 0, 1, "Bo");
      await keyButton(page, "Add Row").click();
      await editKeyCell(page, 1, 0, "city");
      await editKeyCell(page, 1, 1, "Oslo");
      await expect.poll(() => keyTab(page).getByTestId("pending-changes").textContent()).toBe("2 pending changes");

      await keyButton(page, "Preview Pending Changes").click();
      const preview = dialog(page);
      await expect.poll(() => preview.textContent()).toContain("as one MULTI");
      expect(await preview.textContent()).toContain(`HSET ${EDIT_KEY} name Bo`);
      expect(await preview.textContent()).toContain(`HSET ${EDIT_KEY} city Oslo`);
      await captureWindow(page, "07-submit");
      await preview.getByRole("button", { name: "Submit", exact: true }).click();

      await expect
        .poll(() => keyTab(page).getByTestId("key-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("Submitted as one MULTI");
      await expect.poll(() => keyCell(page, 0, 1).textContent()).toBe("Bo");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenFieldChangedElsewhere_whenSubmitted_thenConflictThenReload",
    async () => {
      await onRedis(REDIS_CONFIG, [`DEL ${EDIT_KEY}`, `HSET ${EDIT_KEY} name Ann`]);
      const page = await launch(REDIS);
      await openKey(page, EDIT_KEY);
      await editKeyCell(page, 0, 1, "Bo");
      await onRedis(REDIS_CONFIG, [`HSET ${EDIT_KEY} name Zed`]);

      await expect.poll(() => keyTab(page).getByTestId("pending-changes").textContent()).toBe("1 pending change");
      const submit = keyButton(page, "Submit");
      expect(await submit.count()).toBe(1);
      expect(await submit.isEnabled()).toBe(true);
      await submit.click();
      const conflict = keyTab(page).getByTestId("key-conflict");
      await expect.poll(() => conflict.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("is now Zed");
      await captureWindow(page, "08-conflict");

      await keyTab(page).getByTestId("key-conflict-reload").click();
      await expect.poll(() => conflict.count()).toBe(0);
      await expect.poll(() => keyCell(page, 0, 1).textContent()).toBe("Zed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenTtlSet_whenItRunsOut_thenCountdownThenMissingBannerWithRecreate",
    async () => {
      await onRedis(REDIS_CONFIG, [`SET ${TTL_KEY} soon-gone`]);
      const page = await launch(REDIS);
      await openKey(page, TTL_KEY);

      await findAction(page, "Set TTL");
      const modal = dialog(page);
      await modal.getByRole("textbox").fill(String(TTL_SECONDS));
      await modal.getByRole("textbox").press("Enter");
      await expect
        .poll(() => keyTab(page).getByTestId("key-ttl").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/^TTL [1-3] s$/);

      const missing = keyTab(page).getByTestId("key-missing");
      await missing.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await missing.textContent()).toContain(`${TTL_KEY} no longer exists`);
      expect(await missing.getByTestId("key-recreate").isEnabled()).toBe(true);
      await captureWindow(page, "09-ttl");

      await missing.getByTestId("key-recreate").click();
      await keyButton(page, "Submit").first().click();
      await expect.poll(() => missing.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      await expect.poll(() => keyTab(page).getByTestId("key-ttl").textContent()).toBe("no TTL");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenConsole_whenCompletingKeysAndFlushdb_thenSignatureScanFixAndTypedConfirm",
    async () => {
      const page = await launch(REDIS);

      await sqlEditor(page).fill("ZRAN");
      await page.keyboard.press("End");
      await page.keyboard.press(BASIC_COMPLETION);
      const popup = page.locator(".cm-tooltip-autocomplete");
      await expect
        .poll(() => popup.locator(".cm-completionLabel").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["ZRANGE"]));
      await page.keyboard.press("Escape");

      await sqlEditor(page).fill("KEYS *");
      const costly = sqlEditor(page).locator(".tc-problem-warning");
      await expect.poll(() => costly.allTextContents(), { timeout: LAUNCH_TIMEOUT_MS }).toEqual(["KEYS"]);
      await costly.first().hover();
      const tooltip = page.locator(".tc-problem-tooltip");
      await tooltip.waitFor();
      expect(await tooltip.locator(".tc-problem-fix").allTextContents()).toEqual(
        expect.arrayContaining([expect.stringContaining("Use SCAN")]),
      );
      await page.mouse.move(0, 0);

      await sqlEditor(page).fill("FLUSHDB");
      await runAllButton(page).click();
      const confirm = dialog(page);
      await expect.poll(() => confirm.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain(`Type ${REDIS.id}`);
      await captureWindow(page, "10-console");
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      await runCommand(page, "EXISTS seed:probe", "(integer) 1");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenClusterConsole_whenDbsizeOnAllPrimariesAndCrossSlotMset_thenRowPerNodeAndHint",
    async () => {
      const page = await launch(CLUSTER);
      const runOn = page.getByTestId("run-on");
      await runOn.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await runOn.selectOption({ label: "All primaries" });
      await sqlEditor(page).fill("DBSIZE");
      await runAllButton(page).click();
      await expect
        .poll(async () => (await gridText(page)).headers, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(["node", "value"]);
      expect((await gridText(page)).cells.length).toBe(6);
      await waitUntilReady(page);

      await runOn.selectOption({ label: "Auto" });
      await sqlEditor(page).fill("MSET a 1 b 2");
      await runAllButton(page).click();
      await expect
        .poll(() => consoleAlert(page).first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("keys must share a hash slot");
      await captureWindow(page, "11-cluster-console");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenReadOnlyDatasource_whenHset_thenRefusedNamingIt",
    async () => {
      const { password, ...plain } = REDIS_CONFIG;
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [
        {
          id: "cache-ro",
          name: "cache-ro",
          pluginId: "redis",
          config: plain,
          secretModes: { password: "untilRestart" },
          readOnly: true,
        },
      ]);
      running = await launchApp(null, { userDataDir });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      const page = running.page;
      await openConsoleOn(page, "cache-ro");
      await answerSecretPrompt(page, "cache-ro", password);
      await waitUntilReady(page);

      await sqlEditor(page).fill("HSET type_probe:hash name Zed");
      await runAllButton(page).click();
      await expect
        .poll(() => consoleAlert(page).first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("read-only datasource refuses HSET");
      await captureWindow(page, "12-readonly");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenBlockingPop_whenCancelled_thenCancelledAndConsoleUsable",
    async () => {
      const page = await launch(REDIS);
      await sqlEditor(page).fill("BLPOP live:queue 0");
      await runAllButton(page).click();
      await expect.poll(() => cancelButton(page).isEnabled(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      await cancelButton(page).hover();
      await expect
        .poll(() => page.getByRole("tooltip").first().textContent())
        .toContain("Cancel stops blocking commands only");

      await cancelButton(page).click();
      await expect.poll(() => outputLog(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/cancel/i);
      await waitUntilReady(page);
      await captureWindow(page, "13-cancel");
      await runCommand(page, "PING", "PONG");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenServerTab_whenOpened_thenCardsRefreshSlowLogAndClusterOverview",
    async () => {
      const page = await launch(REDIS);
      await showFromDatasourceMenu(page, REDIS.id, /^Server Info/);
      const server = page.getByTestId("server-tab");
      const cards = server.getByTestId("server-card");
      await cards.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await cards.first().textContent()).toContain("Memory");
      await server.getByTestId("server-refresh").selectOption({ label: "Refresh: 2 s" });
      await captureWindow(page, "14-server");

      await server.getByTestId("server-view-slowLog").click();
      await server.getByTestId("server-slow-log").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "14-server-slow-log");
      await closeApp(running?.app);

      const clusterPage = await launch(CLUSTER);
      await showFromDatasourceMenu(clusterPage, CLUSTER.id, /^Server Info/);
      const overview = clusterPage.getByTestId("server-overview");
      await expect.poll(() => overview.locator("tbody tr").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(6);
      await captureWindow(clusterPage, "14-server-cluster");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenCluster_whenShowSessionsAndTerminate_thenClientsAcrossPrimariesAndOneGone",
    async () => {
      holder = await redis.connect(REDIS_CLUSTER_CONFIG, { readOnly: false });
      const holderId = holder.serverSessionId ?? "";
      const page = await launch(CLUSTER);
      await showFromDatasourceMenu(page, CLUSTER.id, /^Show Sessions/);
      const grid = page.getByTestId("sessions-grid");
      const row = grid.locator(`tbody tr[data-session="${holderId}"]`);
      await expect
        .poll(
          async () => {
            if ((await row.count()) > 0) return true;
            await page.getByRole("button", { name: "Refresh Sessions", exact: true }).click();
            return false;
          },
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .toBe(true);
      const ids = await attributes(grid.locator("tbody tr"), "data-session");
      expect(new Set(ids.map((id) => id.split("@")[1])).size).toBe(3);

      await row.click();
      await page.getByRole("button", { name: "Terminate Session…", exact: true }).click();
      const terminate = page.getByRole("dialog", { name: "Terminate Session" });
      await terminate.waitFor();
      expect(await terminate.textContent()).toContain("CLIENT KILL ID");
      await captureWindow(page, "15-sessions");
      await terminate.getByRole("button", { name: "Terminate", exact: true }).click();
      await expect
        .poll(() => page.getByTestId("sessions-status").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`Terminated session ${holderId}.`);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenFolder_whenDeleteKeysUnderFolder_thenServicesJobDeletesThem",
    async () => {
      const keys = Array.from({ length: DELETE_COUNT }, (_, index) => `${DELETE_PREFIX}${String(index)} x`);
      await onRedis(REDIS_CONFIG, [`MSET ${keys.join(" ")}`]);
      const page = await launch(REDIS);
      await scanned(page, /^db0/);
      await expand(page, treeRow(page, "keyFolder", "live:"));

      const folder = treeRow(page, "keyFolder", DELETE_PREFIX).first();
      await folder.click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Delete Keys Under Folder/ }).click();
      const confirm = dialog(page);
      await expect.poll(() => confirm.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain(String(DELETE_COUNT));
      await confirm
        .getByRole("button")
        .filter({ hasText: /^Delete/ })
        .click();

      const services = toolWindow(page, "Services");
      await expect
        .poll(() => services.getByTestId("key-delete-progress").first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`${String(DELETE_COUNT)} of ${String(DELETE_COUNT)}`);
      await expect.poll(() => treeRow(page, "keyFolder", DELETE_PREFIX).count()).toBe(0);
      await captureWindow(page, "16-delete-folder");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedis62_whenBrowsed_thenHashWithoutTtlSnapshotCompletionServerTabAndVersion",
    async () => {
      const page = await launch(REDIS6);
      await scanned(page, /^db0/);
      await expect
        .poll(() => datasourceStatus(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/Redis 6\.2\.\d+/);

      await sqlEditor(page).fill("HGE");
      await page.keyboard.press("End");
      await page.keyboard.press(BASIC_COMPLETION);
      await expect
        .poll(() => page.locator(".cm-tooltip-autocomplete .cm-completionLabel").allTextContents(), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toEqual(expect.arrayContaining(["HGET", "HGETALL"]));
      await page.keyboard.press("Escape");

      await openKey(page, "type_probe:hash");
      expect(await keyHeaders(page)).toEqual(["field", "value"]);
      await captureWindow(page, "17-redis62");

      await showFromDatasourceMenu(page, REDIS6.id, /^Server Info/);
      await page.getByTestId("server-card").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "17-redis62-server");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedis62Cluster_whenConnected_thenClusterNodesAndDbsizeOnAllPrimaries",
    async () => {
      const page = await launch(CLUSTER6);
      await scanned(page, /^db0/);
      await expand(page, treeRow(page, "clusterNodes", "Cluster nodes"));
      await expect.poll(() => treeRows(page, "clusterNode").count()).toBe(3);
      expect(
        (await treeRows(page, "clusterNode").allTextContents()).every((label) => label.includes(" primary ")),
      ).toBe(true);

      const runOn = page.getByTestId("run-on");
      await runOn.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await runOn.selectOption({ label: "All primaries" });
      await sqlEditor(page).fill("DBSIZE");
      await runAllButton(page).click();
      await expect.poll(async () => (await gridText(page)).cells.length, { timeout: LAUNCH_TIMEOUT_MS }).toBe(6);
      await captureWindow(page, "18-redis62-cluster");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
