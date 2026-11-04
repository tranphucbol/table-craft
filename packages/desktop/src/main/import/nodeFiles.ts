import { readFile, readdir, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ImportBusyError, type ImportDatabase, type ImportFiles } from "@table-craft/desktop/main/import/types.js";

const MISSING = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]);
/** SQLITE_BUSY, SQLITE_LOCKED and SQLITE_READONLY, whose extended codes share the low byte. */
const BUSY_CODES = new Set([5, 6, 8]);
const PRIMARY_CODE_MASK = 0xff;
const BUSY_MESSAGE = "The database is being written or was not closed cleanly.";

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (code !== undefined && MISSING.has(code)) return null;
    throw cause;
  }
}

function busy<T>(run: () => T): T {
  try {
    return run();
  } catch (cause) {
    const code = (cause as { errcode?: unknown } | null)?.errcode;
    if (typeof code === "number" && BUSY_CODES.has(code & PRIMARY_CODE_MASK)) throw new ImportBusyError(BUSY_MESSAGE);
    throw cause;
  }
}

async function openDatabase(path: string): Promise<ImportDatabase | null> {
  const file = await orNull(() => stat(path));
  if (file === null || !file.isFile()) return null;
  // Read-only, in place: no copy, no journal, no lock held past `close`.
  const database = busy(() => new DatabaseSync(path, { readOnly: true }));
  return {
    columns: (table) =>
      busy(() => database.prepare("SELECT name FROM pragma_table_info(?)").all(table)).map((row) => String(row.name)),
    all: (sql, ...params) => busy(() => database.prepare(sql).all(...params)),
    close: () => {
      database.close();
    },
  };
}

/** The disk, read-only: the importers open nothing for writing and lock nothing. */
export const nodeImportFiles: ImportFiles = {
  readText: (path) => orNull(() => readFile(path, "utf8")),
  readBytes: (path) => orNull(async () => new Uint8Array(await readFile(path))),
  list: (path) => orNull(() => readdir(path)),
  readDatabase: openDatabase,
};
