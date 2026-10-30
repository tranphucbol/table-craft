/**
 * Plan 060's live test: Redis console results that read and edit like the key tab (decision 119),
 * against the `test/db/compose.yml` Redis 7.4, 6.2 and 5.0 servers and the 7.4 Cluster:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/060 bun run test:smoke:db:headless:redis test/e2e/redisConsoleResults.smoke.test.ts
 *
 * Scratch keys live under `live060:` and are removed by the suite.
 */
import { gzipSync } from "node:zlib";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import redis from "@table-craft/plugin-redis";
import {
  REDIS5_CONFIG,
  REDIS6_CONFIG,
  REDIS_CLUSTER_CONFIG,
  REDIS_CONFIG,
  WITHOUT_REDIS,
} from "../support/databases.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  columnSnapshot,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  optionValue,
} from "./harness.js";
import { dialog, keyCell, keyTab, onRedis, outputLog, runCommand } from "./redisLive.js";

const captureWindow = evidenceFor("060");

const REDIS: Datasource = { id: "redis", pluginId: "redis", config: REDIS_CONFIG };
const REDIS6: Datasource = { id: "redis6", pluginId: "redis", config: REDIS6_CONFIG };
const REDIS5: Datasource = { id: "redis5", pluginId: "redis", config: REDIS5_CONFIG };
const CLUSTER: Datasource = { id: "cluster", pluginId: "redis", config: REDIS_CLUSTER_CONFIG };

const JSON_KEY = "live060:json";
const GZIP_KEY = "live060:gzip";
const COUNTER_KEY = "live060:counter";
const HASH_KEY = "live060:hash";
const ZSET_KEY = "live060:zset";
const LIST_KEY = "live060:list";
const CLUSTER_KEY = "live060:{node}:hash";
const PREFS = '{"theme":"dark","tags":[1,2]}';
const SCRATCH = [JSON_KEY, GZIP_KEY, COUNTER_KEY, HASH_KEY, ZSET_KEY, LIST_KEY];

/** `bytes` as one double-quoted command argument, every byte escaped. */
function quotedBytes(bytes: Uint8Array): string {
  return `"${Array.from(bytes, (byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("")}"`;
}

function quoted(text: string): string {
  return `"${text.replaceAll('"', '\\"')}"`;
}

const HASH_SEED = [`DEL ${HASH_KEY}`, `HSET ${HASH_KEY} name Ann prefs ${quoted(PREFS)}`];

/** The reply text of one command on `config`, run through the plugin outside the app. */
async function replyOf(config: object, command: string): Promise<string> {
  const session = await redis.connect(config, { readOnly: false });
  try {
    return (await session.execute(command)).reply?.text ?? "";
  } finally {
    await session.close();
  }
}

