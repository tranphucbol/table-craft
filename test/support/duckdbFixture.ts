import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "@table-craft/plugin-api";
import type { ContractFixture } from "@table-craft/plugin-api/testing";
import duckdb from "@table-craft/plugin-duckdb";
import { TYPE_PROBE_COPY_AS, TYPE_PROBE_EXPECTED, TYPE_PROBE_WRITE } from "./typeProbe.js";

const SCHEMA = new URL("../db/schema/duckdb.sql", import.meta.url);
/** The file's stem is the database's name, which the catalog path starts with. */
export const DUCKDB_DATABASE = "fixture";
const DATABASE_FILE = `${DUCKDB_DATABASE}.duckdb`;
export const ORDERS_PARQUET = "orders.parquet";
export const EVENTS_CSV_ZST = "events.csv.zst";
/** Rows `events.csv.zst` holds. */
export const EVENT_ROWS = 2500;

/** Where one seeded fixture lives: the database file and the data files written from it. */
export interface DuckdbFixtureFiles {
  readonly directory: string;
  readonly database: string;
  readonly parquet: string;
  readonly csvZst: string;
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/**
 * A database file seeded from `test/db/schema/duckdb.sql`, and a Parquet and a zstd CSV file
 * written from it by DuckDB itself, so no binary fixture is committed. Seeded through the plugin,
 * which closes the instance and its file lock when the session closes.
 */
export async function seededDuckdbFiles(): Promise<DuckdbFixtureFiles> {
  const directory = mkdtempSync(join(tmpdir(), "table-craft-duckdb-"));
  const files: DuckdbFixtureFiles = {
    directory,
    database: join(directory, DATABASE_FILE),
    parquet: join(directory, ORDERS_PARQUET),
    csvZst: join(directory, EVENTS_CSV_ZST),
  };
  const session = await duckdb.connect(
    { path: files.database, readOnlyFile: false, downloadExtensions: false },
    { readOnly: false },
  );
  try {
    const statements = [
      ...duckdb.language.split(readFileSync(SCHEMA, "utf8")).map((statement) => statement.sql),
      `COPY orders TO ${literal(files.parquet)} (FORMAT parquet)`,
      `COPY (SELECT range AS id, 'event ' || range AS name FROM range(${String(EVENT_ROWS)})) TO ${literal(files.csvZst)} (FORMAT csv, HEADER, COMPRESSION zstd)`,
    ];
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const _row of result.rows) void _row;
    }
  } finally {
    await session.close();
  }
  return files;
}

/** The DuckDB contract fixture over a seeded database file. */
export function duckdbContractFixture(manifest: PluginManifest, files: DuckdbFixtureFiles): ContractFixture {
  return {
    manifest,
    config: { path: files.database, readOnlyFile: false, downloadExtensions: false },
    statements: {
      sleep: (seconds) =>
        `SELECT count(*) FROM range(${String(seconds * 1_000_000)}) a, range(1000000) b WHERE a.range * b.range = -1`,
      write: TYPE_PROBE_WRITE,
      syntaxError: { sql: "SELECT 1 FROM customers ORDER id", offset: "SELECT 1 FROM customers ORDER ".length },
    },
    typeProbe: { expected: TYPE_PROBE_EXPECTED, copyTable: TYPE_PROBE_COPY_AS },
    scripts: [{ text: "SELECT $$a;b$$ AS s; SELECT 2 AS n", statements: ["SELECT $$a;b$$ AS s", "SELECT 2 AS n"] }],
    catalog: {
      path: [DUCKDB_DATABASE, "main"],
      quoted: { name: 'odd "name"', qualified: '"main"."odd ""name"""' },
      lineItems: '"Line Items"',
      ordersCheck: "total >= 0",
      customersComment: "People who place orders",
    },
  };
}
