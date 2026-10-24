import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Utf8Error, decodeUtf8 } from "@table-craft/core";
import type { FileAttachments } from "@table-craft/desktop/main/fileAttachments.js";
import type { FileAttachment, LineEnding, SqlFileOpened, SqlFileText } from "@table-craft/desktop/preload/bridge.js";

/** Bigger files are run with Run SQL Script…, which streams them, rather than opened in an editor. */
export const SQL_FILE_EDITOR_MAX_BYTES = 32 * 1024 * 1024;
const BYTES_PER_MIB = 1024 * 1024;
const TEMPORARY_SUFFIX = ".tmp";
const CRLF = "\r\n";
const LINE_BREAKS = /\r\n?/g;
const LF = /\n/g;
const FIRST_LINE_BREAK = /\r?\n/;
const NOT_A_NAME = /[/\\\0]/;
const DOTS_ONLY = /^\.+$/;
const READ_HINT = "Check that the file exists and that you can read it.";
const WRITE_HINT = "Check that the folder exists and that you can write to it.";
const BUG_HINT = "This is a bug in TableCraft; report it with the steps that led here.";

export class SqlFileError extends Error {
  override readonly name = "SqlFileError";

  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absolute(path: string): string {
  if (!isAbsolute(path)) throw new SqlFileError(`"${path}" is not an absolute path.`, BUG_HINT);
  return path;
}

export function lineEndingOf(text: string): LineEnding {
  return FIRST_LINE_BREAK.exec(text)?.[0] === CRLF ? "crlf" : "lf";
}

/** Reads a `.sql` file for a file console (plan 041, decisions 8 and 10). */
export async function readSqlFile(path: string): Promise<SqlFileText> {
  absolute(path);
  const name = basename(path);
  let bytes: Uint8Array;
  let modifiedAt: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new SqlFileError(`"${path}" is not a file.`, "Choose a .sql file.");
    if (info.size > SQL_FILE_EDITOR_MAX_BYTES) {
      throw new SqlFileError(
        `${name} is ${String(Math.ceil(info.size / BYTES_PER_MIB))} MiB, more than the editor opens (${String(SQL_FILE_EDITOR_MAX_BYTES / BYTES_PER_MIB)} MiB).`,
        "Run it with Run SQL Script… on a data source, which streams the file instead.",
      );
    }
    modifiedAt = info.mtimeMs;
    bytes = await readFile(path);
  } catch (cause) {
    if (cause instanceof SqlFileError) throw cause;
    throw new SqlFileError(`Could not read ${name}: ${reasonOf(cause)}`, READ_HINT);
  }
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch (cause) {
    if (!(cause instanceof Utf8Error)) throw cause;
    throw new SqlFileError(
      `${name} is not UTF-8 text: byte ${String(cause.offset)} starts an invalid sequence.`,
      "Save the file as UTF-8 and open it again.",
    );
  }
  return { path, sql: text.replace(LINE_BREAKS, "\n"), lineEnding: lineEndingOf(text), modifiedAt };
}

/** The file's permission bits, to keep them across the atomic replace; null when it is new. */
async function modeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode;
  } catch {
    return null;
  }
}

/**
 * Writes the editor's text back without a BOM, in the file's line endings, beside the target then
 * renamed over it, so a crash mid-write never leaves half a migration in the user's checkout.
 */
export async function writeSqlFile(
  path: string,
  sql: string,
  lineEnding: LineEnding,
): Promise<{ readonly modifiedAt: number }> {
  absolute(path);
  const text = lineEnding === "crlf" ? sql.replace(LF, CRLF) : sql;
  const temporary = `${path}${TEMPORARY_SUFFIX}`;
  try {
    const mode = await modeOf(path);
    await writeFile(temporary, text, "utf8");
    if (mode !== null) await chmod(temporary, mode);
    await rename(temporary, path);
    return { modifiedAt: (await stat(path)).mtimeMs };
  } catch (cause) {
    throw new SqlFileError(`Could not save ${basename(path)}: ${reasonOf(cause)}`, WRITE_HINT);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Renames the file in its own folder; `name` is a file name, not a path. */
export async function renameSqlFile(path: string, name: string): Promise<{ readonly path: string }> {
  absolute(path);
  const trimmed = name.trim();
  if (trimmed === "" || NOT_A_NAME.test(trimmed) || DOTS_ONLY.test(trimmed)) {
    throw new SqlFileError(
      `"${name}" cannot name a file.`,
      "Use a file name without slashes; it stays in the same folder.",
    );
  }
  const target = join(dirname(path), trimmed);
  if (target === path) return { path };
  // A case-only rename finds its own file as the target on a case-insensitive disk.
  if (target.toLowerCase() !== path.toLowerCase() && (await exists(target))) {
    throw new SqlFileError(`${trimmed} already exists in that folder.`, "Choose another name.");
  }
  try {
    await rename(path, target);
  } catch (cause) {
    throw new SqlFileError(`Could not rename ${basename(path)}: ${reasonOf(cause)}`, READ_HINT);
  }
  return { path: target };
}

/** The SQL file channels' main side (plan 041); `Sender` is the window that asked. */
export interface SqlFileChannels<Sender> {
  choose(sender: Sender, title: string): Promise<readonly string[]>;
  open(path: string): Promise<SqlFileOpened>;
  read(path: string): Promise<SqlFileOpened>;
  write(path: string, sql: string, lineEnding: LineEnding): Promise<{ readonly modifiedAt: number }>;
  rename(path: string, name: string): Promise<{ readonly path: string }>;
  stat(paths: readonly string[]): Promise<readonly (number | null)[]>;
  attach(path: string, attachment: FileAttachment): Promise<void>;
  recent(): Promise<readonly string[]>;
}

export interface SqlFileChannelsOptions<Sender> {
  readonly attachments: FileAttachments;
  /** The native open dialog, several `.sql` files at once. */
  readonly choose: (sender: Sender, title: string) => Promise<readonly string[]>;
  /** The recent files moved; main rebuilds File → Recent Files. */
  readonly recentChanged: (recent: readonly string[]) => void;
}

export function createSqlFileChannels<Sender>(options: SqlFileChannelsOptions<Sender>): SqlFileChannels<Sender> {
  const { attachments } = options;
  return {
    choose: options.choose,
    async open(path) {
      const text = await readSqlFile(path);
      const attachment = await attachments.attachmentOf(path);
      options.recentChanged(await attachments.opened(path));
      return { ...text, attachment };
    },
    async read(path) {
      const text = await readSqlFile(path);
      return { ...text, attachment: await attachments.attachmentOf(path) };
    },
    async write(path, sql, lineEnding) {
      const written = await writeSqlFile(path, sql, lineEnding);
      options.recentChanged(await attachments.opened(path));
      return written;
    },
    async rename(path, name) {
      const renamed = await renameSqlFile(path, name);
      options.recentChanged(await attachments.renamed(path, renamed.path));
      return renamed;
    },
    stat: statSqlFiles,
    attach: (path, attachment) => attachments.attach(absolute(path), attachment),
    recent: () => attachments.recent(),
  };
}

/** Each file's modification time, or null when it is gone or unreadable. */
export async function statSqlFiles(paths: readonly string[]): Promise<readonly (number | null)[]> {
  return Promise.all(
    paths.map(async (path) => {
      try {
        return (await stat(absolute(path))).mtimeMs;
      } catch {
        return null;
      }
    }),
  );
}
