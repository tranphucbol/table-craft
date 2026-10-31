/**
 * Plan 133's live test: the Redis plugin's Sentinel mode against the `redis-sentinel` service of
 * `test/db/compose.yml`. Gated, because it needs a display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/133 bun run test:smoke:db:headless:redis test/e2e/redisSentinel.smoke.test.ts
 *
 * The failover moves the master; every scenario asks Sentinel rather than assuming a port.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { REDIS_SENTINEL_CONFIG, SSH_BASTION, WITHOUT_REDIS } from "../support/databases.js";
import { connectRedis, failover, nodesOf, replicaInSync } from "../support/redisSentinel.js";
import {
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  dataSourcesDialog,
  datasourceStatus,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import {
  explorer,
  expand,
  outputLog,
  runCommand,
  scanned,
  showFromDatasourceMenu,
  treeRow,
  treeRows,
} from "./redisLive.js";

const captureWindow = evidenceFor("133");

const SENTINEL: Datasource = { id: "sentinel", pluginId: "redis", config: REDIS_SENTINEL_CONFIG };
const SCRATCH_KEY = "live:sentinel";
const FAILOVER_SCENARIO_TIMEOUT_MS = SCENARIO_TIMEOUT_MS * 2;
const INCREMENT = 41;

/** The replica's Run on value, as the plugin names it for this configuration. */
async function replicaId(): Promise<string> {
  const session = await connectRedis();
  try {
    const replica = (await nodesOf(session)).find((node) => node.role === "replica");
    if (replica === undefined) throw new Error("Sentinel's master lists no replica");
    return replica.id;
  } finally {
    await session.close();
  }
}

async function dropScratchKey(): Promise<void> {
  const session = await connectRedis();
  try {
    await session.execute(`DEL ${SCRATCH_KEY}`);
  } finally {
    await session.close();
  }
}

function field(page: Page, label: string) {
  return dataSourcesDialog(page).getByLabel(label, { exact: true });
}

async function testResult(page: Page, trustBastion = false): Promise<string> {
  const dialog = dataSourcesDialog(page);
  await dialog.getByRole("button", { name: "Test Connection" }).click();
  if (trustBastion) {
    const prompt = page.getByRole("dialog", { name: "Unknown SSH host key" });
    await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await prompt.getByRole("button", { name: "Trust", exact: true }).click();
    await prompt.waitFor({ state: "detached" });
  }
  const result = dialog.getByTestId("test-result");
  await result.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await expect.poll(() => result.getAttribute("data-ok"), { timeout: LAUNCH_TIMEOUT_MS }).not.toBeNull();
  return (await result.textContent()) ?? "";
}

