import { PluginError } from "@table-craft/plugin-api";

/** `Conflicting lock is held in /Applications/TableCraft.app/…/TableCraft Helper (PID 4120) by user ann.` */
const LOCK_HOLDER = /Conflicting lock is held in (.+?) \(PID (\d+)\)/u;
const SEPARATORS = /[\\/]/u;
/** What Windows says when `duckdb.node` loads but `libduckdb.dll`'s runtime does not (`ERROR_MOD_NOT_FOUND`). */
const MISSING_MODULE = /The specified module could not be found/iu;
/** A package of another platform, or a bundle built without the binding beside it (decision 156). */
const MISSING_BINDING = /Cannot find module '\.\/duckdb\.node'/u;
export const MISSING_BINDING_MESSAGE =
  "This DuckDB plugin has no DuckDB binary for this computer. Remove it in Settings → Plugins and install it again.";
export const VC_REDIST_MESSAGE =
  "DuckDB needs the Microsoft Visual C++ Redistributable. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe and connect again.";

export interface LockHolder {
  readonly program: string;
  readonly pid: number;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The program and process DuckDB names as holding the file, or null when the message is not a lock conflict. */
export function lockConflict(message: string): LockHolder | null {
  const match = LOCK_HOLDER.exec(message);
  if (match === null) return null;
  const [, path = "", pid = ""] = match;
  return { program: path.split(SEPARATORS).at(-1) ?? path, pid: Number(pid) };
}

function fileName(path: string): string {
  return path.split(SEPARATORS).at(-1) ?? path;
}

/** Why connecting to `path` failed, said so the user knows what to do next. */
export function connectFailure(cause: unknown, path: string, platform: string = process.platform): PluginError {
  const message = messageOf(cause);
  const holder = lockConflict(message);
  if (holder !== null) {
    return new PluginError(
      "connectionFailed",
      `${fileName(path)} is open in ${holder.program} (PID ${String(holder.pid)}). Disconnect the other datasource on this file, or open the file read-only in every program that uses it.`,
      { cause },
    );
  }
  if (platform === "win32" && MISSING_MODULE.test(message)) {
    return new PluginError("connectionFailed", VC_REDIST_MESSAGE, { cause });
  }
  if (MISSING_BINDING.test(message)) {
    return new PluginError("connectionFailed", MISSING_BINDING_MESSAGE, { cause });
  }
  return new PluginError("connectionFailed", message, { cause });
}
