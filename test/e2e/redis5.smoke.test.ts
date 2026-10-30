/**
 * Plan 060's live test: the Redis plugin against Redis 5.0, standalone and Cluster, which speak
 * RESP2 and have no ACL users. Gated like plan 058's suite:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/060 bun run test:smoke:db:headless:redis test/e2e/redis5.smoke.test.ts
 *
 * Scratch keys live under `live5:` and are removed by the suite.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import redis from "@table-craft/plugin-redis";
import { REDIS5_CLUSTER_CONFIG, REDIS5_CONFIG, WITHOUT_REDIS } from "../support/databases.js";
import {
  cancelButton,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  datasourceStatus,
  EVIDENCE_WINDOW,
  evidenceFor,
  fillNewDatasource,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  testConnection,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  chooseOption,
} from "./harness.js";
import {
  attributes,
  expand,
  explorer,
  keyButton,
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

const captureWindow = evidenceFor("060");

const REDIS5: Datasource = { id: "redis5", pluginId: "redis", config: REDIS5_CONFIG };
const CLUSTER5: Datasource = { id: "cluster5", pluginId: "redis", config: REDIS5_CLUSTER_CONFIG };

const STRING_KEY = "live5:string";
const QUEUE_KEY = "live5:queue";
const STRING_TTL_MS = 600_000;
const ACL_USER = "table_craft";

/** The reply text of one command on `config`, run through the plugin outside the app. */
async function replyOf(config: object, command: string): Promise<string> {
  const session = await redis.connect(config, { readOnly: false });
  try {
    return (await session.execute(command)).reply?.text ?? "";
  } finally {
    await session.close();
  }
}

/** Runs `command` in the console and waits for the grid's headers. */
async function gridHeaders(page: Page, command: string): Promise<readonly string[]> {
  await sqlEditor(page).fill(command);
  await runAllButton(page).click();
  await expect
    .poll(async () => (await gridText(page)).headers.length, { timeout: LAUNCH_TIMEOUT_MS })
    .toBeGreaterThan(0);
  await waitUntilReady(page);
  return (await gridText(page)).headers;
}

describe.runIf(DATABASES_ENABLED)("redis 5.0 live test", () => {
  let running: RunningApp | null = null;

  afterAll(async () => {
    if (WITHOUT_REDIS) return;
    await onRedis(REDIS5_CONFIG, [`DEL ${STRING_KEY} ${QUEUE_KEY}`]);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource | null): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_REDIS)(
    "givenRedis5_whenConnected_thenTreeVersionAndHashTab",
    async () => {
      const page = await launch(REDIS5);
      await scanned(page, /^db0/);
      await expect
        .poll(() => datasourceStatus(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/Redis 5\.0\.\d+ · db0 · [\d,]+ keys/);
      expect(await treeRow(page, "keyFolder", "page:").first().getAttribute("aria-label")).toBe("page: 5000");

      await openKey(page, "type_probe:hash");
      expect(await keyHeaders(page)).toEqual(["field", "value"]);
      await captureWindow(page, "01-redis5-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedis5Console_whenHgetallAndZrangeWithScores_thenRowsAsOn74",
    async () => {
      const page = await launch(REDIS5);
      expect(await gridHeaders(page, "HGETALL user:{43}:profile")).toEqual(["field", "value"]);
      expect(await gridHeaders(page, "ZRANGE leaderboard 0 -1 WITHSCORES")).toEqual(["member", "score"]);
      expect((await gridText(page)).cells).toEqual(["bob", "80", "ann", "120", "cid", "200"]);
      await runCommand(page, "ZSCORE leaderboard ann", "(integer) 120");
      await captureWindow(page, "02-redis5-console");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedis5Cluster_whenConnected_thenNodesAndDbsizeOnAllPrimaries",
    async () => {
      const page = await launch(CLUSTER5);
      await scanned(page, /^db0/);
      await expand(page, treeRow(page, "clusterNodes", "Cluster nodes"));
      const labels = treeRows(page, "clusterNode");
      await expect.poll(() => labels.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(6);
      expect((await labels.allTextContents()).filter((label) => / replica of /.test(label))).toHaveLength(3);

      const runOn = page.getByTestId("run-on");
      await runOn.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await chooseOption(runOn, { label: "All primaries" });
      expect(await gridHeaders(page, "DBSIZE")).toEqual(["node", "value"]);
      expect((await gridText(page)).cells).toHaveLength(6);
      await captureWindow(page, "03-redis5-cluster");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedis5_whenTypeFilterAndStringEdit_thenHashesOnlyAndTtlKept",
    async () => {
      await onRedis(REDIS5_CONFIG, [`SET ${STRING_KEY} before PX ${String(STRING_TTL_MS)}`]);
      const page = await launch(REDIS5);
      await scanned(page, /^db0/);
      const filter = explorer(page).getByTestId("key-filter").first();
      await filter.fill("user:*");
      await filter.press("Enter");
      await chooseOption(explorer(page).getByTestId("key-type-filter").first(), "hash");
      await expect
        .poll(() => attributes(treeRows(page, "keyFolder"), "aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(["user: 2"]);

      await openKey(page, STRING_KEY);
      await expect.poll(() => keyTab(page).getByTestId("key-ttl").textContent()).toMatch(/^TTL \d+ m$/);
      const editor = keyTab(page).getByTestId("value-editor").locator(".cm-content");
      await editor.click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("after");
      await keyButton(page, "Submit").click();
      await expect
        .poll(() => keyTab(page).getByTestId("key-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("Submitted as one MULTI");
      await expect.poll(() => keyTab(page).getByTestId("key-ttl").textContent()).toMatch(/^TTL \d+ m$/);
      await expect
        .poll(() => keyTab(page).getByTestId("value-editor").locator(".cm-content").textContent())
        .toBe("after");
      expect(await replyOf(REDIS5_CONFIG, `GET ${STRING_KEY}`)).toBe('"after"');
      expect(Number((await replyOf(REDIS5_CONFIG, `PTTL ${STRING_KEY}`)).replace("(integer) ", ""))).toBeGreaterThan(0);
      await captureWindow(page, "04-redis5-edit");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedis5_whenBlockingPopCancelledAndServerTabOpened_thenCancelledAndCards",
    async () => {
      const page = await launch(REDIS5);
      await sqlEditor(page).fill(`BLPOP ${QUEUE_KEY} 0`);
      await runAllButton(page).click();
      await expect.poll(() => cancelButton(page).isEnabled(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      await cancelButton(page).click();
      await expect.poll(() => outputLog(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/cancel/i);
      await waitUntilReady(page);
      await runCommand(page, "PING", "PONG");

      await showFromDatasourceMenu(page, REDIS5.id, /^Server Info/);
      const cards = page.getByTestId("server-tab").getByTestId("server-card");
      await cards.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await cards.first().textContent()).toContain("Memory");
      await captureWindow(page, "05-redis5-server");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedis5AndUsername_whenTestConnection_thenNoAclUsersMessage",
    async () => {
      const page = await launch(null);
      await fillNewDatasource(page, {
        kind: "Redis",
        name: "redis5-acl",
        fields: { Host: REDIS5_CONFIG.host, Port: String(REDIS5_CONFIG.port), Username: ACL_USER },
        password: REDIS5_CONFIG.password,
      });
      const result = await testConnection(page);
      expect(result.ok).toBe(false);
      expect(result.text).toContain("no ACL users");
      await captureWindow(page, "06-redis5-acl");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
