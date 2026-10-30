import { randomUUID } from "node:crypto";
import type { KeyHistoryEvent, Keyspace, Session } from "@table-craft/plugin-api";
import etcd from "@table-craft/plugin-etcd";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { ETCD35_CONFIG, ETCD_CONFIG, WITHOUT_ETCD } from "../support/databases.js";
import {
  answerSecretPrompt,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  waitUntilReady,
} from "./harness.js";
import { attributes, dialog, keyButton, keyTab, openKey } from "./redisLive.js";

const captureWindow = evidenceFor("110");
const DATABASE = 0;
const READ_WINDOW = 10;
const LEASE_MS = 600_000;
const MAX_MERGE_CONFLICTS = 10;
const RESTORE_NOTICE = "Historical value staged. The current lease is kept; an old lease is not restored.";
const INITIAL = JSON.stringify({ service: "billing", mode: "draft", retries: 1 }, null, 2);
const PRIOR = JSON.stringify({ service: "billing", mode: "safe", retries: 2 }, null, 2);
const CURRENT = JSON.stringify({ service: "billing", mode: "fast", retries: 5 }, null, 2);
const RESOLVED = JSON.stringify({ service: "billing", mode: "reviewed", retries: 3 }, null, 2);
const RACED = JSON.stringify({ service: "billing", mode: "external", retries: 8 }, null, 2);

interface Fixture {
  readonly key: string;
  readonly session: Session;
  readonly keyspace: Keyspace;
  readonly events: readonly KeyHistoryEvent[];
  readonly save: (value: string, ttlMs?: number) => Promise<void>;
  readonly current: () => ReturnType<Keyspace["read"]>;
}

async function withHistory(config: object, use: (fixture: Fixture) => Promise<void>): Promise<void> {
  const key = `/live/etcd-history/${randomUUID()}`;
  const name = { text: key, hex: null };
  const session = await etcd.connect(config, { readOnly: false });
  const keyspace = session.keyspace;
  const leases = new Set<string>();
  try {
    if (keyspace?.history === undefined) throw new Error("etcd history is unavailable");
    const read = () => keyspace.read(DATABASE, name, { window: READ_WINDOW });
    const remember = async () => {
      const lease = (await read()).details.revision?.lease;
      if (lease !== undefined && lease !== "0") leases.add(lease);
    };
    const save = async (value: string, ttlMs?: number) => {
      await keyspace.apply(
        DATABASE,
        name,
        [{ kind: "setString", value: { text: value, hex: null }, original: null }],
        ttlMs === undefined ? { type: "string", guard: false } : { type: "string", guard: false, ttlMs },
      );
      await remember();
    };
    await save(INITIAL);
    await save(PRIOR);
    await keyspace.remove(DATABASE, [name]);
    await save(CURRENT, LEASE_MS);
    expect((await read()).details.revision?.lease).not.toBe("0");
    const page = await keyspace.history({
      database: DATABASE,
      key: name,
      cursor: null,
      count: READ_WINDOW,
      maxBytes: 4096,
      timeoutMs: 2000,
    });
    expect(page.complete).toBe(true);
    expect(page.events.map((event) => event.kind)).toEqual(["PUT", "PUT", "DELETE", "PUT"]);
    await use({
      key,
      session,
      keyspace,
      events: page.events,
      save,
      current: async () => {
        await remember();
        return read();
      },
    });
  } finally {
    try {
      await keyspace?.remove(DATABASE, [name]);
      for (const lease of leases) {
        await session.execute(`lease revoke ${BigInt(lease).toString(16)}`).catch(() => undefined);
      }
    } finally {
      await session.close();
    }
  }
}

/** The mounted CodeMirror document, one `.cm-line` per line; `.cm-content`'s text drops the newlines. */
function editor(page: Page) {
  const lines = keyTab(page).getByTestId("value-editor").locator(".cm-content .cm-line");
  return { textContent: async () => (await lines.allTextContents()).join("\n") };
}

