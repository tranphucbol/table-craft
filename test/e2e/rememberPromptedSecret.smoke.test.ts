/**
 * A password typed at the connect prompt is kept in the datasource's save mode once the connection
 * works: Forever survives a relaunch, Until restart a reconnect. Needs a display, a fresh build and
 * the MySQL container:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/remember-prompted-secrets bun run test:smoke:db:headless test/e2e/rememberPromptedSecret.smoke.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  secretPrompt,
  seedDatasources,
  seedSettings,
  setWindowSize,
  toolWindow,
  treeNode,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("remember-prompted-secrets");
const NAME = "mysql-prompted";
const { password: PASSWORD, ...MYSQL_PLAIN } = MYSQL_CONFIG;
const SECRETS_FILE = "secrets.json";
/** The prompt is captured as soon as it opens; without motion it is already fully drawn. */
const NO_MOTION = { version: 1, appearance: { motion: "off" } } as const;

function prompted(mode: "forever" | "untilRestart"): SavedDatasource {
  return {
    id: NAME,
    name: NAME,
    pluginId: "mysql",
    config: { ...MYSQL_PLAIN, sslMode: "disable" },
    secretModes: { password: mode },
  };
}

describe.runIf(DATABASES_ENABLED)("remember a password typed at the connect prompt", () => {
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

  async function answerPrompt(app: RunningApp, sentence: string, evidence: string): Promise<void> {
    const prompt = secretPrompt(app.page, NAME);
    await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    expect(await prompt.textContent()).toContain(sentence);
    await prompt.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await captureWindow(app.page, evidence);
    await prompt.getByRole("button", { name: "Connect", exact: true }).click();
    await prompt.waitFor({ state: "detached" });
    await waitUntilReady(app.page);
  }

  it(
    "givenForeverModeWithoutPassword_whenPromptAnsweredAndRelaunched_thenConnectsWithoutPrompt",
    async () => {
      const profile = newProfile();
      seedDatasources(profile, [prompted("forever")]);
      seedSettings(profile, NO_MOTION);
      const first = await launch(profile);
      await openConsoleOn(first.page, NAME);
      await answerPrompt(first, "TableCraft saves the password in the system keychain.", "01-prompt-forever");
      await runStatement(first.page, "SELECT 1 AS one");
      expect((await gridText(first.page)).cells).toEqual(["1"]);
      await expect.poll(() => readProfileFile(profile, SECRETS_FILE)).not.toBeNull();
      expect(readProfileFile(profile, SECRETS_FILE)).not.toContain(PASSWORD);
      await closeApp(first.app);
      running = null;

      const again = await launch(profile);
      await openConsoleOn(again.page, NAME);
      await waitUntilReady(again.page);
      await runStatement(again.page, "SELECT 2 AS two");

      expect((await gridText(again.page)).cells).toEqual(["2"]);
      expect(await secretPrompt(again.page, NAME).count()).toBe(0);
      await captureWindow(again.page, "02-forever-relaunched-no-prompt");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUntilRestartModeWithoutPassword_whenPromptAnsweredAndReconnected_thenNoSecondPrompt",
    async () => {
      const profile = newProfile();
      seedDatasources(profile, [prompted("untilRestart")]);
      seedSettings(profile, NO_MOTION);
      const fresh = await launch(profile);
      await openConsoleOn(fresh.page, NAME);
      await answerPrompt(fresh, "TableCraft keeps the password until it quits.", "03-prompt-until-restart");

      await pressChord(fresh.page, "F2");
      await expect.poll(() => treeNode(fresh.page, NAME).getAttribute("data-state")).toBe("disconnected");
      await treeNode(fresh.page, NAME).click({ button: "right" });
      await fresh.page.getByRole("menuitem", { name: /^Connect/ }).click();

      await expect
        .poll(() => treeNode(fresh.page, NAME).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("connected");
      expect(await secretPrompt(fresh.page, NAME).count()).toBe(0);
      await captureWindow(fresh.page, "04-until-restart-reconnected-no-prompt");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
