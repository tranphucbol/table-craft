/**
 * Loads the built plugin bundles and connects each driver once. Gated with the other smoke tests,
 * because it needs a fresh build:
 *
 *   bun run test:smoke
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPlugins } from "@table-craft/core";
import { describe, expect, it } from "vitest";
import { SMOKE_ENABLED } from "./harness.js";

const BUILT_PLUGINS_ROOT = resolve(import.meta.dirname, "../../packages/desktop/dist/resources/plugins");
/** Decision 108: built for development runs and npm, never packaged. */
const OPTIONAL_PLUGINS_ROOT = resolve(import.meta.dirname, "../../packages/desktop/dist/optional-plugins");
const ROOT_OF: Readonly<Record<string, string>> = {
  postgres: OPTIONAL_PLUGINS_ROOT,
  redis: OPTIONAL_PLUGINS_ROOT,
  oracle: OPTIONAL_PLUGINS_ROOT,
  mssql: OPTIONAL_PLUGINS_ROOT,
  etcd: OPTIONAL_PLUGINS_ROOT,
};
const PLUGIN_ENTRY_FILE = "index.js";
/** Port 1 (tcpmux) is reserved and closed on any machine running these tests. */
const UNREACHABLE = { host: "127.0.0.1", port: 1, database: "none", user: "none" };
const UNREACHABLE_REDIS = { host: "127.0.0.1", port: 1 };
const IN_MEMORY = { path: ":memory:" };

/**
 * Imports the bundle in a plain Node ES module and tries one connect, printing the outcome as JSON.
 * Not in-process: Vitest's module runner hands bundles a `require`, which hid a bundle that only
 * failed where the engine runs it, in a real ES module without one.
 */
const PROBE_SCRIPT = `
const [entry, config, sql = "SELECT 1 AS one"] = process.argv.slice(2);
const plugin = (await import(entry)).default;
try {
  const session = await plugin.connect(plugin.connectionSchema.parse(JSON.parse(config)), { readOnly: false });
  const result = await session.execute(sql);
  const rows = [];
  for await (const row of result.rows) rows.push(row);
  await session.close();
  console.log(JSON.stringify({ rows }));
} catch (error) {
  console.log(JSON.stringify({ code: error.code ?? null, message: String(error.message) }));
}
`;

function probe(pluginId: string, config: unknown, sql?: string): unknown {
  const entry = pathToFileURL(join(ROOT_OF[pluginId] ?? BUILT_PLUGINS_ROOT, pluginId, PLUGIN_ENTRY_FILE)).href;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-", entry, JSON.stringify(config), ...(sql === undefined ? [] : [sql])],
    {
      input: PROBE_SCRIPT,
      encoding: "utf8",
    },
  );
  if (child.status !== 0) throw new Error(`The ${pluginId} bundle crashed:\n${child.stderr}`);
  return JSON.parse(child.stdout);
}

describe.runIf(SMOKE_ENABLED)("built plugin bundles", () => {
  it("givenBuiltPlugins_whenLoaded_thenEveryBuiltInIsAvailable", async () => {
    const results = await loadPlugins([BUILT_PLUGINS_ROOT]);

    expect(results.filter((result) => result.status === "unavailable")).toEqual([]);
    expect(results.map((result) => result.manifest?.id).sort()).toEqual(["mysql", "sqlite"]);
  });

  it("givenBuiltOptionalPlugins_whenLoaded_thenEveryOptionalPluginIsAvailableOutsideTheBuiltInRoot", async () => {
    const results = await loadPlugins([OPTIONAL_PLUGINS_ROOT]);

    expect(results.filter((result) => result.status === "unavailable")).toEqual([]);
    expect(results.map((result) => result.manifest?.id)).toEqual(
      expect.arrayContaining(["postgres", "redis", "oracle", "mssql", "etcd"]),
    );
  });

  it.each(["postgres", "mysql", "mssql"])(
    "givenBuilt %s bundle in a plain ES module_whenConnectingToClosedPort_thenRejectsWithConnectionFailed",
    (pluginId) => {
      expect(probe(pluginId, UNREACHABLE)).toMatchObject({ code: "connectionFailed" });
    },
  );

  it("givenBuiltRedisBundle in a plain ES module_whenConnectingToClosedPort_thenRejectsWithConnectionFailed", () => {
    expect(probe("redis", UNREACHABLE_REDIS)).toMatchObject({ code: "connectionFailed" });
  });

  it("givenBuiltSqliteBundle in a plain ES module_whenOpeningInMemory_thenSelectsALiteral", () => {
    expect(probe("sqlite", IN_MEMORY)).toEqual({ rows: [[1]] });
  });
});
