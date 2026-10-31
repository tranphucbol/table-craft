/**
 * Plan 135's live test: "Load keys only when asked" on the `test/db/compose.yml` Redis, its cluster
 * and etcd. Gated, because it needs a display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_DATABASES=mysql,tidb,redis,etcd TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/135 bun run test:smoke:db:headless test/e2e/keyLoadOnDemand.smoke.test.ts
 *
 * It only reads the seeded keys.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import redis from "@table-craft/plugin-redis";
import { ETCD_CONFIG, REDIS_CLUSTER_CONFIG, REDIS_CONFIG, WITHOUT_ETCD, WITHOUT_REDIS } from "../support/databases.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  readProfileFile,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { attributes, dialog, keyTab, scanned, treeRow, treeRows } from "./redisLive.js";

const captureWindow = evidenceFor("135");
const writeEvidence = evidenceTextFor("135");

const REDIS: Datasource = { id: "redis", pluginId: "redis", config: REDIS_CONFIG };
const ETCD: Datasource = { id: "etcd", pluginId: "etcd", config: ETCD_CONFIG };

const NOT_SCANNED = /Not scanned · ~[\d,]+ keys? · Scan/;
const NOT_LISTED = /Not listed · ~[\d,]+ keys? · List/;
const MISSING_KEY = "live:no-such-key";
const SEEDED_ETCD_KEY = "/app/config/db.json";
/** Long enough for a pass a connect wrongly started to reach the server. */
const SETTLE_MS = 2000;
const WIDEN_DATABASE_PX = 160;
const SCAN_CALLS = /cmdstat_scan:calls=(\d+)/g;

/** `SCAN` calls the server has served, summed over every primary of a cluster. */
async function scanCalls(config: object): Promise<number> {
  const session = await redis.connect(config, { readOnly: true });
  try {
    const result = await session.execute("INFO commandstats");
    const parts = [result.reply?.text ?? ""];
    for await (const row of result.rows) parts.push(row.map(String).join(" "));
    return [...parts.join("\n").matchAll(SCAN_CALLS)].reduce((sum, match) => sum + Number(match[1]), 0);
  } finally {
    await session.close();
  }
}

/** A saved datasource without its password, which the scenario types into the prompt. */
function saved(name: string, pluginId: string, config: { readonly password: string }, onDemand: boolean) {
  const { password, ...plain } = config;
  const datasource: SavedDatasource = {
    id: name,
    name,
    pluginId,
    config: plain,
    secretModes: { password: "untilRestart" },
    ...(onDemand ? { loadKeysOnDemand: true as const } : {}),
  };
  return { datasource, password };
}

function scanRow(page: Page, label: RegExp) {
  return treeRows(page, "keyLoadMore").filter({ hasText: label });
}

async function activate(page: Page, row: ReturnType<typeof scanRow>): Promise<void> {
  await row.first().click();
  await page.keyboard.press("Enter");
}

/** Widens the Database tool window, so the evidence shows the action rows' whole text. */
async function widenDatabase(page: Page): Promise<void> {
  const handle = await page.getByRole("separator").first().boundingBox();
  if (handle === null) throw new Error("The Database tool window is not laid out.");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + WIDEN_DATABASE_PX, y, { steps: 10 });
  await page.mouse.up();
}

function properties(page: Page) {
  return dataSourcesDialog(page).getByTestId("load-keys-on-demand");
}

