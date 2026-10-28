import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import mysql from "@table-craft/plugin-mysql";
import oracle from "@table-craft/plugin-oracle";
import postgres from "@table-craft/plugin-postgres";
import type { ExportTask } from "@table-craft/desktop/engine/protocol.js";
import {
  MYSQL_CONFIG,
  ORACLE_CONFIG,
  POSTGRES_CONFIG,
  databaseEnabled,
  type DatabaseId,
} from "../support/databases.js";
import { execute, exportHarness, openSession, startExport } from "../support/engineExports.js";
import { MYSQL_MANIFEST, ORACLE_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";

/**
 * Plan 018: one export of at least 3 GB per server database, checked byte for byte against the
 * rows the query is known to produce, with the process's resident memory sampled throughout.
 * Gated: it writes several gigabytes and takes minutes.
 */

const ENABLED = process.env.TABLE_CRAFT_LARGE_EXPORT === "1";
/** A file to append each run's numbers to, one JSON line per database, for the plan's Live test. */
const REPORT = process.env.TABLE_CRAFT_LARGE_EXPORT_REPORT;
const ROWS = 6_000_000;
const PAYLOAD_REPEATS = 16;
const MIN_BYTES = 3 * 1024 ** 3;
/** The engine holds one batch, not the file; anything near the file's size means it buffered. */
const MAX_RSS_GROWTH_BYTES = 400 * 1024 ** 2;
/** 6,000,000 rows over sheets of 1,048,575 data rows each (`XLSX_SHEET_ROWS` less the header). */
const XLSX_SHEETS = 6;
const SHEET_ENTRY = /xl\/worksheets\/sheet\d+\.xml/gu;
const UNZIP_MAX_BUFFER = 64 * 1024 ** 2;
/** The last sheet inflates to hundreds of megabytes; only its end is read. */
const SHEET_TAIL_BYTES = 4_096;
const RSS_SAMPLE_MS = 250;
const LARGE_TEST_TIMEOUT_MS = 30 * 60_000;
const HASH_BATCH_LINES = 10_000;
const HEADER = "id,label,payload\n";

/** An MD5 digest in hex. */
const MD5_HEX_CHARS = 32;
/** Oracle counts to ROWS as ROWS / this outer rows times this many inner ones. */
const ORACLE_LOW_ROWS = 1_000;

const DIGITS =
  "(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
const MYSQL_PLACES = ["g", "f", "e", "c", "b", "a"] as const;

interface Target {
  readonly name: DatabaseId;
  readonly plugin: PluginLoadResult;
  readonly config: object;
  readonly rows: string;
}

/**
 * Both queries yield ids 1..ROWS in ascending order without an ORDER BY, which would make the
 * server sort gigabytes first. MySQL 8.4 answers a cross join with hash joins in no useful order,
 * so `NO_BNL` (in the block that joins: hints do not reach into a derived table) and
 * `STRAIGHT_JOIN` force nested loops with the most significant digit outermost.
 */
const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    plugin: { status: "loaded", directory: "plugins/postgres", manifest: POSTGRES_MANIFEST, plugin: postgres },
    config: POSTGRES_CONFIG,
    rows:
      `SELECT i AS id, md5(i::text) AS label, repeat(md5(i::text), ${String(PAYLOAD_REPEATS)}) AS payload ` +
      `FROM generate_series(1, ${String(ROWS)}) AS i`,
  },
  {
    name: "mysql",
    plugin: { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql },
    config: MYSQL_CONFIG,
    rows:
      `SELECT n AS id, MD5(n) AS label, REPEAT(MD5(n), ${String(PAYLOAD_REPEATS)}) AS payload FROM ` +
      `(SELECT /*+ NO_BNL() */ h.d * 1000000 + ${MYSQL_PLACES.map((place, index) => `${place}.d * ${String(10 ** (MYSQL_PLACES.length - 1 - index))}`).join(" + ")} + 1 AS n ` +
      `FROM ${DIGITS} h ${MYSQL_PLACES.map((place) => `STRAIGHT_JOIN ${DIGITS} ${place}`).join(" ")} ` +
      `WHERE h.d < ${String(ROWS / 1_000_000)}) t`,
  },
  {
    name: "oracle",
    plugin: { status: "loaded", directory: "plugins/oracle", manifest: ORACLE_MANIFEST, plugin: oracle },
    config: ORACLE_CONFIG,
    // CONNECT BY holds every level in memory; a nested loop of two short ones counts as far with none.
    rows:
      `SELECT n AS "id", h AS "label", RPAD(h, ${String(MD5_HEX_CHARS * PAYLOAD_REPEATS)}, h) AS "payload" FROM ` +
      `(SELECT /*+ ORDERED USE_NL(low) */ high.d * ${String(ORACLE_LOW_ROWS)} + low.d AS n, ` +
      `LOWER(RAWTOHEX(STANDARD_HASH(TO_CHAR(high.d * ${String(ORACLE_LOW_ROWS)} + low.d), 'MD5'))) AS h ` +
      `FROM (SELECT LEVEL - 1 AS d FROM DUAL CONNECT BY LEVEL <= ${String(ROWS / ORACLE_LOW_ROWS)}) high, ` +
      `(SELECT LEVEL AS d FROM DUAL CONNECT BY LEVEL <= ${String(ORACLE_LOW_ROWS)}) low)`,
  },
];

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function expectedHash(): string {
  const hash: Hash = createHash("sha256").update(HEADER);
  let batch = "";
  for (let id = 1; id <= ROWS; id += 1) {
    const label = md5(String(id));
    batch += `${String(id)},${label},${label.repeat(PAYLOAD_REPEATS)}\n`;
    if (id % HASH_BATCH_LINES === 0) {
      hash.update(batch);
      batch = "";
    }
  }
  return hash.update(batch).digest("hex");
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function sampleRss(): { readonly stop: () => { baseline: number; peak: number } } {
  const baseline = process.memoryUsage.rss();
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, RSS_SAMPLE_MS);
  return {
    stop() {
      clearInterval(timer);
      return { baseline, peak: Math.max(peak, process.memoryUsage.rss()) };
    },
  };
}

