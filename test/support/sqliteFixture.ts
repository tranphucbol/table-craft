import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = new URL("../db/schema/sqlite.sql", import.meta.url);
/** Plan 152's schema: foreign keys by naming convention only, none declared. */
const ERD_SCHEMA = new URL("./erd.sqlite.sql", import.meta.url);
const DATABASE_FILE = "fixture.sqlite";

function seededFile(schema: URL | string): string {
  const path = join(mkdtempSync(join(tmpdir(), "table-craft-sqlite-")), DATABASE_FILE);
  const database = new DatabaseSync(path);
  try {
    database.exec(typeof schema === "string" ? schema : readFileSync(schema, "utf8"));
  } finally {
    database.close();
  }
  return path;
}

/**
 * A file database seeded from `test/db/schema/sqlite.sql`. A file, not `:memory:`, because every
 * contract case opens its own session and an in-memory database dies with its connection.
 */
export function seededSqliteFile(): string {
  return seededFile(SCHEMA);
}

/** A file database seeded from `test/support/erd.sqlite.sql`, whose keys only the diagram infers. */
export function erdSqliteFile(): string {
  return seededFile(ERD_SCHEMA);
}

const WIDE_NAME_DIGITS = 3;

/** The name of table `index` (from 1) in `wideErdSqliteFile`: `t001`, `t002`, … */
export function wideErdTable(index: number): string {
  return `t${String(index).padStart(WIDE_NAME_DIGITS, "0")}`;
}

/**
 * A file database of `tables` tables in a binary tree by naming convention alone: every table but
 * the first has `<parent>_id`, the parent being table `index / 2`, so the diagram infers
 * `tables - 1` keys and declares none.
 */
export function wideErdSqliteFile(tables: number): string {
  const statements = Array.from({ length: tables }, (_, offset) => {
    const index = offset + 1;
    const parent = index === 1 ? "" : `, ${wideErdTable(Math.floor(index / 2))}_id INTEGER NOT NULL`;
    return `CREATE TABLE ${wideErdTable(index)} (id INTEGER PRIMARY KEY, name TEXT NOT NULL${parent});`;
  });
  return seededFile(statements.join("\n"));
}