describe.runIf(DATABASES_ENABLED)("key tree on demand live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launchSaved(datasource: SavedDatasource): Promise<{ page: Page; userDataDir: string }> {
    const userDataDir = newProfile();
    seedDatasources(userDataDir, [datasource]);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await treeNode(running.page, datasource.name).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await widenDatabase(running.page);
    return { page: running.page, userDataDir };
  }

  async function launchEphemeral(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await widenDatabase(running.page);
    return running.page;
  }

  /** Ticks the option in the datasource's properties, saves, and checks it reopens ticked. */
  async function tickOnDemand(page: Page, name: string, userDataDir: string, evidence: string): Promise<void> {
    await treeNode(page, name).first().click();
    await findAction(page, "Data Source Properties");
    const form = dataSourcesDialog(page);
    await form.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    expect(await properties(page).isChecked()).toBe(false);
    await properties(page).check();
    await properties(page).scrollIntoViewIfNeeded();
    await captureWindow(page, evidence);
    await form.getByRole("button", { name: "OK", exact: true }).click();
    await form.waitFor({ state: "detached" });
    expect(readProfileFile(userDataDir, "datasources.json")).toContain('"loadKeysOnDemand": true');

    await treeNode(page, name).first().click();
    await findAction(page, "Data Source Properties");
    await form.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    expect(await properties(page).isChecked()).toBe(true);
    await page.keyboard.press("Escape");
    await form.waitFor({ state: "detached" });
  }

  async function connect(page: Page, name: string, password: string): Promise<void> {
    await openConsoleOn(page, name);
    await answerSecretPrompt(page, name, password);
    await waitUntilReady(page);
  }

  it.skipIf(WITHOUT_REDIS)(
    "givenLoadOnDemand_whenConnect_thenDb0ShowsScanRowAndNoKeys",
    async () => {
      const { datasource, password } = saved("cache-od", "redis", REDIS_CONFIG, false);
      const { page, userDataDir } = await launchSaved(datasource);
      await tickOnDemand(page, datasource.name, userDataDir, "01-dialog");

      const before = await scanCalls(REDIS_CONFIG);
      await connect(page, datasource.name, password);
      const row = scanRow(page, NOT_SCANNED);
      await row.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      const after = await scanCalls(REDIS_CONFIG);
      expect(after - before).toBe(0);
      expect(await treeRow(page, "keyDatabase", /^db0/).first().getAttribute("aria-expanded")).toBe("true");
      expect(await treeRows(page, "keyFolder").count()).toBe(0);
      expect(await treeRows(page, "keyEntry").count()).toBe(0);
      await captureWindow(page, "02-not-scanned");

      await activate(page, row);
      await expect
        .poll(() => attributes(treeRows(page, "keyFolder"), "aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["page: 5000"]));
      // The fixture's 5,014 keys fit in one pass, so the Scan reaches the end and leaves no Load more.
      await expect.poll(() => treeRows(page, "keyLoadMore").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      const scannedCalls = await scanCalls(REDIS_CONFIG);
      expect(scannedCalls).toBeGreaterThan(after);
      await captureWindow(page, "03-scanned");

      await findAction(page, "Go to Key");
      const prompt = dialog(page);
      await prompt.getByLabel("Key name", { exact: true }).fill(MISSING_KEY);
      await prompt.getByLabel("Key name", { exact: true }).press("Enter");
      const notice = page.getByRole("dialog", { name: "Go to Key" });
      await expect
        .poll(() => notice.textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain(`No key named "${MISSING_KEY}" in db0.`);
      await page.waitForTimeout(SETTLE_MS);
      expect(await scanCalls(REDIS_CONFIG)).toBe(scannedCalls);
      await captureWindow(page, "04-go-to-key");
      writeEvidence(
        "02-scan-calls.txt",
        [
          `cmdstat_scan calls before connect: ${String(before)}`,
          `after connect, with the Scan row shown: ${String(after)}`,
          `after Scan: ${String(scannedCalls)}`,
          `after Go to Key "${MISSING_KEY}": ${String(scannedCalls)}`,
          "",
        ].join("\n"),
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenLoadOnDemandCluster_whenConnect_thenNoScanOnAnyPrimary",
    async () => {
      const { datasource, password } = saved("cluster-od", "redis", REDIS_CLUSTER_CONFIG, true);
      const { page } = await launchSaved(datasource);
      const before = await scanCalls(REDIS_CLUSTER_CONFIG);
      await connect(page, datasource.name, password);
      await scanRow(page, NOT_SCANNED).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      const after = await scanCalls(REDIS_CLUSTER_CONFIG);
      expect(after - before).toBe(0);
      expect(await treeRows(page, "keyFolder").count()).toBe(0);
      expect(await treeRow(page, "clusterNodes", "Cluster nodes").count()).toBe(1);
      await captureWindow(page, "05-cluster");
      writeEvidence(
        "05-cluster-scan-calls.txt",
        `cmdstat_scan calls over every primary: ${String(before)} before connect, ${String(after)} after\n`,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenLoadOnOpen_whenConnect_thenDb0ScannedAsBefore",
    async () => {
      const before = await scanCalls(REDIS_CONFIG);
      const page = await launchEphemeral(REDIS);
      await scanned(page, /^db0/);
      expect(await scanRow(page, NOT_SCANNED).count()).toBe(0);
      expect(await scanCalls(REDIS_CONFIG)).toBeGreaterThan(before);
      await captureWindow(page, "06-default");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenLoadOnDemand_whenConnect_thenKeysShowsListRowAndNoFolders",
    async () => {
      const { datasource, password } = saved("etcd-od", "etcd", ETCD_CONFIG, false);
      const { page, userDataDir } = await launchSaved(datasource);
      await tickOnDemand(page, datasource.name, userDataDir, "07-etcd-dialog");

      await connect(page, datasource.name, password);
      const row = scanRow(page, NOT_LISTED);
      await row.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
      expect(await treeRow(page, "keyDatabase", /^Keys/).first().getAttribute("aria-expanded")).toBe("true");
      expect(await treeRows(page, "keyFolder").count()).toBe(0);
      expect(await treeRows(page, "keyEntry").count()).toBe(0);
      await captureWindow(page, "08-etcd-not-listed");

      await findAction(page, "Go to Key");
      const prompt = dialog(page);
      await prompt.getByLabel("Key name", { exact: true }).fill(SEEDED_ETCD_KEY);
      await prompt.getByLabel("Key name", { exact: true }).press("Enter");
      await expect
        .poll(() => keyTab(page).getByTestId("key-name").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(SEEDED_ETCD_KEY);
      await page.waitForTimeout(SETTLE_MS);
      expect(await scanRow(page, NOT_LISTED).count()).toBe(1);
      expect(await treeRows(page, "keyFolder").count()).toBe(0);
      await captureWindow(page, "10-etcd-reveal");

      await activate(page, scanRow(page, NOT_LISTED));
      await expect
        .poll(() => attributes(treeRows(page, "keyFolder"), "aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(
          expect.arrayContaining([
            "app/, folder, 5 keys",
            expect.stringMatching(/^bulk\/, folder, \d+ keys$/),
            "registry/, folder, 4 keys",
          ]),
        );
      expect(await scanRow(page, NOT_LISTED).count()).toBe(0);
      const app = treeRow(page, "keyFolder", /^app\/[\d,]+$/).first();
      await app.click();
      await page.keyboard.press("ArrowRight");
      await expect
        .poll(() => attributes(treeRows(page, "keyFolder"), "aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining([expect.stringMatching(/^config\/, folder/)]));
      await captureWindow(page, "09-etcd-listed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenLoadOnOpen_whenConnectEtcd_thenRootListedAsBefore",
    async () => {
      const page = await launchEphemeral(ETCD);
      await scanned(page, /^Keys/);
      expect(await scanRow(page, NOT_LISTED).count()).toBe(0);
      await expect
        .poll(() => attributes(treeRows(page, "keyFolder"), "aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["app/, folder, 5 keys"]));
      await captureWindow(page, "11-etcd-default");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
