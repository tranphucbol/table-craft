/**
 * Plan 151's live test, row 8: a plugin whose session leaves out a service its manifest declares is
 * refused when it connects (decision 155). The profile holds the development Redis build behind a
 * wrapper entry that drops the `nodes` service from every session it opens.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/151 bun run test:smoke:db:headless:redis test/e2e/brokenPlugin.smoke.test.ts
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REDIS_CONFIG, WITHOUT_REDIS } from "../support/databases.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  treeNode,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { seedManagedPlugin, UNREACHABLE_REGISTRY } from "./pluginFixtures.js";

const captureWindow = evidenceFor("151");
const REDIS = "redis";
const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
const ENTRY_FILE = "index.js";
const ORIGINAL_ENTRY = "original.js";
/** Hands out sessions without `nodes`, binding methods to the real session for its private fields. */
const WITHOUT_NODES_ENTRY = `import plugin from "./${ORIGINAL_ENTRY}";
export default {
  ...plugin,
  async connect(config, options) {
    const session = await plugin.connect(config, options);
    const { nodes: _nodes, ...services } = session.services;
    return new Proxy(session, {
      get(target, key) {
        if (key === "services") return services;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
};
`;
const REFUSAL = 'Plugin "redis" is unavailable: it declares nodes but its session has no nodes service.';
const { password: PASSWORD, ...REDIS_PLAIN } = REDIS_CONFIG;

const SAVED_REDIS: SavedDatasource = {
  id: "cache",
  name: "cache",
  pluginId: REDIS,
  config: REDIS_PLAIN,
  secretModes: { password: "never" },
};

describe.runIf(SMOKE_ENABLED)("a plugin breaking its own capabilities", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it.skipIf(WITHOUT_REDIS)(
    "givenRedisSessionWithoutDeclaredNodes_whenConnected_thenRefusedNamingTheService",
    async () => {
      const userDataDir = newProfile();
      seedManagedPlugin(userDataDir, REDIS);
      const directory = join(userDataDir, "managed-plugins", REDIS, "0.0.0");
      renameSync(join(directory, ENTRY_FILE), join(directory, ORIGINAL_ENTRY));
      writeFileSync(join(directory, ENTRY_FILE), WITHOUT_NODES_ENTRY);
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: UNREACHABLE_REGISTRY } });
      seedDatasources(userDataDir, [SAVED_REDIS]);
      running = await launchApp(null, { userDataDir, env: NO_OPTIONAL_ROOT });
      const { page } = running;
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await treeNode(page, SAVED_REDIS.name).click();
      await page.keyboard.press("ArrowRight");
      await answerSecretPrompt(page, SAVED_REDIS.name, PASSWORD);
      const node = treeNode(page, SAVED_REDIS.name);
      await expect.poll(() => node.getAttribute("title"), { timeout: LAUNCH_TIMEOUT_MS }).toContain(REFUSAL);
      expect(await node.getAttribute("aria-label")).toBe(`${SAVED_REDIS.name}, failed`);
      await captureWindow(page, "08-broken-plugin");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
