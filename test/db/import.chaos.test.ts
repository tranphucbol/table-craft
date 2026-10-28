import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CSV_FORMAT, type PluginLoadResult } from "@table-craft/core";
import mssql from "@table-craft/plugin-mssql";
import mysql from "@table-craft/plugin-mysql";
import oracle from "@table-craft/plugin-oracle";
import postgres from "@table-craft/plugin-postgres";
import type { ImportTask } from "@table-craft/desktop/engine/protocol.js";
import { chaosProxy, type ChaosProxy } from "../support/chaosProxy.js";
import {
  MSSQL_CONFIG,
  MYSQL_CONFIG,
  ORACLE_CONFIG,
  POSTGRES_CONFIG,
  databaseEnabled,
  type DatabaseId,
} from "../support/databases.js";
import {
  execute,
  exportHarness,
  openSession,
  resultOf,
  startImport,
  type ExportHarness,
} from "../support/engineExports.js";
import { MSSQL_MANIFEST, MYSQL_MANIFEST, ORACLE_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";

/**
 * Plan 021: imports over a link that goes quiet, resets or vanishes, and what each leaves committed
 * (decision 046): all-or-nothing keeps nothing; commit-every-N keeps exactly what it reports.
 */

const ROWS = 60_000;
const COMMIT_EVERY = 5_000;
/** The watchdog's floor (`EXPORT_STALL_SECONDS_RANGE.min`). */
const STALL_SECONDS = 10;
const SLOW_BYTES_PER_SECOND = 1_000_000;
const FIRST_COMMITS = 2 * COMMIT_EVERY;
const RELEASE_TIMEOUT_MS = 10_000;
const RELEASE_POLL_MS = 100;
const CHAOS_TEST_TIMEOUT_MS = 120_000;
const TABLE = "table_craft_import_chaos";
const PAYLOAD_HEX_CHARS = 64;

interface Target {
  readonly name: DatabaseId;
  readonly plugin: PluginLoadResult;
  readonly config: { readonly host: string; readonly port: number };
  readonly path: readonly string[];
  readonly create: string;
  /** How the server folds an unquoted name: Oracle's upper case. */
  readonly fold?: (name: string) => string;
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    plugin: { status: "loaded", directory: "plugins/postgres", manifest: POSTGRES_MANIFEST, plugin: postgres },
    config: POSTGRES_CONFIG,
    path: ["table_craft", "public"],
    create: `CREATE TABLE ${TABLE} (id BIGINT PRIMARY KEY, label TEXT NOT NULL, payload BYTEA NOT NULL)`,
  },
  {
    name: "mysql",
    plugin: { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql },
    config: MYSQL_CONFIG,
    path: ["table_craft"],
    create: `CREATE TABLE ${TABLE} (id BIGINT PRIMARY KEY, label VARCHAR(64) NOT NULL, payload VARBINARY(64) NOT NULL)`,
  },
  {
    name: "oracle",
    plugin: { status: "loaded", directory: "plugins/oracle", manifest: ORACLE_MANIFEST, plugin: oracle },
    config: ORACLE_CONFIG,
    path: ["TABLE_CRAFT"],
    create: `CREATE TABLE ${TABLE} (id NUMBER(19) PRIMARY KEY, label VARCHAR2(64 CHAR) NOT NULL, payload RAW(64) NOT NULL)`,
    fold: (name) => name.toUpperCase(),
  },
  {
    name: "mssql",
    plugin: { status: "loaded", directory: "plugins/mssql", manifest: MSSQL_MANIFEST, plugin: mssql },
    config: MSSQL_CONFIG,
    path: ["table_craft", "dbo"],
    create: `CREATE TABLE ${TABLE} (id BIGINT PRIMARY KEY, label NVARCHAR(64) NOT NULL, payload VARBINARY(64) NOT NULL)`,
  },
];

async function released(proxy: ChaosProxy, links: number): Promise<number> {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS;
  while (proxy.openLinks > links && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS));
  }
  return proxy.openLinks;
}

/** `id,label,payload` for `ROWS` rows, the payload as the exporter writes bytes. */
async function writeCsv(path: string): Promise<void> {
  const out = createWriteStream(path);
  out.write("id,label,payload\n");
  for (let id = 1; id <= ROWS; id += 1) {
    const hex = id.toString(16).padStart(PAYLOAD_HEX_CHARS, "0");
    out.write(`${String(id)},"row ${String(id)}, quoted",0x${hex}\n`);
  }
  out.end();
  await streamFinished(out);
}