function cell(page: Page, row: number, column: number) {
  return page.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]:visible`);
}

async function headers(page: Page): Promise<string[]> {
  return page.locator('[role="columnheader"]:visible').allTextContents();
}

async function columnValues(page: Page, column: number): Promise<string[]> {
  return columnSnapshot(page.locator(`[role="gridcell"][data-col="${String(column)}"]:visible`));
}

function editField(page: Page) {
  return page.locator("[data-editing] input");
}

function readOnly(page: Page) {
  return page.getByTestId("result-read-only");
}

function pending(page: Page) {
  return page.getByTestId("pending-changes");
}

function button(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

/** Runs one command and waits for its result tab's headers. */
async function query(page: Page, command: string, expected: readonly string[]): Promise<void> {
  await sqlEditor(page).fill(command);
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await waitUntilReady(page);
  await expect.poll(() => headers(page), { timeout: LAUNCH_TIMEOUT_MS }).toEqual(expected);
}

/** Focuses a cell and opens the value panel on it. */
async function showValue(page: Page, row: number, column: number): Promise<void> {
  await cell(page, row, column).click();
  if ((await page.getByRole("complementary", { name: "Value" }).count()) === 0)
    await page.keyboard.press("Shift+Enter");
  await page.getByTestId("value-formatted").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function editCell(page: Page, row: number, column: number, text: string): Promise<void> {
  await cell(page, row, column).click();
  await page.keyboard.press("Enter");
  await editField(page).waitFor();
  await editField(page).fill(text);
  await editField(page).press("Enter");
  await expect.poll(() => editField(page).count()).toBe(0);
}

async function editableResult(page: Page): Promise<void> {
  await button(page, "Add Row").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

describe.runIf(DATABASES_ENABLED)("redis console results live test", () => {
  let running: RunningApp | null = null;

  beforeAll(async () => {
    if (WITHOUT_REDIS) return;
    const gzipped = gzipSync(Buffer.from(JSON.stringify({ name: "Ann", tags: [1, 2] })));
    await onRedis(REDIS_CONFIG, [
      `DEL ${SCRATCH.join(" ")}`,
      `SET ${JSON_KEY} ${quoted(PREFS)}`,
      `SET ${GZIP_KEY} ${quotedBytes(gzipped)}`,
      ...HASH_SEED,
      `ZADD ${ZSET_KEY} 1 ann 2 bob`,
      `RPUSH ${LIST_KEY} a b c`,
    ]);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    if (WITHOUT_REDIS) return;
    await onRedis(REDIS_CONFIG, [`DEL ${SCRATCH.join(" ")}`]);
    await onRedis(REDIS_CLUSTER_CONFIG, [`DEL ${CLUSTER_KEY}`]);
    await onRedis(REDIS6_CONFIG, [`DEL ${HASH_KEY}`]);
    await onRedis(REDIS5_CONFIG, [`DEL ${HASH_KEY}`]);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_REDIS)(
    "givenJsonAndGzipStrings_whenGet_thenOneRowValueTabAutoFormatted",
    async () => {
      const page = await launch(REDIS);
      await query(page, `GET ${JSON_KEY}`, ["value"]);
      await showValue(page, 0, 0);
      expect(await optionValue(page.getByTestId("value-format"))).toBe("auto");
      await expect.poll(() => page.getByTestId("value-formatted").getAttribute("data-format")).toBe("json");
      await expect.poll(() => page.getByTestId("value-formatted").textContent()).toContain('"theme": "dark"');
      await captureWindow(page, "01-get-json");

      await query(page, `GET ${GZIP_KEY}`, ["value"]);
      await showValue(page, 0, 0);
      await expect.poll(() => page.getByTestId("value-formatted").getAttribute("data-format")).toBe("gzip");
      await expect.poll(() => page.getByTestId("value-formatted").textContent()).toContain("gzip → JSON");
      await expect.poll(() => page.getByTestId("value-formatted").textContent()).toContain('"name": "Ann"');
      await captureWindow(page, "02-get-gzip");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenIncr_whenShowAsResult_thenOneRowTab",
    async () => {
      const page = await launch(REDIS);
      await runCommand(page, `INCR ${COUNTER_KEY}`, "(integer) 1");
      expect(await headers(page)).toEqual([]);
      expect(await outputLog(page).getByTestId("output-open-key").count()).toBe(0);
      await captureWindow(page, "03-incr-output");
      await outputLog(page).getByTestId("output-show-result").last().click();
      await expect.poll(() => headers(page), { timeout: LAUNCH_TIMEOUT_MS }).toEqual(["value"]);
      expect(await columnValues(page, 0)).toEqual(["1"]);
      await captureWindow(page, "03-show-as-result");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenHgetall_whenJsonFieldFocusedAndOpenKey_thenFormattedAndKeyTabOpens",
    async () => {
      const page = await launch(REDIS);
      await query(page, `HGETALL ${HASH_KEY}`, ["field", "value"]);
      expect(await columnValues(page, 0)).toEqual(["name", "prefs"]);
      await showValue(page, 1, 1);
      await expect.poll(() => page.getByTestId("value-formatted").getAttribute("data-format")).toBe("json");
      await captureWindow(page, "04-hgetall");

      await button(page, "Open Key").click();
      await expect
        .poll(() => keyTab(page).getByTestId("key-name").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(HASH_KEY);
      await expect.poll(() => keyCell(page, 0, 1).textContent()).toBe("Ann");
      await captureWindow(page, "05-open-key");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenHgetallResult_whenEditValueAndSubmit_thenHsetApplied",
    async () => {
      await onRedis(REDIS_CONFIG, HASH_SEED);
      const page = await launch(REDIS);
      await query(page, `HGETALL ${HASH_KEY}`, ["field", "value"]);
      await editableResult(page);
      await editCell(page, 0, 1, "Bo");
      await expect.poll(() => pending(page).textContent()).toBe("1 pending change");

      await pressChord(page, "Shift+P");
      await expect.poll(() => dialog(page).textContent()).toContain(`HSET ${HASH_KEY} name Bo`);
      expect(await dialog(page).textContent()).toContain("as one MULTI");
      await captureWindow(page, "06-edit-hash");
      await dialog(page).getByRole("button", { name: "Submit", exact: true }).click();

      await expect.poll(() => pending(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      await expect.poll(() => columnValues(page, 1)).toEqual(["Bo", PREFS]);
      expect(await replyOf(REDIS_CONFIG, `HGET ${HASH_KEY} name`)).toBe('"Bo"');
      await button(page, "Open Key").click();
      await expect.poll(() => keyCell(page, 0, 1).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("Bo");
      await captureWindow(page, "06-edit-hash-key-tab");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenZrangeWithScores_whenScoreEditedAndSubmitted_thenZaddApplied",
    async () => {
      const page = await launch(REDIS);
      await query(page, `ZRANGE ${ZSET_KEY} 0 -1 WITHSCORES`, ["member", "score"]);
      await editableResult(page);
      await editCell(page, 0, 1, "5");
      await button(page, "Submit").click();
      await expect.poll(() => columnValues(page, 0), { timeout: LAUNCH_TIMEOUT_MS }).toEqual(["bob", "ann"]);
      expect(await replyOf(REDIS_CONFIG, `ZSCORE ${ZSET_KEY} ann`)).toMatch(/5/);
      await captureWindow(page, "07-edit-zset");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenPartialReads_whenRun_thenReadOnlyWithReason",
    async () => {
      const page = await launch(REDIS);
      await query(page, `ZRANGE ${ZSET_KEY} 0 -1`, ["member"]);
      await expect
        .poll(() => readOnly(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("without its scores");
      await query(page, `LRANGE ${LIST_KEY} 0 1`, ["#", "value"]);
      await expect
        .poll(() => readOnly(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("not one whole key");
      expect(await button(page, "Open Key").count()).toBe(1);
      await captureWindow(page, "08-partial-readonly");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenChangedHashSinceRead_whenSubmitFromConsole_thenConflict",
    async () => {
      await onRedis(REDIS_CONFIG, HASH_SEED);
      const page = await launch(REDIS);
      await query(page, `HGETALL ${HASH_KEY}`, ["field", "value"]);
      await editableResult(page);
      await editCell(page, 0, 1, "Bo");
      await onRedis(REDIS_CONFIG, [`HSET ${HASH_KEY} name Zed`]);

      await button(page, "Submit").click();
      await expect
        .poll(() => page.getByTestId("result-edit-error").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("is now Zed");
      expect(await pending(page).textContent()).toBe("1 pending change");
      expect(await replyOf(REDIS_CONFIG, `HGET ${HASH_KEY} name`)).toBe('"Zed"');
      await captureWindow(page, "09-conflict");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenReadOnlyDatasource_whenHgetall_thenNotEditable",
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

      await query(page, `HGETALL ${HASH_KEY}`, ["field", "value"]);
      await expect
        .poll(() => readOnly(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("the datasource is read-only");
      expect(await button(page, "Add Row").count()).toBe(0);
      await captureWindow(page, "10-readonly");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenCluster_whenHgetallEditedAndSubmitted_thenAppliedOnTheKeysNode",
    async () => {
      await onRedis(REDIS_CLUSTER_CONFIG, [`DEL ${CLUSTER_KEY}`, `HSET ${CLUSTER_KEY} name Ann`]);
      const page = await launch(CLUSTER);
      await query(page, `HGETALL ${CLUSTER_KEY}`, ["field", "value"]);
      await editableResult(page);
      await editCell(page, 0, 1, "Bo");
      await button(page, "Submit").click();
      await expect.poll(() => pending(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      await expect.poll(() => columnValues(page, 1)).toEqual(["Bo"]);
      expect(await replyOf(REDIS_CLUSTER_CONFIG, `HGET ${CLUSTER_KEY} name`)).toBe('"Bo"');
      await captureWindow(page, "11-cluster");
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const [name, datasource, config] of [
    ["6.2", REDIS6, REDIS6_CONFIG],
    ["5.0", REDIS5, REDIS5_CONFIG],
  ] as const) {
    it.skipIf(WITHOUT_REDIS)(
      `givenRedis${name}_whenHgetallEditedAndSubmitted_thenSameColumnsAndApplied`,
      async () => {
        await onRedis(config, HASH_SEED);
        const page = await launch(datasource);
        await query(page, `HGETALL ${HASH_KEY}`, ["field", "value"]);
        await editableResult(page);
        await editCell(page, 0, 1, "Bo");
        await button(page, "Submit").click();
        await expect.poll(() => pending(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
        await expect.poll(() => columnValues(page, 1)).toEqual(["Bo", PREFS]);
        expect(await replyOf(config, `HGET ${HASH_KEY} name`)).toBe('"Bo"');
        await captureWindow(page, `12-resp2-redis${name.replace(".", "")}`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
});
