import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished as streamFinished } from "node:stream/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CSV_FORMAT, type PluginLoadResult } from "@table-craft/core";
import mysql from "@table-craft/plugin-mysql";
import oracle from "@table-craft/plugin-oracle";
import postgres from "@table-craft/plugin-postgres";
import {
  MYSQL_CONFIG,
  ORACLE_CONFIG,
  POSTGRES_CONFIG,
  databaseEnabled,
  type DatabaseId,
} from "../support/databases.js";
import { execute, exportHarness, openSession, startImport } from "../support/engineExports.js";
import { MYSQL_MANIFEST, ORACLE_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";

/**
 * Plan 021: one import of a CSV over 2 GiB per server database, generated on the fly, checked by
 * row count and a checksum the server computes over every payload, with the process's resident
 * memory sampled throughout. Gated: it writes gigabytes and takes minutes. Run it against the
 * volume-backed databases of `compose.large.yml`; the tmpfs ones run out of memory.
 */

const ENABLED = process.env.TABLE_CRAFT_LARGE_IMPORT === "1";
/** A file to append each run's numbers to, one JSON line per database, for the plan's Live test. */
const REPORT = process.env.TABLE_CRAFT_LARGE_IMPORT_REPORT;
const ROWS = 4_000_000;
const PAYLOAD_REPEATS = 16;
const MIN_BYTES = 2 * 1024 ** 3;
/** The engine holds one batch, not the file; anything near the file's size means it buffered. */
const MAX_RSS_GROWTH_BYTES = 400 * 1024 ** 2;
const RSS_SAMPLE_MS = 250;
const LARGE_TEST_TIMEOUT_MS = 60 * 60_000;
const WRITE_BATCH_LINES = 10_000;
/** The checksum adds the first 32 bits of each payload's MD5, as a number. */
const CHECKSUM_HEX_CHARS = 8;
const HEX = 16;
const MEBIBYTE = 1024 ** 2;
const TABLE = "table_craft_import_large";

interface Target {
  readonly name: DatabaseId;
  readonly plugin: PluginLoadResult;
  readonly config: object;
  readonly path: readonly string[];
  readonly create: string;
  readonly checksum: string;
  /** How the server folds an unquoted name: Oracle's upper case. */
  readonly fold?: (name: string) => string;
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    plugin: { status: "loaded", directory: "plugins/postgres", manifest: POSTGRES_MANIFEST, plugin: postgres },
    config: POSTGRES_CONFIG,
    path: ["table_craft", "public"],
    create: `CREATE TABLE ${TABLE} (id BIGINT PRIMARY KEY, label TEXT NOT NULL, payload TEXT NOT NULL)`,
    checksum:
      `SELECT COUNT(*)::text, COUNT(DISTINCT id)::text, ` +
      `SUM(('x' || substr(md5(payload), 1, ${String(CHECKSUM_HEX_CHARS)}))::bit(32)::bigint)::text FROM ${TABLE}`,
  },
  {
    name: "mysql",
    plugin: { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql },
    config: MYSQL_CONFIG,
    path: ["table_craft"],
    create: `CREATE TABLE ${TABLE} (id BIGINT PRIMARY KEY, label VARCHAR(64) NOT NULL, payload TEXT NOT NULL)`,
    checksum:
      `SELECT CAST(COUNT(*) AS CHAR), CAST(COUNT(DISTINCT id) AS CHAR), ` +
      `CAST(SUM(CAST(CONV(SUBSTR(MD5(payload), 1, ${String(CHECKSUM_HEX_CHARS)}), 16, 10) AS UNSIGNED)) AS CHAR) FROM ${TABLE}`,
  },
  {
    name: "oracle",
    plugin: { status: "loaded", directory: "plugins/oracle", manifest: ORACLE_MANIFEST, plugin: oracle },
    config: ORACLE_CONFIG,
    path: ["TABLE_CRAFT"],
    create: `CREATE TABLE ${TABLE} (id NUMBER(19) PRIMARY KEY, label VARCHAR2(64 CHAR) NOT NULL, payload VARCHAR2(600 CHAR) NOT NULL)`,
    checksum:
      `SELECT TO_CHAR(COUNT(*)), TO_CHAR(COUNT(DISTINCT id)), ` +
      `TO_CHAR(SUM(TO_NUMBER(SUBSTR(RAWTOHEX(STANDARD_HASH(payload, 'MD5')), 1, ${String(CHECKSUM_HEX_CHARS)}), '${"X".repeat(CHECKSUM_HEX_CHARS)}'))) FROM ${TABLE}`,
    fold: (name) => name.toUpperCase(),
  },
];

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/**
 * `id,label,payload`, the payload quoted and holding a comma so every row takes the quoted path.
 * Returns the checksum the servers should compute.
 */
