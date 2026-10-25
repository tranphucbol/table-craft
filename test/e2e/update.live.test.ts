/**
 * Plan 020's live test: two packaged test builds (`TABLE_CRAFT_UPDATE_TEST_BUILD=1`, named
 * "TableCraft Update Test" so their bundle, profile and keychain item are their own), the older one
 * installed into a writable folder, updating to the newer one's real zip from a local server signed
 * with a throwaway key. Gated by `TABLE_CRAFT_UPDATE_LIVE`, the folder holding `v<old>/` and
 * `v<new>/` as `desktop:package` left them; macOS only.
 *
 *   TABLE_CRAFT_UPDATE_LIVE=<dir> TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/020 \
 *     bunx vitest run test/e2e/update.live.test.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { Locator } from "playwright-core";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  launchApp,
  newProfile,
  SCRATCH,
  setWindowSize,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";
import {
  logLines,
  loggedUpdate,
  OTHER_KEYS,
  overrides,
  rightGroupNames,
  serve,
  updateButton,
  updateLines,
  type AssetResponder,
  type LocalServer,
  type Release,
} from "./updateServer.js";

const LIVE_DIR = process.env["TABLE_CRAFT_UPDATE_LIVE"] ?? "";
const LIVE = LIVE_DIR !== "" && process.platform === "darwin";
const OLD = "0.1.1";
const NEW = "0.2.0";
const PRODUCT = "TableCraft Update Test";
const BUNDLE = `${PRODUCT}.app`;
const EXECUTABLE = join("Contents", "MacOS", PRODUCT);
const ARCH = process.arch;
const KEYCHAIN_SERVICE = `${PRODUCT} Safe Storage`;
const LIVE_TIMEOUT_MS = 240_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const RELAUNCH_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const KEYCHAIN_WAIT_MS = 20_000;
const POLL_MS = 250;
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_DELAY_MS = 25;
const CUT_FRACTION = 0.3;
const STAGING_PREFIX = ".table-craft-update-";
const BACKUP_SUFFIX = ".update-backup";

const captureWindow = evidenceFor("020");

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return condition();
}

/** Only the test build's own item; the user's real "TableCraft Safe Storage" is never touched. */
function forgetTestKeychainItem(): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" });
  } catch {
    // Not there: nothing to forget.
  }
}

function built(version: string, file: string): string {
  return join(LIVE_DIR, `v${version}`, file);
}

const newZip = (): Buffer => readFileSync(built(NEW, `TableCraft-${NEW}-${ARCH}.zip`));

interface Installed {
  readonly folder: string;
  readonly bundle: string;
  readonly executable: string;
}

function install(): Installed {
  const folder = mkdtempSync(join(LIVE_DIR, "install-"));
  const bundle = join(folder, BUNDLE);
  execFileSync("ditto", [built(OLD, join(`mac-${ARCH}`, BUNDLE)), bundle]);
  return { folder, bundle, executable: join(bundle, EXECUTABLE) };
}

function bundleVersion(bundle: string): string {
  const plist = join(bundle, "Contents", "Info.plist");
  return execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], {
    encoding: "utf8",
  }).trim();
}

/** Staging folders, backups and partial downloads the updater left behind. */
function leftovers(folder: string): string[] {
  const beside = readdirSync(folder).filter((name) => name.startsWith(STAGING_PREFIX) || name.endsWith(BACKUP_SUFFIX));
  const temp = readdirSync(tmpdir()).filter((name) => name.startsWith(STAGING_PREFIX));
  return [...beside, ...temp];
}

function pidsOf(executable: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", executable], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(Number);
  } catch {
    return [];
  }
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // already gone
    }
  }
}

/**
 * Stops the copy the swap script relaunched, which no harness holds. Electron's main ignores
 * SIGTERM on macOS, so a kill follows; the next launch only needs the single-instance lock free.
 */
async function stopRelaunched(executable: string): Promise<void> {
  signal(pidsOf(executable), "SIGTERM");
  try {
    await expect.poll(() => pidsOf(executable).length, { timeout: STOP_GRACE_MS }).toBe(0);
  } catch {
    signal(pidsOf(executable), "SIGKILL");
    await expect.poll(() => pidsOf(executable).length, { timeout: RELAUNCH_TIMEOUT_MS }).toBe(0);
  }
}

function started(userDataDir: string, version: string): number {
  return logLines(userDataDir).filter((line) => line.msg === "TableCraft started" && line["version"] === version)
    .length;
}

async function openPopover(page: RunningApp["page"]): Promise<void> {
  const popover = page.getByTestId("update-popover");
  if ((await popover.count()) === 0) await updateButton(page).click();
  await popover.waitFor();
}

