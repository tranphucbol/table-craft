/**
 * Plan 110's live test: the etcd plugin against the `test/db/compose.yml` etcd 3.6 server (auth on)
 * and 3.5 (no auth). Gated, because it needs a display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/110 bun run test:smoke:db:headless:etcd test/e2e/etcd.smoke.test.ts
 *
 * Scratch keys live under `/live/etcd/` and are removed by the suite; seeded keys are only read.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import etcd from "@table-craft/plugin-etcd";
import { ETCD35_CONFIG, ETCD_CONFIG, WITHOUT_ETCD } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  datasourceStatus,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
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
  attributes,
  dialog,
  expand,
  keyButton,
  keyTab,
  openKey,
  outputLog,
  runCommand,
  scanned,
  showFromDatasourceMenu,
  treeRow,
  treeRows,
} from "./redisLive.js";

const captureWindow = evidenceFor("110");

const ETCD: Datasource = { id: "etcd", pluginId: "etcd", config: ETCD_CONFIG };
const ETCD35: Datasource = { id: "etcd35", pluginId: "etcd", config: ETCD35_CONFIG };

const LIVE_PREFIX = "/live/etcd/";
const EDIT_KEY = `${LIVE_PREFIX}edit`;
const CONFLICT_KEY = `${LIVE_PREFIX}conflict`;
const TXN_KEY = `${LIVE_PREFIX}txn`;
const JSON_KEY = "/app/config/db.json";
const BULK_KEYS = 30;

/** Runs `commands` on `config` through the plugin, outside the app. */
async function onEtcd(config: object, commands: readonly string[]): Promise<void> {
  const session = await etcd.connect(etcd.connectionSchema.parse(config), { readOnly: false });
  try {
    for (const command of commands) await session.execute(command);
  } finally {
    await session.close();
  }
}

async function valueOn(config: object, key: string): Promise<string | null> {
  const session = await etcd.connect(etcd.connectionSchema.parse(config), { readOnly: true });
  try {
    const contents = await session.keyspace?.read(0, { text: key, hex: null }, { window: 1 });
    return typeof contents?.value === "string" ? contents.value : null;
  } finally {
    await session.close();
  }
}

function valueEditor(page: Page) {
  return keyTab(page).getByTestId("value-editor").locator(".cm-content");
}

async function replaceValue(page: Page, text: string): Promise<void> {
  await valueEditor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
}

const CLEAN_LIVE_KEYS = `del ${LIVE_PREFIX} --prefix`;