for (const target of TARGETS) {
  describe.skipIf(!databaseEnabled(target.name))(
    `import chaos: ${target.name}`,
    { timeout: CHAOS_TEST_TIMEOUT_MS },
    () => {
      const fold = target.fold ?? ((name: string) => name);
      const cleanup: (() => Promise<void>)[] = [];
      afterEach(async () => {
        for (const step of cleanup.splice(0).reverse()) await step();
      });

      interface Rig {
        readonly proxy: ChaosProxy;
        readonly engine: ExportHarness;
        /** Counts on a direct connection, past the proxy, so what the server kept is read as it is. */
        readonly count: () => Promise<{ rows: number; distinct: number }>;
        readonly start: (transaction: object, stallSeconds?: number) => Promise<ImportTask>;
      }

      async function rig(): Promise<Rig> {
        const folder = await mkdtemp(join(tmpdir(), "table-craft-import-chaos-"));
        cleanup.push(() => rm(folder, { recursive: true, force: true }));
        const file = join(folder, "rows.csv");
        await writeCsv(file);
        const direct = exportHarness(
          {
            id: `${target.name}-direct`,
            pluginId: target.name,
            config: target.config,
            readOnly: false,
            keepAliveSeconds: 0,
          },
          [target.plugin],
        );
        cleanup.push(() => direct.close());
        const sessionId = await openSession(direct.connection);
        const run = async (sql: string) => (await execute(direct.connection, sessionId, sql)).firstWindow.rows;
        await run(`DROP TABLE IF EXISTS ${TABLE}`);
        await run(target.create);
        cleanup.push(async () => void (await run(`DROP TABLE IF EXISTS ${TABLE}`)));
        const proxy = await chaosProxy(target.config);
        cleanup.push(() => proxy.close());
        const engine = exportHarness(
          {
            id: target.name,
            pluginId: target.name,
            config: { ...target.config, host: proxy.host, port: proxy.port },
            readOnly: false,
            keepAliveSeconds: 10,
          },
          [target.plugin],
        );
        cleanup.push(() => engine.close());
        // The introspection link stays open for the engine's life; open it first so link counts see only the import's.
        resultOf(await engine.connection.handle({ id: 2, type: "catalog.namespaces" }));
        return {
          proxy,
          engine,
          count: async () => {
            const [row] = await run(`SELECT COUNT(*), COUNT(DISTINCT id) FROM ${TABLE}`);
            const [rows, distinct] = (row as unknown[]).map((value) => Number(value));
            return { rows: rows ?? -1, distinct: distinct ?? -1 };
          },
          start: (transaction, stallSeconds) =>
            startImport(
              engine.connection,
              {
                file,
                format: CSV_FORMAT,
                target: {
                  kind: "table",
                  path: target.path,
                  relation: fold(TABLE),
                  mapping: [
                    { column: fold("id"), field: 0 },
                    { column: fold("label"), field: 1 },
                    { column: fold("payload"), field: 2 },
                  ],
                },
                transaction,
                errors: { mode: "stop" },
              },
              stallSeconds,
            ),
        };
      }

      it("givenAllOrNothing_whenLinkDies_thenNothingCommitted", async () => {
        const { proxy, engine, count, start } = await rig();
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start({ mode: "all" });
        const moving = await engine.importing(task.taskId, 1);

        proxy.reset();
        const done = await engine.imported(task.taskId);

        expect(moving.state).toBe("running");
        expect(done).toMatchObject({ state: "failed", committed: 0, ambiguous: false, error: { reason: "target" } });
        expect(done.written).toBeGreaterThan(0);
        expect(done.error?.message).toContain("Nothing was imported: the transaction was rolled back.");
        expect(await count()).toEqual({ rows: 0, distinct: 0 });
      });

      it("givenCommitEvery_whenLinkDies_thenCommittedReportedAndResumeFinishes", async () => {
        const { proxy, engine, count, start } = await rig();
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start({ mode: "every", rows: COMMIT_EVERY });
        // Committed, not written: resetting while the COMMIT is in flight makes the outcome honestly ambiguous.
        await engine.committing(task.taskId, FIRST_COMMITS);

        proxy.reset();
        const failed = await engine.imported(task.taskId);
        const kept = await count();
        proxy.bytesPerSecond = 0;
        const resumed = resultOf<ImportTask>(
          await engine.connection.handle({ id: 9, type: "import.resume", taskId: task.taskId, stallSeconds: 120 }),
        );
        const done = await engine.imported(resumed.taskId);

        expect(failed).toMatchObject({ state: "failed", ambiguous: false });
        expect(failed.committed % COMMIT_EVERY).toBe(0);
        expect(failed.committed).toBeGreaterThanOrEqual(COMMIT_EVERY);
        expect(failed.resumeFrom).toBe(failed.committed + 1);
        expect(failed.error?.message).toContain(
          `${failed.committed.toLocaleString("en-US")} rows are committed; resume from row ${failed.resumeFrom.toLocaleString("en-US")}.`,
        );
        expect(kept).toEqual({ rows: failed.committed, distinct: failed.committed });
        expect(resumed.resumeFrom).toBe(failed.resumeFrom);
        expect(done).toMatchObject({ state: "done", committed: ROWS - failed.committed });
        expect(await count()).toEqual({ rows: ROWS, distinct: ROWS });
      });

      it("givenStall_whenImporting_thenStalledWithinTimeoutAndLinkReleased", async () => {
        const { proxy, engine, count, start } = await rig();
        const links = proxy.openLinks;
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start({ mode: "all" }, STALL_SECONDS);
        await engine.importing(task.taskId, 1);

        const stalledAt = Date.now();
        proxy.stall();
        const done = await engine.imported(task.taskId);
        const waited = Date.now() - stalledAt;
        proxy.resume();

        expect(done).toMatchObject({ state: "failed", committed: 0, error: { code: "timedOut", reason: "stalled" } });
        expect(waited).toBeLessThan((STALL_SECONDS + 10) * 1_000);
        expect(await released(proxy, links)).toBe(links);
        expect(await count()).toEqual({ rows: 0, distinct: 0 });
      });

      it("givenCancel_whenImporting_thenRolledBackAndConnectionReleased", async () => {
        const { proxy, engine, count, start } = await rig();
        const links = proxy.openLinks;
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start({ mode: "all" });
        await engine.importing(task.taskId, 1);
        const during = proxy.openLinks;

        await engine.connection.handle({ id: 9, type: "import.cancel", taskId: task.taskId });
        const done = await engine.imported(task.taskId);

        expect(during).toBe(links + 1);
        expect(done).toMatchObject({ state: "cancelled", committed: 0, error: { code: "cancelled" } });
        expect(await released(proxy, links)).toBe(links);
        expect(await count()).toEqual({ rows: 0, distinct: 0 });
      });
    },
  );
}
