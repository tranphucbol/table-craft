import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import mysql from "@table-craft/plugin-mysql";
import oracle from "@table-craft/plugin-oracle";
import postgres from "@table-craft/plugin-postgres";
import type { ExportTask } from "@table-craft/desktop/engine/protocol.js";
import { chaosProxy, type ChaosProxy } from "../support/chaosProxy.js";
import {
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
  startExport,
  type ExportHarness,
} from "../support/engineExports.js";
import { MYSQL_MANIFEST, ORACLE_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";

/** Plan 018: exports over a link that is slow, goes quiet, resets or vanishes. */

const ROWS = 60_000;
const PAYLOAD_REPEATS = 4;
/** The watchdog's floor (`EXPORT_STALL_SECONDS_RANGE.min`), so a stall test waits as little as allowed. */
const STALL_SECONDS = 10;
const SLOW_BYTES_PER_SECOND = 1_000_000;
const THROTTLED_BYTES_PER_SECOND = 4_000_000;
const THROTTLED_LATENCY_MS = 5;
const FIRST_ROWS = 1;
const RELEASE_TIMEOUT_MS = 10_000;
const RELEASE_POLL_MS = 100;
const CHAOS_TEST_TIMEOUT_MS = 90_000;
const ORIGINAL_TARGET = "the file the user already had\n";
const EXPORTED_COLUMNS = [0, 1, 2];

/** An MD5 digest in hex. */
const MD5_HEX_CHARS = 32;

const DIGITS =
  "(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";

interface Target {
  readonly name: DatabaseId;
  readonly plugin: PluginLoadResult;
  readonly config: { readonly host: string; readonly port: number };
  readonly rows: string;
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    plugin: { status: "loaded", directory: "plugins/postgres", manifest: POSTGRES_MANIFEST, plugin: postgres },
    config: POSTGRES_CONFIG,
    rows:
      `SELECT i AS id, md5(i::text) AS label, decode(repeat(md5(i::text), ${String(PAYLOAD_REPEATS)}), 'hex') AS payload ` +
      `FROM generate_series(1, ${String(ROWS)}) AS i`,
  },
  {
    name: "mysql",
    plugin: { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql },
    config: MYSQL_CONFIG,
    rows:
      `SELECT n AS id, MD5(n) AS label, UNHEX(REPEAT(MD5(n), ${String(PAYLOAD_REPEATS)})) AS payload FROM ` +
      `(SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 1 AS n ` +
      `FROM ${DIGITS} a CROSS JOIN ${DIGITS} b CROSS JOIN ${DIGITS} c CROSS JOIN ${DIGITS} e CROSS JOIN ${DIGITS} f ` +
      `WHERE f.d < ${String(ROWS / 10_000)}) t ORDER BY n`,
  },
  {
    name: "oracle",
    plugin: { status: "loaded", directory: "plugins/oracle", manifest: ORACLE_MANIFEST, plugin: oracle },
    config: ORACLE_CONFIG,
    rows:
      `SELECT n AS "id", h AS "label", HEXTORAW(RPAD(h, ${String(MD5_HEX_CHARS * PAYLOAD_REPEATS)}, h)) AS "payload" FROM ` +
      `(SELECT LEVEL AS n, LOWER(RAWTOHEX(STANDARD_HASH(TO_CHAR(LEVEL), 'MD5'))) AS h FROM DUAL CONNECT BY LEVEL <= ${String(ROWS)}) ` +
      `ORDER BY n`,
  },
];

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function expectedLine(id: number): string {
  return `${String(id)},${md5(String(id))},0x${md5(String(id)).repeat(PAYLOAD_REPEATS)}`;
}

async function released(proxy: ChaosProxy, links: number): Promise<number> {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS;
  while (proxy.openLinks > links && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS));
  }
  return proxy.openLinks;
}