describe.runIf(DATABASES_ENABLED)("redis sentinel live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (!WITHOUT_REDIS) await dropScratchKey();
  }, SCENARIO_TIMEOUT_MS);

  async function launch(datasource: Datasource | null): Promise<Page> {
    await replicaInSync();
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_REDIS)(
    "givenSentinelMode_whenWrongMasterNameOrSsh_thenFormShowsSentinelFieldsAndNamesTheFix",
    async () => {
      const page = await launch(null);
      await explorer(page).getByRole("button", { name: "New Data Source…", exact: true }).click();
      const dialog = dataSourcesDialog(page);
      await dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: "Redis" }).click();
      await chooseOption(field(page, "Mode"), "sentinel");
      await field(page, "Master name").waitFor();
      for (const label of ["Other sentinels", "Sentinel password", "Database", "Node address map"]) {
        expect(await field(page, label).count(), label).toBe(1);
      }
      await field(page, "Master name").fill("nope");
      await field(page, "Host").fill(REDIS_SENTINEL_CONFIG.host);
      await field(page, "Port").fill(String(REDIS_SENTINEL_CONFIG.port));
      await field(page, "Other sentinels").fill(REDIS_SENTINEL_CONFIG.sentinels);
      await field(page, "Sentinel password").fill(REDIS_SENTINEL_CONFIG.sentinelPassword);
      await field(page, "Username").fill(REDIS_SENTINEL_CONFIG.user);
      await field(page, "Password").fill(REDIS_SENTINEL_CONFIG.password);
      await field(page, "Node address map").fill(REDIS_SENTINEL_CONFIG.nodeAddressMap);
      await captureWindow(page, "01-form");

      expect(await testResult(page)).toContain("No Sentinel monitors a master named nope.");
      await captureWindow(page, "02-wrong-name");

      await field(page, "Master name").fill(REDIS_SENTINEL_CONFIG.masterName);
      await dialog.getByLabel("Use SSH tunnel", { exact: true }).check();
      await field(page, "SSH host").fill(SSH_BASTION.host);
      await field(page, "SSH port").fill(String(SSH_BASTION.port));
      await field(page, "SSH user").fill(SSH_BASTION.user);
      await field(page, "SSH password").fill(SSH_BASTION.password);
      expect(await testResult(page, true)).toContain("An SSH tunnel reaches the Sentinel, not the master it names");
      await captureWindow(page, "07-ssh");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenSentinelDatasource_whenOpened_thenTreeListsSeedKeysAndNodesGroup",
    async () => {
      const page = await launch(SENTINEL);
      await scanned(page, /^db0/);
      expect(await treeRow(page, "keyDatabase", /^db1/).count()).toBe(1);
      await expect.poll(() => datasourceStatus(page).textContent()).toMatch(/ · db0 · [\d,]+ keys$/);
      await expand(page, treeRow(page, "clusterNodes", /^Nodes/));
      const nodes = treeRows(page, "clusterNode");
      await expect.poll(() => nodes.count()).toBe(2);
      const labels = await nodes.allTextContents();
      expect(labels.filter((label) => / primary$/.test(label))).toHaveLength(1);
      expect(labels.filter((label) => / replica of /.test(label))).toHaveLength(1);
      await captureWindow(page, "03-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRunOnReplica_whenGetThenSet_thenReplicaAnswersAndRefusesTheWrite",
    async () => {
      const replica = await replicaId();
      const page = await launch(SENTINEL);
      const runOn = page.getByTestId("run-on");
      await runOn.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await chooseOption(runOn, replica);
      await sqlEditor(page).fill("GET type_probe:string");
      await runAllButton(page).click();
      await expect.poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS }).toContain("hello");
      await waitUntilReady(page);

      await sqlEditor(page).fill(`SET ${SCRATCH_KEY} 1`);
      await runAllButton(page).click();
      await expect
        .poll(() => consoleAlert(page).first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("READONLY");
      await captureWindow(page, "04-run-on");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenServerTab_whenOpened_thenOverviewListsPrimaryAndReplica",
    async () => {
      const page = await launch(SENTINEL);
      await showFromDatasourceMenu(page, SENTINEL.id, /^Server Info/);
      const overview = page.getByTestId("server-overview");
      await expect.poll(() => overview.locator("tbody tr").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(2);
      await captureWindow(page, "05-server");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenSentinelDatasource_whenFailoverThenRun_thenConsoleReconnectsToNewPrimary",
    async () => {
      await dropScratchKey();
      const page = await launch(SENTINEL);
      await runCommand(page, "PING", "PONG");
      const { after } = await failover();

      const expected = `(integer) ${String(INCREMENT)}`;
      await sqlEditor(page).fill(`INCRBY ${SCRATCH_KEY} ${String(INCREMENT)}`);
      await runAllButton(page).click();
      await expect
        .poll(
          async () =>
            ((await outputLog(page).textContent()) ?? "").includes(expected) || (await consoleAlert(page).count()) > 0,
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .toBe(true);
      if (!((await outputLog(page).textContent()) ?? "").includes(expected)) {
        await waitUntilReady(page);
        await runAllButton(page).click();
        await expect.poll(() => outputLog(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain(expected);
      }
      await captureWindow(page, "06-failover");

      const session = await connectRedis();
      try {
        expect((await session.execute(`GET ${SCRATCH_KEY}`)).reply?.text).toBe(`"${String(INCREMENT)}"`);
        const primary = (await nodesOf(session)).find((node) => node.role === "primary");
        expect(primary?.address.split(":").at(-1)).toBe(after.split(":").at(-1));
      } finally {
        await session.close();
      }
    },
    FAILOVER_SCENARIO_TIMEOUT_MS,
  );
});