const MEBIBYTE = 1024 ** 2;

async function sheetTail(path: string, sheet: number): Promise<string> {
  const entry = `xl/worksheets/sheet${String(sheet)}.xml`;
  const { stdout } = await promisify(execFile)("sh", [
    "-c",
    `unzip -p "$0" "$1" | tail -c ${String(SHEET_TAIL_BYTES)}`,
    path,
    entry,
  ]);
  return stdout;
}

/** The system's Info-ZIP `unzip`, a reader that shares no code with the writer. */
async function unzip(args: readonly string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("unzip", [...args], { maxBuffer: UNZIP_MAX_BUFFER });
  return stdout;
}

for (const target of TARGETS) {
  describe.runIf(ENABLED && databaseEnabled(target.name))(
    `large export: ${target.name}`,
    { timeout: LARGE_TEST_TIMEOUT_MS },
    () => {
      const cleanup: (() => Promise<void>)[] = [];
      afterEach(async () => {
        for (const step of cleanup.splice(0).reverse()) await step();
      });

      interface Run {
        readonly done: ExportTask;
        readonly path: string;
        readonly size: number;
        readonly memory: { readonly baseline: number; readonly peak: number };
      }

      async function exportLarge(format: "csv" | "xlsx"): Promise<Run> {
        const directory = await mkdtemp(join(tmpdir(), "table-craft-large-"));
        cleanup.push(() => rm(directory, { recursive: true, force: true }));
        const engine = exportHarness(
          {
            id: target.name,
            pluginId: target.name,
            config: { ...target.config },
            readOnly: false,
            keepAliveSeconds: 0,
          },
          [target.plugin],
        );
        cleanup.push(() => engine.close());
        const sessionId = await openSession(engine.connection);
        const { handle } = await execute(engine.connection, sessionId, target.rows);
        const path = join(directory, `large.${format}`);

        const rss = sampleRss();
        const task = await startExport(engine.connection, {
          source: { kind: "result", handle, columns: [0, 1, 2] },
          format,
          path,
        });
        const done = await engine.finished(task.taskId);
        const memory = rss.stop();
        expect(await readdir(directory)).toEqual([`large.${format}`]);
        return { done, path, size: (await stat(path)).size, memory };
      }

      async function report(format: string, run: Run, extra: object): Promise<void> {
        if (REPORT === undefined) return;
        await appendFile(
          REPORT,
          `${JSON.stringify({
            database: target.name,
            format,
            rows: run.done.rows,
            bytes: run.size,
            elapsedMs: run.done.elapsedMs,
            rssBaselineMiB: Math.round(run.memory.baseline / MEBIBYTE),
            rssPeakMiB: Math.round(run.memory.peak / MEBIBYTE),
            ...extra,
          })}\n`,
        );
      }

      it("givenMultiGigabyteResult_whenExportedAsCsv_thenFileCompleteAndMemoryFlat", async () => {
        const run = await exportLarge("csv");
        const [actual, expected] = [await fileHash(run.path), expectedHash()];
        await report("csv", run, { sha256: actual, expectedSha256: expected });

        expect(run.done).toMatchObject({ state: "done", rows: ROWS, origin: "rerun", bytes: run.size });
        expect(run.size).toBeGreaterThanOrEqual(MIN_BYTES);
        expect(actual).toBe(expected);
        expect(run.memory.peak - run.memory.baseline).toBeLessThan(MAX_RSS_GROWTH_BYTES);
      });

      it("givenMultiGigabyteResult_whenExportedAsXlsx_thenEverySheetIntactAndMemoryFlat", async () => {
        const run = await exportLarge("xlsx");
        const tested = await unzip(["-tq", run.path]);
        const sheets = (await unzip(["-l", run.path])).match(SHEET_ENTRY) ?? [];
        const last = await sheetTail(run.path, XLSX_SHEETS);
        await report("xlsx", run, { sheets: run.done.sheets, unzipTest: tested.trim() });

        expect(run.done).toMatchObject({ state: "done", rows: ROWS, sheets: XLSX_SHEETS, bytes: run.size });
        expect(tested).toContain("No errors detected");
        expect(sheets).toHaveLength(XLSX_SHEETS);
        expect(last).toContain(`<v>${String(ROWS)}</v>`);
        expect(last.trimEnd().endsWith("</worksheet>")).toBe(true);
        expect(run.memory.peak - run.memory.baseline).toBeLessThan(MAX_RSS_GROWTH_BYTES);
      });
    },
  );
}