/** Whether any line inside `box` is wider than the box, as two SHA-256 digests were before wrapping. */
async function overflows(box: Locator): Promise<boolean> {
  return box.evaluate(
    (element: { readonly scrollWidth: number; readonly clientWidth: number }) =>
      element.scrollWidth > element.clientWidth,
  );
}

const throttled: AssetResponder = (_attempt, asset, response) => {
  response.writeHead(200, { "content-length": String(asset.byteLength) });
  let offset = 0;
  const next = (): void => {
    if (response.destroyed) return;
    if (offset >= asset.byteLength) {
      response.end();
      return;
    }
    response.write(asset.subarray(offset, offset + CHUNK_BYTES));
    offset += CHUNK_BYTES;
    setTimeout(next, CHUNK_DELAY_MS);
  };
  next();
};

/** The first attempt stops part-way through, as a dropped connection does; later ones succeed. */
const cutOnce: AssetResponder = (attempt, asset, response: ServerResponse) => {
  if (attempt > 1) {
    response.writeHead(200, { "content-length": String(asset.byteLength) }).end(asset);
    return;
  }
  response.writeHead(200, { "content-length": String(asset.byteLength) });
  response.write(asset.subarray(0, Math.floor(asset.byteLength * CUT_FRACTION)), () => {
    response.socket?.destroy();
  });
};

