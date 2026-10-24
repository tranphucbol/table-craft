import type { FileAttachment, LineEnding, SqlFileOpened } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { unwrap } from "@table-craft/desktop/renderer/state/consoleFiles.js";

/** The SQL files main reads and writes for file consoles (plan 041); each failure is a `ConsoleFileFailure`. */
export interface SqlFileAccess {
  /** The native open dialog; empty when cancelled. */
  readonly choose: (title: string) => Promise<readonly string[]>;
  /** The native save dialog; null when cancelled. */
  readonly chooseSavePath: (title: string, defaultName: string) => Promise<string | null>;
  /** Reads the file and makes it the most recent. */
  readonly open: (path: string) => Promise<SqlFileOpened>;
  /** Reads the file again, leaving the recent list alone. */
  readonly read: (path: string) => Promise<SqlFileOpened>;
  /** Writes the file; its new modification time. */
  readonly write: (path: string, sql: string, lineEnding: LineEnding) => Promise<number>;
  /** Renames the file in its folder; its new path. */
  readonly rename: (path: string, name: string) => Promise<string>;
  readonly stat: (paths: readonly string[]) => Promise<readonly (number | null)[]>;
  readonly attach: (path: string, attachment: FileAttachment) => Promise<void>;
  readonly recent: () => Promise<readonly string[]>;
}

export function bridgeSqlFiles(): SqlFileAccess {
  return {
    choose: (title) => unwrap(bridge().chooseSqlFiles(title)),
    chooseSavePath: (title, defaultName) => unwrap(bridge().saveFile(title, defaultName)),
    open: (path) => unwrap(bridge().openSqlFile(path)),
    read: (path) => unwrap(bridge().readSqlFile(path)),
    write: async (path, sql, lineEnding) => (await unwrap(bridge().writeSqlFile(path, sql, lineEnding))).modifiedAt,
    rename: async (path, name) => (await unwrap(bridge().renameSqlFile(path, name))).path,
    stat: (paths) => unwrap(bridge().statSqlFiles(paths)),
    attach: async (path, attachment) => {
      await unwrap(bridge().attachSqlFile(path, attachment));
    },
    recent: () => unwrap(bridge().recentSqlFiles()),
  };
}