async function writeCsv(path: string): Promise<bigint> {
  const out = createWriteStream(path);
  let checksum = 0n;
  let batch = "id,label,payload\n";
  for (let id = 1; id <= ROWS; id += 1) {
    const label = md5(String(id));
    const payload = `${label}, ${label.repeat(PAYLOAD_REPEATS - 1)}`;
    checksum += BigInt(Number.parseInt(md5(payload).slice(0, CHECKSUM_HEX_CHARS), HEX));
    batch += `${String(id)},row ${label},"${payload}"\n`;
    if (id % WRITE_BATCH_LINES === 0) {
      if (!out.write(batch))
        await new Promise<void>((resolve) =>
          out.once("drain", () => {
            resolve();
          }),
        );
      batch = "";
    }
  }
  out.end(batch);
  await streamFinished(out);
  return checksum;
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

describe.runIf(ENABLED)("large import", { timeout: LARGE_TEST_TIMEOUT_MS }, () => {
  let directory = "";
  let file = "";
  let checksum = 0n;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "table-craft-large-import-"));
    file = join(directory, "large.csv");
    checksum = await writeCsv(file);
  }, LARGE_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  for (const target of TARGETS) {
    it.skipIf(!databaseEnabled(target.name))(
      `givenMultiGigabyteCsv_whenImportedInto_${target.name}_thenCountAndChecksumMatchAndMemoryFlat`,
      async () => {
        const fold = target.fold ?? ((name: string) => name);
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
        const run = async (sql: string) => (await execute(engine.connection, sessionId, sql)).firstWindow.rows;
        await run(`DROP TABLE IF EXISTS ${TABLE}`);
        await run(target.create);
        cleanup.push(async () => void (await run(`DROP TABLE IF EXISTS ${TABLE}`)));
        const size = (await stat(file)).size;

        const rss = sampleRss();
        const task = await startImport(engine.connection, {
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
          transaction: { mode: "all" },
          errors: { mode: "stop" },
        });
        const done = await engine.imported(task.taskId);
        const memory = rss.stop();
        const [row] = await run(target.checksum);
        const [rows, distinct, sum] = row as readonly string[];
        if (REPORT !== undefined) {
          await appendFile(
            REPORT,
            `${JSON.stringify({
              database: target.name,
              rows: done.written,
              bytes: size,
              elapsedMs: done.elapsedMs,
              mibPerSecond: Math.round((size / MEBIBYTE / (done.elapsedMs / 1_000)) * 10) / 10,
              rssBaselineMiB: Math.round(memory.baseline / MEBIBYTE),
              rssPeakMiB: Math.round(memory.peak / MEBIBYTE),
              checksum: sum,
              expectedChecksum: String(checksum),
            })}\n`,
          );
        }

        expect(size).toBeGreaterThanOrEqual(MIN_BYTES);
        expect(done).toMatchObject({ state: "done", written: ROWS, committed: ROWS, rejected: 0, bytes: size });
        expect([rows, distinct]).toEqual([String(ROWS), String(ROWS)]);
        expect(sum).toBe(String(checksum));
        expect(memory.peak - memory.baseline).toBeLessThan(MAX_RSS_GROWTH_BYTES);
      },
    );
  }
});
