import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = new URL("../db/schema/sqlite.sql", import.meta.url);
/** Plan 152's schema: foreign keys by naming convention only, none declared. */
const ERD_SCHEMA = new URL("./erd.sqlite.sql", import.meta.url);
const DATABASE_FILE = "fixture.sqlite";

function seededFile(schema: URL): string {
  const path = join(mkdtempSync(join(tmpdir(), "table-craft-sqlite-")), DATABASE_FILE);
  const database = new DatabaseSync(path);
  try {
    database.exec(readFileSync(schema, "utf8"));
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
