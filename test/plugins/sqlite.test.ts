import { openSession, ResultStore, type PluginLoadResult } from "@table-craft/core";
import { isPluginError, type ConnectOptions, type Row } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import sqlite from "@table-craft/plugin-sqlite";
import { describe, expect, it } from "vitest";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { sqliteContractFixture } from "../support/sqliteContract.js";

const IN_MEMORY = { path: ":memory:" };
const BEYOND_SAFE_INTEGER = "9007199254740993";
const UNREACHABLE = { path: "/nonexistent-table-craft-directory/fixture.sqlite" };

const WRITABLE: ConnectOptions = { readOnly: false };

const LOADED: PluginLoadResult[] = [
  {
    status: "loaded",
    directory: "builtin/sqlite",
    manifest: SQLITE_MANIFEST,
    plugin: sqlite,
  },
];

async function collect(rows: AsyncIterable<Row>): Promise<Row[]> {
  const collected: Row[] = [];
  for await (const row of rows) collected.push(row);
  return collected;
}

runPluginContract(sqlite, sqliteContractFixture(SQLITE_MANIFEST));

describe("sqlite plugin", () => {
  it("givenSqliteSession_whenSelectOne_thenReturnsColumnsAndOneRow", async () => {
    const session = await sqlite.connect(IN_MEMORY, WRITABLE);
    try {
      const result = await session.execute("SELECT 1 AS one, 'two' AS two");

      expect(result.columns).toEqual([
        { name: "one", type: null, origin: null },
        { name: "two", type: null, origin: null },
      ]);
      expect(await collect(result.rows)).toEqual([[1, "two"]]);
    } finally {
      await session.close();
    }
  });

  it("givenIntegerBeyondSafeRange_whenSelected_thenTaggedAsBigInt", async () => {
    const session = await sqlite.connect(IN_MEMORY, WRITABLE);
    try {
      const result = await session.execute(`SELECT ${BEYOND_SAFE_INTEGER} AS big, x'00ff' AS blob`);

      expect(await collect(result.rows)).toEqual([
        [
          { kind: "bigint", value: BEYOND_SAFE_INTEGER },
          { kind: "bytes", preview: "00ff", length: 2 },
        ],
      ]);
    } finally {
      await session.close();
    }
  });

  it("givenViewOverDroppedTable_whenSchemaDescribed_thenViewListedWithoutColumns", async () => {
    const session = await sqlite.connect(IN_MEMORY, WRITABLE);
    try {
      await session.execute("CREATE TABLE gone (id INTEGER)");
      await session.execute("CREATE TABLE kept (id INTEGER)");
      await session.execute("CREATE VIEW broken AS SELECT id FROM gone");
      await session.execute("DROP TABLE gone");

      const introspector = session.introspector;
      if (introspector === undefined) throw new Error("The SQLite plugin introspects.");
      const catalog = await introspector.describe(["main"]);

      expect(catalog.relations.map((relation) => [relation.name, relation.columns.length])).toEqual([
        ["broken", 0],
        ["kept", 1],
      ]);
    } finally {
      await session.close();
    }
  });

  it("givenPathInMissingDirectory_whenConnecting_thenRejectsWithConnectionFailed", async () => {
    const failure: unknown = await sqlite.connect(UNREACHABLE, WRITABLE).catch((error: unknown) => error);

    expect(isPluginError(failure) && failure.code).toBe("connectionFailed");
  });

  it("givenLoadedSqlite_whenOpenedThroughCore_thenResultIsStored", async () => {
    const session = await openSession(LOADED, "sqlite", IN_MEMORY, WRITABLE);
    const store = new ResultStore();
    try {
      const summary = await store.put(await session.execute("SELECT 1 AS one, 'two' AS two"));

      expect(store.window(summary.handle, 0).rows).toEqual([[1, "two"]]);
    } finally {
      await session.close();
    }
  });

  it("givenInvalidConfig_whenOpenedThroughCore_thenInvalidConfigError", async () => {
    await expect(openSession(LOADED, "sqlite", { file: ":memory:" }, WRITABLE)).rejects.toMatchObject({
      code: "invalidConfig",
    });
  });

  it("givenNoSuchPlugin_whenOpenedThroughCore_thenUnknownPluginError", async () => {
    await expect(openSession(LOADED, "oracle", IN_MEMORY, WRITABLE)).rejects.toMatchObject({ code: "unknownPlugin" });
  });
});