describe.runIf(LIVE)("in-app update (packaged test builds, live)", () => {
  let running: RunningApp | null = null;
  let local: LocalServer | null = null;
  const folders: string[] = [];

  async function open(
    release: Release,
    executable: string,
    options: { userDataDir?: string; systemKeychain?: boolean } = {},
  ): Promise<RunningApp & { readonly local: LocalServer }> {
    local ??= await serve(release);
    const userDataDir = options.userDataDir ?? newProfile();
    running = await launchApp(SCRATCH, {
      userDataDir,
      executable,
      env: overrides(local, userDataDir),
      systemKeychain: options.systemKeychain ?? false,
    });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return { ...running, local };
  }

  function installed(): Installed {
    const target = install();
    folders.push(target.folder);
    return target;
  }

  async function downloadToReady(page: RunningApp["page"]): Promise<void> {
    await updateButton(page).waitFor({ timeout: RELAUNCH_TIMEOUT_MS });
    await openPopover(page);
    await page.getByTestId("update-popover").getByRole("button", { name: "Download" }).click();
    await expect
      .poll(() => updateButton(page).getAttribute("data-phase"), { timeout: DOWNLOAD_TIMEOUT_MS })
      .toBe("ready");
  }

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
    local?.server.close();
    local = null;
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenTheNewestRelease_whenCheckedFromHelp_thenUpToDateAndNoButton",
    async () => {
      const target = installed();
      const { page, userDataDir } = await open({ version: OLD, asset: newZip() }, target.executable);

      expect(await loggedUpdate(userDataDir, "up to date")).toMatchObject({ trigger: "automatic", target: OLD });
      expect(await updateButton(page).count()).toBe(0);
      await findAction(page, "Check for Updates");
      const notice = page.getByRole("dialog", { name: "You're up to date" });
      await notice.waitFor();
      expect(await notice.textContent()).toContain(OLD);
      await captureWindow(page, "01-packaged-up-to-date");
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "givenANewerRelease_whenDownloaded_thenProgressInTheButtonAndRestartReplacesAndRelaunches",
    async () => {
      const target = installed();
      const { page, userDataDir, app } = await open(
        { version: NEW, asset: newZip(), assetName: `TableCraft-${NEW}-${ARCH}.zip`, respond: throttled },
        target.executable,
      );

      await updateButton(page).waitFor({ timeout: RELAUNCH_TIMEOUT_MS });
      expect(await updateButton(page).getAttribute("data-phase")).toBe("available");
      expect(await rightGroupNames(page)).toEqual(["Search Everywhere", "Update", "Settings…"]);
      await captureWindow(page, "02-packaged-update-available");

      await openPopover(page);
      const popover = page.getByTestId("update-popover");
      expect(await popover.getByTestId("update-versions").textContent()).toContain(`${OLD} → ${NEW}`);
      await captureWindow(page, "03-popover-versions-and-notes");
      await popover.getByRole("button", { name: "Download" }).click();
      await expect.poll(() => updateButton(page).getAttribute("data-phase")).toBe("downloading");
      await expect.poll(async () => updateButton(page).textContent()).toMatch(/[1-9]\d?%/);
      await captureWindow(page, "03-download-progress");
      await expect
        .poll(() => updateButton(page).getAttribute("data-phase"), { timeout: DOWNLOAD_TIMEOUT_MS })
        .toBe("ready");
      expect(await loggedUpdate(userDataDir, "update staged")).toMatchObject({ target: NEW });
      await openPopover(page);
      await captureWindow(page, "04-ready-restart");

      const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
      await page.getByTestId("update-popover").getByRole("button", { name: "Restart to Update" }).click();
      await exited;
      running = null;

      await expect.poll(() => started(userDataDir, NEW), { timeout: RELAUNCH_TIMEOUT_MS }).toBe(1);
      expect(bundleVersion(target.bundle)).toBe(NEW);
      expect(leftovers(target.folder)).toEqual([]);
      expect(await loggedUpdate(userDataDir, "swap script", 2)).toMatchObject({
        line: expect.stringContaining("replaced; relaunching") as unknown,
      });
      await stopRelaunched(target.executable);

      const again = await open({ version: NEW, asset: newZip() }, target.executable, { userDataDir });
      await findAction(again.page, "About TableCraft");
      const about = again.page.getByRole("dialog").filter({ hasText: `${PRODUCT} ${NEW}` });
      await about.waitFor();
      expect(await updateButton(again.page).count()).toBe(0);
      await captureWindow(again.page, "04-restarted-on-new-version");
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "givenAManifestSignedWithAnotherKey_whenChecked_thenUpdateFailedAndNothingDownloaded",
    async () => {
      const target = installed();
      const {
        page,
        userDataDir,
        local: server,
      } = await open({ version: NEW, asset: newZip(), signedBy: OTHER_KEYS }, target.executable);

      expect(await loggedUpdate(userDataDir, "update manifest rejected")).toMatchObject({
        level: "error",
        reason: "signature",
      });
      await updateButton(page).waitFor();
      expect(await updateButton(page).getAttribute("data-phase")).toBe("error");
      await openPopover(page);
      expect(await page.getByTestId("update-message").textContent()).toContain("could not be verified");
      expect(server.requests).not.toContain(server.assetPath);
      await captureWindow(page, "05-packaged-tampered-signature");
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "givenACorruptedZip_whenDownloaded_thenTheHashMismatchIsNamedAndNothingIsKept",
    async () => {
      const target = installed();
      const zip = newZip();
      const corrupted = Buffer.from(zip);
      const middle = Math.floor(corrupted.byteLength / 2);
      corrupted.fill(0, middle, middle + CHUNK_BYTES);
      const corrupting: AssetResponder = (_attempt, _asset, response) => {
        response.writeHead(200, { "content-length": String(corrupted.byteLength) }).end(corrupted);
      };
      const { page, userDataDir } = await open({ version: NEW, asset: zip, respond: corrupting }, target.executable);

      await updateButton(page).waitFor({ timeout: RELAUNCH_TIMEOUT_MS });
      await openPopover(page);
      await page.getByTestId("update-popover").getByRole("button", { name: "Download" }).click();
      await expect
        .poll(() => updateButton(page).getAttribute("data-phase"), { timeout: DOWNLOAD_TIMEOUT_MS })
        .toBe("error");
      expect(await loggedUpdate(userDataDir, "downloaded update does not match the manifest")).toMatchObject({
        level: "error",
      });
      await openPopover(page);
      expect(await page.getByTestId("update-message").textContent()).toContain("SHA-256");
      expect(await overflows(page.getByTestId("update-popover"))).toBe(false);
      expect(leftovers(target.folder)).toEqual([]);
      expect(bundleVersion(target.bundle)).toBe(OLD);
      await captureWindow(page, "06-hash-mismatch");
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "givenTheAppRunsFromItsDiskImage_whenANewerReleaseIsFound_thenTheButtonExplainsWhy",
    async () => {
      const attached = execFileSync(
        "hdiutil",
        ["attach", "-nobrowse", "-noautoopen", built(OLD, `TableCraft-${OLD}-${ARCH}.dmg`)],
        {
          encoding: "utf8",
        },
      );
      const mount = attached.trim().split("\n").at(-1)?.split("\t").at(-1)?.trim() ?? "";
      try {
        const {
          page,
          userDataDir,
          local: server,
        } = await open({ version: NEW, asset: newZip() }, join(mount, BUNDLE, EXECUTABLE));
        expect(await loggedUpdate(userDataDir, "update found; this install cannot update itself")).toMatchObject({
          reason: "readOnlyVolume",
        });
        expect(await updateButton(page).getAttribute("data-phase")).toBe("ineligible");
        await openPopover(page);
        const popover = page.getByTestId("update-popover");
        expect(await popover.getByTestId("update-message").textContent()).toContain("Applications");
        expect(await popover.getByRole("button", { name: "Release Notes" }).count()).toBe(1);
        expect(server.requests).not.toContain(server.assetPath);
        await captureWindow(page, "07-dmg-volume-explains");
        await closeApp(running?.app);
        running = null;
      } finally {
        execFileSync("hdiutil", ["detach", mount, "-force"]);
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "givenTheConnectionDropsMidDownload_whenRetried_thenNothingWasKeptAndTheRetrySucceeds",
    async () => {
      const target = installed();
      const { page, userDataDir } = await open({ version: NEW, asset: newZip(), respond: cutOnce }, target.executable);

      await updateButton(page).waitFor({ timeout: RELAUNCH_TIMEOUT_MS });
      await openPopover(page);
      await page.getByTestId("update-popover").getByRole("button", { name: "Download" }).click();
      await expect
        .poll(() => updateButton(page).getAttribute("data-phase"), { timeout: DOWNLOAD_TIMEOUT_MS })
        .toBe("error");
      expect(await loggedUpdate(userDataDir, "download failed")).toMatchObject({ level: "warn" });
      expect(leftovers(target.folder)).toEqual([]);
      await openPopover(page);
      expect(await page.getByTestId("update-message").textContent()).toContain("interrupted");
      await captureWindow(page, "08-network-cut");

      await page.getByTestId("update-popover").getByRole("button", { name: "Retry" }).click();
      await expect
        .poll(() => updateButton(page).getAttribute("data-phase"), { timeout: DOWNLOAD_TIMEOUT_MS })
        .toBe("ready");
      await captureWindow(page, "08-retry-succeeds");
    },
    LIVE_TIMEOUT_MS,
  );

  it.runIf(process.env["TABLE_CRAFT_UPDATE_LIVE_KEYCHAIN"] === "1")(
    "givenAPasswordInTheKeychain_whenTheAppIsReplaced_thenWhatHappensToIt",
    async () => {
      forgetTestKeychainItem();
      onTestFinished(forgetTestKeychainItem);
      const target = installed();
      const userDataDir = newProfile();
      const first = await open({ version: NEW, asset: newZip() }, target.executable, {
        userDataDir,
        systemKeychain: true,
      });
      const saved = await first.page.evaluate(async () => {
        const bridge = (globalThis as unknown as { tableCraft: TableCraftLike }).tableCraft;
        const result = await bridge.saveDatasource({
          datasource: {
            name: "Keychain probe",
            pluginId: "mysql",
            folder: null,
            color: null,
            readOnly: false,
            comment: "",
            config: { host: "127.0.0.1", port: 56306, database: "table_craft", user: "table_craft" },
            secretModes: { password: "forever" },
          },
          secrets: { password: { action: "set", value: "table_craft" } },
        });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.value;
      });
      expect(saved.storedSecrets).toEqual(["password"]);
      const before = await first.page.evaluate(
        (id) => (globalThis as unknown as { tableCraft: TableCraftLike }).tableCraft.connectEngine(id),
        saved.id,
      );
      expect(before).toEqual({ ok: true, value: { status: "connected" } });
      execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE]);

      await downloadToReady(first.page);
      await openPopover(first.page);
      const exited = new Promise<void>((resolve) => first.app.process().once("exit", () => resolve()));
      await first.page.getByTestId("update-popover").getByRole("button", { name: "Restart to Update" }).click();
      await exited;
      running = null;
      await expect.poll(() => started(userDataDir, NEW), { timeout: RELAUNCH_TIMEOUT_MS }).toBe(1);
      // The swap log is drained only after the secret store has asked the keychain, so a
      // relaunch that never drains it is sitting on macOS's keychain prompt.
      const pastKeychain = await waitFor(
        () => updateLines(userDataDir).filter((line) => line.msg === "swap script").length >= 2,
        KEYCHAIN_WAIT_MS,
      );
      const screen = join(process.env["TABLE_CRAFT_EVIDENCE_DIR"] ?? tmpdir(), "09-keychain-after-swap-screen.png");
      execFileSync("screencapture", ["-x", screen]);
      console.log(`plan 020 keychain after swap: ${pastKeychain ? "no prompt" : "blocked on the keychain prompt"}`);
      await stopRelaunched(target.executable);
      expect(existsSync(screen)).toBe(true);
      if (!pastKeychain) return;

      const after = await open({ version: NEW, asset: newZip() }, target.executable, {
        userDataDir,
        systemKeychain: true,
      });
      const outcome = await after.page.evaluate(
        (id) => (globalThis as unknown as { tableCraft: TableCraftLike }).tableCraft.connectEngine(id),
        saved.id,
      );
      console.log(`plan 020 keychain connect after swap: ${JSON.stringify(outcome)}`);
      await captureWindow(after.page, "09-keychain-after-swap");
    },
    LIVE_TIMEOUT_MS,
  );
});

interface TableCraftLike {
  saveDatasource(
    request: object,
  ): Promise<{ ok: true; value: { id: string; storedSecrets: string[] } } | { ok: false; error: unknown }>;
  connectEngine(id: string): Promise<unknown>;
}
