import { readFile, readdir } from "node:fs/promises";
import type { ImportFiles } from "@table-craft/desktop/main/import/types.js";

const MISSING = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM"]);

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (code !== undefined && MISSING.has(code)) return null;
    throw cause;
  }
}

/** The disk, read-only: the importers open nothing for writing and lock nothing. */
export const nodeImportFiles: ImportFiles = {
  readText: (path) => orNull(() => readFile(path, "utf8")),
  readBytes: (path) => orNull(async () => new Uint8Array(await readFile(path))),
  list: (path) => orNull(() => readdir(path)),
};
