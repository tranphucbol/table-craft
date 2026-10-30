/**
 * Plan 110: actual advanced etcd UI, private file grants and renewal death, in the headless box.
 * TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/110 bun run test:smoke:db:headless:etcd test/e2e/etcdAdvanced.smoke.test.ts
 * Only a unique namespace, one owned lease and one temporary user are changed; no auth toggles,
 * compaction or membership changes. Native dialogs are answered in main, not bypassed in renderer.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import etcd from "@table-craft/plugin-etcd";
import type { Session } from "@table-craft/plugin-api";
import { ETCD_CONFIG, ETCD_ROOT_USER, WITHOUT_ETCD } from "../support/databases.js";
import {
  closeApp,
  CLOSE_HOOK_TIMEOUT_MS,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";
import { dialog, keyTab, openKey } from "./redisLive.js";
import { stubSaveDialog } from "./workflows.js";

const capture = evidenceFor("110");
const PREFIX = `/live/etcd-advanced/${randomUUID()}/`;
const CONFIG = { ...ETCD_CONFIG, ...ETCD_ROOT_USER, namespace: PREFIX };
const SOURCE = { id: "advanced-etcd", pluginId: "etcd", config: CONFIG };
const USER = `tc_live_${randomUUID().replaceAll("-", "")}`;
const PASSWORD = "isolated-live-password";

describe.runIf(DATABASES_ENABLED && !WITHOUT_ETCD)("advanced etcd live UI", () => {
  let running: RunningApp | null = null;
  let session: Session | null = null;
  let ownedLease: string | null = null;

  async function launch(): Promise<Page> {
    session = await etcd.connect(CONFIG, { readOnly: false });
    running = await launchApp(SOURCE);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }
  async function value(key: string) {
    return (await session!.keyspace!.read(0, { text: key, hex: null }, { window: 1 })).value;
  }
  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
    try {
      if (session !== null) {
        await session.execute('del "" --prefix');
        if (ownedLease !== null) {
          const preview = await session.leases!.prepareRevoke(ownedLease);
          await session.leases!.revokePrepared(preview.token);
        }
        if ((await session.access!.users()).some((user) => user.name === USER))
          await session.access!.apply({ kind: "deleteUser", user: USER });
      }
    } finally {
      ownedLease = null;
      await session?.close();
      session = null;
    }
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenOwnedLease_whenGrantedAttachedRenewedThenRevokedExternally_thenStoppedReasonAndToggleOff",
    async () => {
      const page = await launch();
      await session!.execute("put attached before");
      const before = new Set((await session!.leases!.list()).map((lease) => lease.id));
      await findAction(page, "Leases");
      const leases = page.getByRole("region", { name: "leases", exact: true });
      await leases.getByRole("button", { name: "Grant Lease…", exact: true }).click();
      await dialog(page)
        .getByRole("option", { name: /5 minutes/ })
        .click();
      await dialog(page).getByRole("button", { name: "Continue", exact: true }).click();
      await expect
        .poll(async () => (await session!.leases!.list()).filter((lease) => !before.has(lease.id)).length, {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toBe(1);
      ownedLease = (await session!.leases!.list()).find((lease) => !before.has(lease.id))!.id;
      await leases.getByRole("button", { name: new RegExp(`^${ownedLease} `) }).click();
      await leases.getByRole("button", { name: "Attach Key…", exact: true }).click();
      await dialog(page)
        .getByRole("option", { name: /UTF-8 text/ })
        .click();
      await dialog(page).getByRole("button", { name: "Continue", exact: true }).click();
      await dialog(page).getByLabel("Namespace-relative key", { exact: true }).fill("attached");
      await dialog(page).getByRole("button", { name: "Read Key", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Attach Key", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await session!.keyspace!.read(0, { text: "attached", hex: null }, { window: 1 })).details.revision?.lease,
        )
        .toBe(ownedLease);
      const renew = leases.getByRole("button", { name: "Keep Alive", exact: true });
      await renew.click();
      await expect.poll(() => renew.getAttribute("aria-pressed")).toBe("true");
      await capture(page, "advanced-01-lease-attached-renewing");
      const preview = await session!.leases!.prepareRevoke(ownedLease);
      expect(preview.lease.outsideNamespaceKeyCount).toBe("0");
      await session!.leases!.revokePrepared(preview.token);
      ownedLease = null;
      await expect.poll(() => leases.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("Renewal stopped:");
      await expect.poll(() => renew.getAttribute("aria-pressed")).toBe("false");
      await capture(page, "advanced-02-renewal-stopped-after-owned-revoke");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenScopedWatch_whenPutDeleteThenExportImport_thenRealEventsAndPrivateFiles",
    async () => {
      const page = await launch();
      await findAction(page, "Watch Key or Prefix");
      await dialog(page)
        .getByLabel("Namespace-relative prefix (empty watches all keys)", { exact: true })
        .fill("watch/");
      await dialog(page).getByRole("button", { name: "Continue", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Start Watch", exact: true }).click();
      const watch = page.locator('[data-region="watch"]').last();
      await expect.poll(() => watch.getByRole("tab").textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("live");
      await session!.execute("put watch/a changed");
      await session!.execute("del watch/a");
      await expect.poll(() => watch.locator("tbody").textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("PUT");
      await expect.poll(() => watch.locator("tbody").textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("DELETE");
      const watchFile = join(running!.userDataDir, "watch.jsonl");
      await stubSaveDialog(running!.app, watchFile);
      await watch.getByRole("button", { name: "Export Retained Events…", exact: true }).click();
      await expect
        .poll(() => watch.textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("retained events as JSON Lines");
      const events = await readFile(watchFile, "utf8");
      expect(events).toContain('"PUT"');
      expect(events).toContain('"DELETE"');
      expect(events).toContain("watch/a");
      await findAction(page, "Services");
      await capture(page, "advanced-03-watch-put-delete-private-export");
      await watch.getByRole("button", { name: "Stop", exact: true }).click();

      await session!.execute("put transferred roundtrip");
      const transferFile = join(running!.userDataDir, "keys.json");
      await stubSaveDialog(running!.app, transferFile);
      await findAction(page, "Export Key Range to JSON");
      await dialog(page).getByRole("button", { name: "Choose Export File", exact: true }).click();
      await expect
        .poll(async () => readFile(transferFile, "utf8").catch(() => ""), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("roundtrip");
      const exported = JSON.parse(await readFile(transferFile, "utf8")) as {
        namespace: { encoding: string; data: string };
        records: unknown[];
      };
      expect(exported.namespace).toEqual({ encoding: "utf8", data: PREFIX });
      expect(exported.records).toHaveLength(1);
      await session!.execute("del transferred");
      await running!.app.evaluate(({ dialog: native }, path) => {
        native.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
      }, transferFile);
      await findAction(page, "Import Keys from JSON");
      await dialog(page).getByRole("button", { name: "Skip Existing", exact: true }).click();
      await expect.poll(() => value("transferred"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("roundtrip");
      await openKey(page, "transferred");
      await expect
        .poll(() => keyTab(page).getByTestId("value-editor").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("roundtrip");
      await capture(page, "advanced-04-scoped-private-import-export");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenRootConnection_whenTemporaryUserCreatedAndDeleted_thenPrivateCredentialFlow",
    async () => {
      const page = await launch();
      await findAction(page, "Users & Roles");
      const access = page.getByRole("region", { name: "access", exact: true });
      await expect.poll(() => access.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("Current user: root");
      await access.getByRole("button", { name: "New…", exact: true }).first().click();
      await dialog(page).getByLabel("Name", { exact: true }).fill(USER);
      await dialog(page).getByRole("button", { name: "Continue", exact: true }).click();
      await dialog(page).getByLabel("New password", { exact: true }).fill(PASSWORD);
      await dialog(page).getByRole("button", { name: "Apply Password", exact: true }).click();
      await access.getByRole("button", { name: USER, exact: true }).click();
      await capture(page, "advanced-05-temporary-user-private-credentials");
      await access.getByRole("button", { name: "Delete User…", exact: true }).click();
      await dialog(page).getByRole("button", { name: "Apply Change", exact: true }).click();
      await expect.poll(async () => (await session!.access!.users()).some((user) => user.name === USER)).toBe(false);
      expect(await page.locator("body").textContent()).not.toContain(PASSWORD);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTxnText_whenVisualValueChanged_thenConsoleRoundtripWithoutExecution",
    async () => {
      const page = await launch();
      const text = 'txn\nif: version("built") = "0"\nthen: put built before\nelse: get built\nend';
      await sqlEditor(page).fill(text);
      await findAction(page, "Txn Builder");
      const builder = page.getByRole("region", { name: "Transaction builder", exact: true });
      const then = builder.getByRole("region", { name: "Then", exact: true });
      await then.getByLabel("Value", { exact: true }).fill("after");
      await expect.poll(() => sqlEditor(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("after");
      await builder.getByRole("button", { name: /Read Transaction at Caret/ }).click();
      await expect.poll(() => then.getByLabel("Value", { exact: true }).inputValue()).toBe("after");
      expect(await value("built")).toBeNull();
      await capture(page, "advanced-06-visual-txn-roundtrip-not-executed");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
