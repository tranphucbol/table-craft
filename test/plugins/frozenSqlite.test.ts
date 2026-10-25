import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins, loadPlugins, openSession, ResultStore } from "@table-craft/core";
import { API_VERSION, MANIFEST_FILE, parseVersion, type ConnectOptions } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { afterEach, describe, expect, it } from "vitest";
import { sqliteContractFixture } from "../support/sqliteContract.js";

/** The SQLite plugin as built at plugin API 1.0.0 (decision 107); rebuilt only by `scripts/frozen-plugin.ts`. */
const FROZEN_VERSION = "1.0.0";
const FROZEN_ROOT = join(import.meta.dirname, "..", "support", "frozen-plugins");
const FROZEN_ID = "sqlite";
const IN_MEMORY = { path: ":memory:" };
const WRITABLE: ConnectOptions = { readOnly: false };

const LOADED = await loadPlugins([FROZEN_ROOT]);
const [FROZEN] = LOADED;
if (FROZEN?.status !== "loaded") {
  throw new Error(
    `The frozen SQLite plugin did not load: ${FROZEN?.status === "unavailable" ? FROZEN.reason : "missing"}`,
  );
}

runPluginContract(FROZEN.plugin, sqliteContractFixture(FROZEN.manifest));

describe("frozen SQLite plugin", () => {
  const scratch: string[] = [];

  afterEach(() => {
    for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("givenFrozenSqlite_whenDiscovered_thenLoadsThroughLoader", () => {
    expect(LOADED).toHaveLength(1);
    expect(FROZEN.manifest).toMatchObject({ id: FROZEN_ID, apiVersion: FROZEN_VERSION });
    expect(FROZEN.directory).toBe(join(FROZEN_ROOT, `${FROZEN_ID}-${FROZEN_VERSION}`));
  });

  it("givenFrozenSqlite_whenOpenedThroughCore_thenResultIsStored", async () => {
    const session = await openSession(LOADED, FROZEN_ID, IN_MEMORY, WRITABLE);
    const store = new ResultStore();
    try {
      const summary = await store.put(await session.execute("SELECT 1 AS one, 'two' AS two"));

      expect(store.window(summary.handle, 0).rows).toEqual([[1, "two"]]);
    } finally {
      await session.close();
    }
  });

  it("givenManifestDeclaringNextMinor_whenDiscovered_thenRefused", async () => {
    const root = mkdtempSync(join(tmpdir(), "table-craft-frozen-"));
    scratch.push(root);
    const copy = join(root, FROZEN_ID);
    cpSync(FROZEN.directory, copy, { recursive: true });
    const host = parseVersion(API_VERSION);
    const nextMinor = `${host?.major ?? 1}.${(host?.minor ?? 0) + 1}.0`;
    const manifest = JSON.parse(readFileSync(join(copy, MANIFEST_FILE), "utf8")) as Record<string, unknown>;
    writeFileSync(join(copy, MANIFEST_FILE), JSON.stringify({ ...manifest, apiVersion: nextMinor }));

    const [found] = await discoverPlugins([root]);

    expect(found).toMatchObject({ status: "unavailable" });
    expect(found?.status === "unavailable" && found.reason).toContain(`needs TableCraft with plugin API`);
  });
});
