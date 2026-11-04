import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CSV_FORMAT, type PluginLoadResult } from "@table-craft/core";
import type { CancelReach, Capability, ConnectOptions, DatasourcePlugin, Session } from "@table-craft/plugin-api";
import sqlitePlugin from "@table-craft/plugin-sqlite";
import {
  execute,
  exportHarness,
  openSession,
  startExport,
  startImport,
  type ExportHarness,
} from "../support/engineExports.js";
import { languageFor } from "../support/declaredServices.js";
import { fakeManifest } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const sqlite: DatasourcePlugin = sqlitePlugin;
const PLUGIN_ID = "watched";
const CANCEL_REACH: CancelReach = { method: "test cancel", reaches: "statement" };
const KEEPALIVE_SECONDS = 1;
const KEEPALIVE_MS = KEEPALIVE_SECONDS * 1_000;
/** Longer than two keepalive intervals, so an idle ping, a probe or a reconnect would have run. */
const HELD_MS = 2.5 * KEEPALIVE_MS;
const CAPABILITIES: readonly Capability[] = ["sql", "cancel", "schemaTree", "transactions", "keepAlive", "bulkInsert"];

interface Opened {
  readonly options: ConnectOptions;
  pings: number;
  inserts: number;
  executes: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQLite with `keepAlive`: every ping fails, as on a dead link, and each export read and import
 * batch is held for `HELD_MS`. A transfer the console watch touched would reconnect or fail.
 */
function watchedPlugin() {
  const opened: Opened[] = [];
  const plugin: DatasourcePlugin = {
    ...sqlite,
    id: PLUGIN_ID,
    capabilities: CAPABILITIES,
    language: languageFor(sqlitePlugin.language, CAPABILITIES),
    connect: async (config, options) => {
      const session = await sqlite.connect(config, options);
      const record: Opened = { options, pings: 0, inserts: 0, executes: 0 };
      opened.push(record);
      const { bulkInsert } = session.services;
      const wrapped: Session = {
        execute: async (sql, params, executeOptions) => {
          record.executes += 1;
          if (options.readOnly) await delay(HELD_MS);
          return session.execute(sql, params, executeOptions);
        },
        services: {
          cancel: { cancel: () => Promise.resolve(), reach: CANCEL_REACH },
          keepAlive: {
            ping: () => {
              record.pings += 1;
              return Promise.reject(new Error("The link is gone."));
            },
          },
          bulkInsert: {
            insertRows: async (target, rows) => {
              record.inserts += 1;
              await delay(HELD_MS);
              await bulkInsert?.insertRows(target, rows);
            },
          },
          schemaTree: session.services.schemaTree,
          transactions: session.services.transactions,
        },
        close: () => session.close(),
        serverVersion: session.serverVersion,
      };
      return wrapped;
    },
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/watched",
    manifest: fakeManifest({ id: PLUGIN_ID, name: "Watched", capabilities: [...CAPABILITIES] }),
    plugin,
  };
  return { loaded, opened };
}

describe("transfers outside the console watch", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function directory(): Promise<string> {
    const made = await mkdtemp(join(tmpdir(), "table-craft-transfer-"));
    cleanup.push(() => rm(made, { recursive: true, force: true }));
    return made;
  }

  function harness(loaded: PluginLoadResult): ExportHarness {
    const opened = exportHarness(
      { id: "w", pluginId: PLUGIN_ID, config: { path: seededSqliteFile() }, readOnly: false, keepAliveSeconds: 1 },
      [loaded],
    );
    cleanup.push(() => opened.close());
    return opened;
  }

  it("givenImportBatchLongerThanKeepAliveAndTimeout_whenRun_thenNeverPingedReconnectedOrCut", async () => {
    const { loaded, opened } = watchedPlugin();
    const engine = harness(loaded);
    const source = join(await directory(), "people.csv");
    await writeFile(source, "id,name,email\n10,Ten,ten@example.com\n11,Eleven,eleven@example.com\n");
    const console = await openSession(engine.connection);
    await execute(engine.connection, console, "SELECT 1");
    await engine.connection.handle({ id: 5, type: "catalog.namespaces" });
    const before = opened.length;

    const task = await startImport(engine.connection, {
      file: source,
      format: CSV_FORMAT,
      target: {
        kind: "table",
        path: ["main"],
        relation: "customers",
        mapping: [
          { column: "id", field: 0 },
          { column: "name", field: 1 },
          { column: "email", field: 2 },
        ],
      },
      transaction: { mode: "all" },
      errors: { mode: "stop" },
    });
    const done = await engine.imported(task.taskId);

    const writers = opened.filter((record) => record.inserts > 0);
    expect(opened).toHaveLength(before + 1);
    expect(done).toMatchObject({ state: "done", written: 2, committed: 2, error: null });
    expect(writers).toHaveLength(1);
    expect(writers[0]?.pings).toBe(0);
    expect(writers[0]?.options.keepAliveInitialDelayMs).toBe(KEEPALIVE_MS);
    const rows = await execute(engine.connection, console, "SELECT COUNT(*) FROM customers WHERE id IN (10, 11)", 1);
    expect(rows.firstWindow.rows).toEqual([[2]]);
    expect(opened.reduce((pings, record) => pings + record.pings, 0)).toBeGreaterThan(0);
  });

  it("givenExportReadLongerThanKeepAliveAndTimeout_whenRun_thenNeverPingedReconnectedOrCut", async () => {
    const { loaded, opened } = watchedPlugin();
    const engine = harness(loaded);
    const path = join(await directory(), "customers.csv");

    const task = await startExport(engine.connection, {
      source: { kind: "table", path: ["main"], relation: "customers", columns: ["id"] },
      format: "csv",
      path,
    });
    const done = await engine.finished(task.taskId);

    const readers = opened.filter((record) => record.options.readOnly);
    expect(done).toMatchObject({ state: "done", error: null });
    expect(readers).toHaveLength(1);
    expect(readers[0]?.pings).toBe(0);
    expect((await readFile(path, "utf8")).startsWith("id\n")).toBe(true);
  });
});