describe.runIf(DATABASES_ENABLED)("etcd live test", () => {
  let running: RunningApp | null = null;

  beforeAll(async () => {
    if (WITHOUT_ETCD) return;
    await onEtcd(ETCD_CONFIG, [CLEAN_LIVE_KEYS]);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    if (WITHOUT_ETCD) return;
    await onEtcd(ETCD_CONFIG, [CLEAN_LIVE_KEYS]);
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

  it.skipIf(WITHOUT_ETCD)(
    "givenSeededEtcd_whenConnected_thenKeysGroupIntoSlashFolders",
    async () => {
      const page = await launch(ETCD);
      await scanned(page, /^db0/);

      // A folder row's text is its prefix then its key count, as `/44`.
      await expand(page, treeRow(page, "keyFolder", /^\/[\d,]+$/));
      await expect
        .poll(() => attributes(treeRows(page, "keyFolder"), "aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["/app/ 5", `/bulk/ ${String(BULK_KEYS)}`, "/registry/ 4"]));
      await expand(page, treeRow(page, "keyFolder", /^\/app\/[\d,]+$/));
      await expand(page, treeRow(page, "keyFolder", /^\/app\/config\/[\d,]+$/));
      await expect
        .poll(() => attributes(treeRows(page, "keyEntry"), "aria-label"))
        .toEqual(expect.arrayContaining([expect.stringMatching(/ db\.json, no TTL$/)]));
      await expand(page, treeRow(page, "keyFolder", /^\/app\/session\/[\d,]+$/));
      await expect
        .poll(() => treeRow(page, "keyEntry", "token").first().getAttribute("aria-label"))
        .toMatch(/ token, \d+ d$/);
      await captureWindow(page, "01-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenJsonKey_whenOpenedWithDetails_thenValueAndRevisionAttributes",
    async () => {
      const page = await launch(ETCD);
      await openKey(page, JSON_KEY);

      await expect
        .poll(() => keyTab(page).getByTestId("value-editor").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("db.internal");
      await expect.poll(() => keyTab(page).getByTestId("key-facts").textContent()).toMatch(/^v1 · /);

      await findAction(page, "Key Details");
      const details = keyTab(page).getByTestId("key-details");
      await details.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const text = (await details.textContent()) ?? "";
      for (const label of ["Size", "Create revision", "Mod revision", "Version", "Lease"]) {
        expect(text, label).toContain(label);
      }
      await captureWindow(page, "02-json-details");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenStringEdit_whenPreviewedAndSubmitted_thenOneGuardedTxnAndRereadValue",
    async () => {
      await onEtcd(ETCD_CONFIG, [`put ${EDIT_KEY} before`]);
      const page = await launch(ETCD);
      await openKey(page, EDIT_KEY);
      await expect.poll(() => valueEditor(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("before");

      await replaceValue(page, "after");
      await keyButton(page, "Preview Pending Changes").click();
      const preview = dialog(page);
      await expect.poll(() => preview.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("txn");
      expect(await preview.textContent()).toContain(EDIT_KEY);
      await captureWindow(page, "03-preview");
      await preview.getByRole("button", { name: "Submit", exact: true }).click();

      await expect
        .poll(() => keyTab(page).getByTestId("key-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/^Submitted/);
      await expect.poll(() => valueEditor(page).textContent()).toBe("after");
      expect(await valueOn(ETCD_CONFIG, EDIT_KEY)).toBe("after");
      await expect.poll(() => keyTab(page).getByTestId("key-facts").textContent()).toMatch(/^v2 · /);
      await captureWindow(page, "04-submitted");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenValueChangedElsewhere_whenSubmitted_thenConflictThenReload",
    async () => {
      await onEtcd(ETCD_CONFIG, [`put ${CONFLICT_KEY} ann`]);
      const page = await launch(ETCD);
      await openKey(page, CONFLICT_KEY);
      await expect.poll(() => valueEditor(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("ann");
      await replaceValue(page, "bo");
      await onEtcd(ETCD_CONFIG, [`put ${CONFLICT_KEY} zed`]);

      await keyButton(page, "Submit").click();
      const conflict = keyTab(page).getByTestId("key-conflict");
      await conflict.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await valueOn(ETCD_CONFIG, CONFLICT_KEY)).toBe("zed");
      await captureWindow(page, "05-conflict");

      await keyTab(page).getByTestId("key-conflict-reload").click();
      await expect.poll(() => conflict.count()).toBe(0);
      await expect.poll(() => valueEditor(page).textContent()).toBe("zed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenConsole_whenGetAndTxn_thenKvRowsAndTxnVerdict",
    async () => {
      await onEtcd(ETCD_CONFIG, [`put ${TXN_KEY} a`]);
      const page = await launch(ETCD);

      await sqlEditor(page).fill("get /app/feature/flags");
      await runAllButton(page).click();
      await expect
        .poll(async () => (await gridText(page)).headers, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["key", "value", "create_revision", "mod_revision", "version", "lease"]));
      expect((await gridText(page)).cells).toEqual(expect.arrayContaining(["/app/feature/flags"]));
      await waitUntilReady(page);
      await captureWindow(page, "06-console-get");

      await runCommand(
        page,
        ["txn", `if: value("${TXN_KEY}") = "a"`, `then: put ${TXN_KEY} b`, `else: put ${TXN_KEY} c`, "end"].join("\n"),
        "SUCCESS",
      );
      expect(await valueOn(ETCD_CONFIG, TXN_KEY)).toBe("b");
      await captureWindow(page, "07-console-txn");
      expect(await outputLog(page).textContent()).not.toContain("FAILURE");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenServerTab_whenOpenedWithAndWithoutAuth_thenServerCardsOrNotesNeverAnError",
    async () => {
      const page = await launch(ETCD35);
      await showFromDatasourceMenu(page, ETCD35.id, /^Server Info/);
      const server = page.getByTestId("server-tab");
      const cards = server.getByTestId("server-card");
      await cards.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await attributes(cards, "aria-label")).toEqual(expect.arrayContaining(["Server", "Storage"]));
      await captureWindow(page, "08-server");
      await closeApp(running?.app);

      // Plan 110 decision 9: a maintenance call `table_craft` may not make leaves a note, not a failure.
      const authed = await launch(ETCD);
      await showFromDatasourceMenu(authed, ETCD.id, /^Server Info/);
      const authedCards = authed.getByTestId("server-tab").getByTestId("server-card");
      await authedCards.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await authed.getByTestId("server-error").count()).toBe(0);
      await captureWindow(authed, "08-server-auth");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenEtcd35WithoutAuth_whenConnected_thenVersionTreeAndMemberList",
    async () => {
      const page = await launch(ETCD35);
      await scanned(page, /^db0/);
      await expect
        .poll(() => datasourceStatus(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/3\.5\.\d+/);

      await sqlEditor(page).fill("member list");
      await runAllButton(page).click();
      await expect
        .poll(async () => (await gridText(page)).headers, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["id", "status", "name", "peer_urls", "client_urls", "is_learner"]));
      expect((await gridText(page)).cells).toEqual(expect.arrayContaining(["etcd-3-5"]));
      await captureWindow(page, "09-etcd35-members");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