function history(page: Page) {
  return keyTab(page).getByTestId("key-history");
}

async function selectPrior(page: Page, fixture: Fixture): Promise<void> {
  await keyButton(page, "History").click();
  const versions = history(page).getByRole("complementary", { name: "Key versions" }).getByRole("button");
  await expect.poll(() => versions.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(fixture.events.length);
  const prior = fixture.events[1];
  if (prior === undefined) throw new Error("prior event missing");
  await history(page)
    .locator(`button[title="PUT · v${prior.version} · rev ${prior.modRevision} · lease ${prior.lease}"]`)
    .click();
}

async function withApp(use: (page: Page) => Promise<void>, readOnly = false): Promise<void> {
  const config = readOnly ? ETCD35_CONFIG : ETCD_CONFIG;
  const profile = newProfile();
  if (readOnly) {
    const plain = { host: ETCD35_CONFIG.host, port: ETCD35_CONFIG.port, user: ETCD35_CONFIG.user };
    seedDatasources(profile, [
      {
        id: "etcd-history-ro",
        name: "etcd-history-ro",
        pluginId: "etcd",
        config: plain,
        secretModes: { password: "untilRestart" },
        readOnly: true,
      },
    ]);
  }
  const running = await launchApp(readOnly ? null : { id: "etcd-history", pluginId: "etcd", config }, {
    userDataDir: profile,
  });
  try {
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (readOnly) {
      await openConsoleOn(running.page, "etcd-history-ro");
      // The 3.5 server has auth off; its password is the empty string the prompt is answered with.
      await answerSecretPrompt(running.page, "etcd-history-ro", ETCD35_CONFIG.password);
    }
    await waitUntilReady(running.page);
    await use(running.page);
  } finally {
    await closeApp(running.app);
  }
}

describe.runIf(DATABASES_ENABLED && !WITHOUT_ETCD)("etcd History, Restore and Merge live integration", () => {
  it(
    "givenDeleteRecreateHistory_whenRestored_thenRealDiffPendingOnlyAndSubmitKeepsCurrentLease",
    async () => {
      await withHistory(ETCD_CONFIG, async (fixture) => {
        const before = await fixture.current();
        await withApp(async (page) => {
          await openKey(page, fixture.key);
          await selectPrior(page, fixture);
          const versions = history(page).getByRole("complementary", { name: "Key versions" }).getByRole("button");
          expect(await attributes(versions, "title")).toEqual(
            [...fixture.events]
              .reverse()
              .map((event) => `${event.kind} · v${event.version} · rev ${event.modRevision} · lease ${event.lease}`),
          );
          expect(await history(page).textContent()).toContain("No timestamps are available. Ages count revisions.");
          expect(await versions.allTextContents()).toEqual(
            expect.arrayContaining([expect.stringContaining("DeletedKey removed")]),
          );
          const comparison = history(page).getByRole("region", { name: "Value comparison" });
          expect(await comparison.textContent()).toContain('"safe"');
          expect(await comparison.textContent()).toContain('"fast"');
          expect(await comparison.textContent()).toMatch(/−.*safe/);
          expect(await comparison.textContent()).toMatch(/\+.*fast/);
          await captureWindow(page, "10-history-real-diff");

          await keyButton(page, "Restore Selected Version").click();
          await expect.poll(() => editor(page).textContent()).toBe(PRIOR);
          expect(await keyTab(page).getByTestId("key-notice").textContent()).toBe(RESTORE_NOTICE);
          expect(await fixture.current()).toMatchObject({
            value: CURRENT,
            details: { revision: before.details.revision },
          });
          expect(await keyTab(page).getByTestId("pending-changes").textContent()).toContain("1");
          await captureWindow(page, "11-restore-pending-only");
          await keyButton(page, "Preview Pending Changes").click();
          const preview = dialog(page);
          await expect.poll(() => preview.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("txn");
          expect(await preview.textContent()).toContain("--ignore-lease");
          expect(await preview.textContent()).toContain(before.details.revision?.modRevision);
          expect((await fixture.current()).value).toBe(CURRENT);
          await captureWindow(page, "12-restore-preview");
          await preview.getByRole("button", { name: "Submit", exact: true }).click();
          await expect
            .poll(() => keyTab(page).getByTestId("key-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
            .toBe(`Saved as v${String(BigInt(before.details.revision?.version ?? "0") + 1n)}`);
          await expect.poll(() => editor(page).textContent()).toBe(PRIOR);
          const after = await fixture.current();
          expect(after.value).toBe(PRIOR);
          expect(after.details.revision?.lease).toBe(before.details.revision?.lease);
          expect(after.details.revision?.lease).not.toBe("0");
          expect(BigInt(after.details.revision?.modRevision ?? "0")).toBeGreaterThan(
            BigInt(before.details.revision?.modRevision ?? "0"),
          );
          expect(await keyTab(page).getByTestId("pending-changes").count()).toBe(0);
          await captureWindow(page, "13-restore-confirmed-lease-preserved");
        });
      });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSameBytesAba_whenRestoreSubmitted_thenMergeAndRepeatedConflictRetainsResolvedResult",
    async () => {
      await withHistory(ETCD_CONFIG, async (fixture) => {
        const before = await fixture.current();
        await withApp(async (page) => {
          await openKey(page, fixture.key);
          await selectPrior(page, fixture);
          await keyButton(page, "Restore Selected Version").click();
          await expect.poll(() => editor(page).textContent()).toBe(PRIOR);
          await fixture.save(CURRENT);
          const aba = await fixture.current();
          expect(aba.value).toBe(before.value);
          expect(aba.details.revision?.modRevision).not.toBe(before.details.revision?.modRevision);
          await keyButton(page, "Submit").click();
          const merge = keyTab(page).getByTestId("key-merge");
          await merge.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
          expect(await merge.getByRole("region", { name: "Theirs", exact: true }).textContent()).toContain('"fast"');
          expect(await merge.getByRole("region", { name: "Yours", exact: true }).textContent()).toContain('"safe"');
          expect((await fixture.current()).value).toBe(CURRENT);
          await captureWindow(page, "14-merge-same-bytes-aba");

          const result = merge.getByRole("textbox", { name: "Merged result" });
          await result.fill(RESOLVED);
          await merge.getByRole("button", { name: "Mark Result Resolved", exact: true }).click();
          await fixture.save(RACED);
          await merge.getByRole("button", { name: "Save Merged", exact: true }).click();
          await expect.poll(() => merge.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("Changed again:");
          expect(await result.inputValue()).toBe(RESOLVED);
          expect(await merge.getByRole("region", { name: "Yours", exact: true }).textContent()).toContain('"reviewed"');
          expect((await fixture.current()).value).toBe(RACED);
          expect(await merge.getByRole("button", { name: "Save Merged", exact: true }).isEnabled()).toBe(false);
          await captureWindow(page, "15-merge-repeated-conflict-result-retained");
          const useYours = merge.getByRole("button", { name: "Use yours", exact: true });
          const conflicts = await useYours.count();
          expect(conflicts).toBeGreaterThan(0);
          expect(conflicts).toBeLessThanOrEqual(MAX_MERGE_CONFLICTS);
          for (let remaining = conflicts; remaining > 0; remaining--) {
            await useYours.first().click();
            await expect.poll(() => useYours.count()).toBe(remaining - 1);
          }
          await expect
            .poll(() => merge.getByRole("button", { name: "Save Merged", exact: true }).isEnabled())
            .toBe(true);
          expect(await result.inputValue()).toBe(RESOLVED);
          await captureWindow(page, "16-merge-resolved");
          await merge.getByRole("button", { name: "Save Merged", exact: true }).click();
          await expect.poll(() => merge.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
          const after = await fixture.current();
          expect(after.value).toBe(RESOLVED);
          expect(after.details.revision?.lease).toBe(before.details.revision?.lease);
          expect(BigInt(after.details.revision?.modRevision ?? "0")).toBeGreaterThan(
            BigInt(aba.details.revision?.modRevision ?? "0"),
          );
          await captureWindow(page, "17-merged-submit-confirmed");
        });
      });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenKeyDeletedThenRecreatedDifferently_whenSubmitted_thenEachMergeNeedsExplicitResolution",
    async () => {
      await withHistory(ETCD_CONFIG, async (fixture) => {
        await withApp(async (page) => {
          await openKey(page, fixture.key);
          await selectPrior(page, fixture);
          await keyButton(page, "Restore Selected Version").click();
          await expect.poll(() => editor(page).textContent()).toBe(PRIOR);
          await fixture.keyspace.remove(DATABASE, [{ text: fixture.key, hex: null }]);
          await keyButton(page, "Submit").click();
          const merge = keyTab(page).getByTestId("key-merge");
          await merge.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
          expect(await merge.textContent()).toContain("Someone else deleted this key while you were editing.");
          expect(await merge.getByRole("region", { name: "Theirs", exact: true }).textContent()).toContain(
            "key absent",
          );
          expect((await fixture.current()).details.type).toBeNull();
          const save = merge.getByRole("button", { name: "Save Merged", exact: true });
          expect(await save.isEnabled()).toBe(false);
          await captureWindow(page, "19-merge-deleted-by-theirs");

          await merge.getByRole("button", { name: "Use yours", exact: true }).first().click();
          await expect.poll(() => save.isEnabled()).toBe(true);
          await fixture.save(RACED);
          await save.click();
          await expect.poll(() => merge.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("Changed again:");
          expect(await merge.getByRole("region", { name: "Theirs", exact: true }).textContent()).toContain(
            '"external"',
          );
          expect((await fixture.current()).value).toBe(RACED);
          expect(await save.isEnabled()).toBe(false);
          await captureWindow(page, "20-merge-recreated-differently");

          const useYours = merge.getByRole("button", { name: "Use yours", exact: true });
          const conflicts = await useYours.count();
          expect(conflicts).toBeGreaterThan(0);
          expect(conflicts).toBeLessThanOrEqual(MAX_MERGE_CONFLICTS);
          for (let remaining = conflicts; remaining > 0; remaining--) {
            await useYours.first().click();
            await expect.poll(() => useYours.count()).toBe(remaining - 1);
          }
          await expect.poll(() => save.isEnabled()).toBe(true);
          await save.click();
          await expect.poll(() => merge.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
          const merged = (await fixture.current()).value;
          expect(typeof merged).toBe("string");
          expect(JSON.parse(merged as string)).toEqual(JSON.parse(PRIOR));
        });
      });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenReadOnlyDatasource_whenHistorySelected_thenDiffAvailableRestoreAndSubmitDisabled",
    async () => {
      await withHistory(ETCD35_CONFIG, async (fixture) => {
        const before = await fixture.current();
        await withApp(async (page) => {
          await openKey(page, fixture.key);
          await selectPrior(page, fixture);
          expect(await history(page).getByRole("region", { name: "Value comparison" }).textContent()).toContain(
            '"safe"',
          );
          expect(await keyButton(page, "Restore Selected Version").isEnabled()).toBe(false);
          expect(await keyButton(page, "Submit").isEnabled()).toBe(false);
          await captureWindow(page, "18-readonly-history-no-restore");
          expect(await fixture.current()).toMatchObject({
            value: CURRENT,
            details: { revision: before.details.revision },
          });
        }, true);
      });
    },
    SCENARIO_TIMEOUT_MS,
  );
});