for (const target of TARGETS) {
  describe.skipIf(!databaseEnabled(target.name))(
    `export chaos: ${target.name}`,
    { timeout: CHAOS_TEST_TIMEOUT_MS },
    () => {
      const cleanup: (() => Promise<void>)[] = [];
      afterEach(async () => {
        for (const step of cleanup.splice(0).reverse()) await step();
      });

      interface Rig {
        readonly proxy: ChaosProxy;
        readonly engine: ExportHarness;
        readonly directory: string;
        readonly export: (file: string, stallSeconds?: number) => Promise<ExportTask>;
      }

      async function rig(): Promise<Rig> {
        const directory = await mkdtemp(join(tmpdir(), "table-craft-chaos-"));
        cleanup.push(() => rm(directory, { recursive: true, force: true }));
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
        const sessionId = await openSession(engine.connection);
        const { handle } = await execute(engine.connection, sessionId, target.rows);
        return {
          proxy,
          engine,
          directory,
          export: (file, stallSeconds) =>
            startExport(
              engine.connection,
              {
                source: { kind: "result", handle, columns: EXPORTED_COLUMNS },
                format: "csv",
                path: join(directory, file),
              },
              stallSeconds,
            ),
        };
      }

      it("givenThrottledLink_whenExporting_thenFileMatchesUnthrottledExport", async () => {
        const { proxy, engine, directory, export: start } = await rig();
        const plain = await engine.finished((await start("plain.csv")).taskId);
        proxy.bytesPerSecond = THROTTLED_BYTES_PER_SECOND;
        proxy.latencyMs = THROTTLED_LATENCY_MS;

        const throttled = await engine.finished((await start("throttled.csv")).taskId);
        const [first, second] = await Promise.all([
          readFile(join(directory, "plain.csv")),
          readFile(join(directory, "throttled.csv")),
        ]);

        expect(plain).toMatchObject({ state: "done", rows: ROWS, origin: "rerun" });
        expect(throttled).toMatchObject({ state: "done", rows: ROWS, bytes: plain.bytes });
        expect(second.equals(first)).toBe(true);
        expect(await readdir(directory)).toEqual(["plain.csv", "throttled.csv"]);
      });

      it("givenStallMidExport_whenWatchdogFires_thenFailsWithRowsWrittenAndNoPartFile", async () => {
        const { proxy, engine, directory, export: start } = await rig();
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start("stalled.csv", STALL_SECONDS);
        const moving = await engine.progressed(task.taskId, FIRST_ROWS);

        proxy.stall();
        const done = await engine.finished(task.taskId);

        expect(moving.state).toBe("running");
        expect(done).toMatchObject({ state: "failed", error: { code: "timedOut", reason: "stalled" } });
        expect(done.rows).toBeGreaterThan(0);
        expect(done.rows).toBeLessThan(ROWS);
        expect(done.error?.message).toContain(`${done.rows.toLocaleString("en-US")} rows were written`);
        expect(await readdir(directory)).toEqual([]);
      });

      it("givenResetMidExport_whenExporting_thenFailsCleanlyAndTargetUntouched", async () => {
        const { proxy, engine, directory, export: start } = await rig();
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start("reset.csv");
        await engine.progressed(task.taskId, FIRST_ROWS);

        proxy.reset();
        const done = await engine.finished(task.taskId);

        expect(done).toMatchObject({ state: "failed", error: { reason: "source" } });
        expect(done.rows).toBeLessThan(ROWS);
        expect(await readdir(directory)).toEqual([]);
      });

      it("givenCancel_whenExporting_thenPartFileRemovedAndConnectionReleased", async () => {
        const { proxy, engine, directory, export: start } = await rig();
        const links = proxy.openLinks;
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start("cancelled.csv");
        await engine.progressed(task.taskId, FIRST_ROWS);
        const during = proxy.openLinks;

        await engine.connection.handle({ id: 4, type: "export.cancel", taskId: task.taskId });
        const done = await engine.finished(task.taskId);

        expect(during).toBe(links + 1);
        expect(done).toMatchObject({ state: "cancelled", error: { code: "cancelled" } });
        expect(await released(proxy, links)).toBe(links);
        expect(await readdir(directory)).toEqual([]);
      });

      it("givenExistingTarget_whenExportFails_thenOriginalTargetPreserved", async () => {
        const { proxy, engine, directory, export: start } = await rig();
        await writeFile(join(directory, "kept.csv"), ORIGINAL_TARGET);
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start("kept.csv", STALL_SECONDS);
        await engine.progressed(task.taskId, FIRST_ROWS);

        proxy.blackhole();
        const done = await engine.finished(task.taskId);

        expect(done).toMatchObject({ state: "failed", error: { reason: "stalled" } });
        expect(await readFile(join(directory, "kept.csv"), "utf8")).toBe(ORIGINAL_TARGET);
        expect(await readdir(directory)).toEqual(["kept.csv"]);
      });

      it("givenBytesColumn_whenExporting_thenFullValueWritten", async () => {
        const { engine, directory, export: start } = await rig();

        const done = await engine.finished((await start("bytes.csv")).taskId);
        const lines = (await readFile(join(directory, "bytes.csv"), "utf8")).trimEnd().split("\n");

        expect(done).toMatchObject({ state: "done", rows: ROWS, clippedBytes: 0 });
        expect(lines).toHaveLength(ROWS + 1);
        expect(lines[0]).toBe("id,label,payload");
        expect(lines[1]).toBe(expectedLine(1));
        expect(lines.at(-1)).toBe(expectedLine(ROWS));
      });

      it("givenStalledExport_whenRetriedAfterResume_thenSucceeds", async () => {
        const { proxy, engine, directory, export: start } = await rig();
        proxy.bytesPerSecond = SLOW_BYTES_PER_SECOND;
        const task = await start("retried.csv", STALL_SECONDS);
        await engine.progressed(task.taskId, FIRST_ROWS);
        proxy.stall();
        const failed = await engine.finished(task.taskId);

        proxy.resume();
        proxy.bytesPerSecond = 0;
        const again = resultOf<ExportTask>(
          await engine.connection.handle({
            id: 5,
            type: "export.retry",
            taskId: task.taskId,
            stallSeconds: STALL_SECONDS,
          }),
        );
        const done = await engine.finished(again.taskId);

        expect(failed).toMatchObject({ state: "failed", retryable: true, error: { reason: "stalled" } });
        expect(done).toMatchObject({ state: "done", rows: ROWS });
        expect((await readFile(join(directory, "retried.csv"), "utf8")).trimEnd().split("\n")).toHaveLength(ROWS + 1);
        expect(await readdir(directory)).toEqual(["retried.csv"]);
      });
    },
  );
}
