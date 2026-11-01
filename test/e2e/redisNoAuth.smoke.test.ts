/**
 * Plan 137's live test: a Redis data source set to No auth hides Username and Password, connects
 * and reconnects without a password prompt, while one saved before Authentication existed still
 * asks; an etcd one set to None connects without a prompt too. Needs a fresh build and the Redis
 * and etcd containers:
 *
 *   TABLE_CRAFT_DATABASES=mysql,tidb,redis,etcd TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/137 bun test/e2e/docker/headless.ts --databases test/e2e/redisNoAuth.smoke.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { ETCD35_CONFIG, REDIS_CONFIG, WITHOUT_ETCD, WITHOUT_REDIS } from "../support/databases.js";
import {
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  fillNewDatasource,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  secretPrompt,
  seedDatasources,
  seedSettings,
  setWindowSize,
  testConnection,
  toolWindow,
  treeNode,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("137");
const NO_AUTH = "redis-no-auth";
const LEGACY = "redis-legacy";
const ETCD_NONE = "etcd-none";
/** The prompt is captured as soon as it opens; without motion it is already fully drawn. */
const NO_MOTION = { version: 1, appearance: { motion: "off" } } as const;
const { user: _user, password: _password, ...REDIS_ADDRESS } = REDIS_CONFIG;

describe.runIf(DATABASES_ENABLED)("redis without authentication", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(userDataDir: string): Promise<RunningApp> {
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running;
  }

  async function connectFromTree(app: RunningApp, name: string): Promise<void> {
    await treeNode(app.page, name).click({ button: "right" });
    await app.page.getByRole("menuitem", { name: /^Connect/ }).click();
  }

  async function connected(app: RunningApp, name: string): Promise<void> {
    await expect
      .poll(() => treeNode(app.page, name).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
      .toBe("connected");
  }

  it.skipIf(WITHOUT_REDIS)(
    "givenNoAuth_whenSavedConnectedAndReconnected_thenNeverAsksForPassword",
    async () => {
      const profile = newProfile();
      seedSettings(profile, NO_MOTION);
      const app = await launch(profile);
      await fillNewDatasource(app.page, {
        kind: "Redis",
        name: NO_AUTH,
        fields: { Host: REDIS_CONFIG.host, Port: String(REDIS_CONFIG.port) },
      });
      const dialog = dataSourcesDialog(app.page);
      await chooseOption(dialog.getByLabel("Authentication", { exact: true }), "none");
      expect(await dialog.getByLabel("Username", { exact: true }).count()).toBe(0);
      expect(await dialog.getByLabel("Password", { exact: true }).count()).toBe(0);
      const result = await testConnection(app.page);
      expect(result.ok).toBe(true);
      await captureWindow(app.page, "01-no-auth-form-tested");
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await connectFromTree(app, NO_AUTH);
      await connected(app, NO_AUTH);
      expect(await secretPrompt(app.page, NO_AUTH).count()).toBe(0);
      await captureWindow(app.page, "02-no-auth-connected-no-prompt");

      await treeNode(app.page, NO_AUTH).click();
      await pressChord(app.page, "F2");
      await expect.poll(() => treeNode(app.page, NO_AUTH).getAttribute("data-state")).toBe("disconnected");
      await connectFromTree(app, NO_AUTH);
      await connected(app, NO_AUTH);
      expect(await secretPrompt(app.page, NO_AUTH).count()).toBe(0);
      await captureWindow(app.page, "03-no-auth-reconnected-no-prompt");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_ETCD)(
    "givenEtcdAuthenticationNone_whenConnecting_thenNoPasswordPrompt",
    async () => {
      const profile = newProfile();
      seedSettings(profile, NO_MOTION);
      seedDatasources(profile, [
        {
          id: ETCD_NONE,
          name: ETCD_NONE,
          pluginId: "etcd",
          config: { host: ETCD35_CONFIG.host, port: ETCD35_CONFIG.port, authMode: "none" },
          secretModes: {},
        },
      ]);
      const app = await launch(profile);
      await connectFromTree(app, ETCD_NONE);
      await connected(app, ETCD_NONE);
      expect(await secretPrompt(app.page, ETCD_NONE).count()).toBe(0);
      await captureWindow(app.page, "05-etcd-none-connected-no-prompt");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenRedisSavedBeforeAuthentication_whenConnecting_thenPasswordStillAsked",
    async () => {
      const profile = newProfile();
      seedSettings(profile, NO_MOTION);
      seedDatasources(profile, [
        {
          id: LEGACY,
          name: LEGACY,
          pluginId: "redis",
          config: { ...REDIS_ADDRESS, user: REDIS_CONFIG.user },
          secretModes: { password: "never" },
        },
      ]);
      const app = await launch(profile);
      await connectFromTree(app, LEGACY);
      const prompt = secretPrompt(app.page, LEGACY);
      await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await prompt.getByLabel("Password", { exact: true }).count()).toBe(1);
      await captureWindow(app.page, "04-legacy-record-still-prompts");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
