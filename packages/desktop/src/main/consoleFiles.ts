import { join } from "node:path";
import { writeAtomically, type FileSystem } from "@table-craft/desktop/main/files.js";

/** Under the profile directory: one subdirectory per datasource id, one `<name>.sql` per console. */
export const CONSOLES_DIR = "consoles";
export const CONSOLE_EXTENSION = ".sql";
/** Word characters, dots and dashes only, so a name can never leave its datasource's directory. */
export const CONSOLE_NAME_PATTERN = /^[\w.-]{1,64}$/;
/** `.` and `..` match the pattern but would name a directory, not a file inside it. */
const DOTS_ONLY = /^\.+$/;

/** The directory operations console files need beyond `FileSystem`, injected for the tests. */
export interface DirectoryFileSystem extends FileSystem {
  /** The file names directly inside `path`; empty when it does not exist. */
  listNames(path: string): Promise<readonly string[]>;
  makeDirectory(path: string): Promise<void>;
  /** Resolves when the file does not exist. */
  remove(path: string): Promise<void>;
  /** Removes the directory and everything in it; resolves when it does not exist. */
  removeDirectory(path: string): Promise<void>;
}

export class ConsoleFileError extends Error {
  override readonly name = "ConsoleFileError";

  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/** The SQL text of each console, saved per datasource (plan 006, decision 16). */
export interface ConsoleFiles {
  /** The console names saved for the datasource, sorted. */
  list(datasourceId: string): Promise<readonly string[]>;
  /** Null when no console of that name is saved. */
  read(datasourceId: string, name: string): Promise<string | null>;
  write(datasourceId: string, name: string, text: string): Promise<void>;
  delete(datasourceId: string, name: string): Promise<void>;
  /** Renames a saved console; refuses a name another console has. Nothing saved yet is nothing to move. */
  rename(datasourceId: string, from: string, to: string): Promise<void>;
  /** The absolute path a console's text is saved at, whether or not it is written yet. */
  path(datasourceId: string, name: string): string;
  /** Removes every console saved for the datasource, when the datasource is deleted. */
  deleteAll(datasourceId: string): Promise<void>;
}

export interface ConsoleFilesOptions {
  /** The profile directory; consoles live under `CONSOLES_DIR` inside it. */
  readonly directory: string;
  readonly files: DirectoryFileSystem;
}

function checked(kind: string, value: string): string {
  if (!CONSOLE_NAME_PATTERN.test(value) || DOTS_ONLY.test(value)) {
    throw new ConsoleFileError(
      `The ${kind} "${value}" cannot name a console file.`,
      "Use up to 64 letters, digits, underscores, dots or dashes.",
    );
  }
  return value;
}

export function createConsoleFiles(options: ConsoleFilesOptions): ConsoleFiles {
  const { files } = options;
  const root = join(options.directory, CONSOLES_DIR);

  function directoryOf(datasourceId: string): string {
    return join(root, checked("datasource id", datasourceId));
  }

  function pathOf(datasourceId: string, name: string): string {
    return join(directoryOf(datasourceId), `${checked("console name", name)}${CONSOLE_EXTENSION}`);
  }

  return {
    async list(datasourceId) {
      const names = await files.listNames(directoryOf(datasourceId));
      return names
        .filter((file) => file.endsWith(CONSOLE_EXTENSION))
        .map((file) => file.slice(0, -CONSOLE_EXTENSION.length))
        .filter((name) => CONSOLE_NAME_PATTERN.test(name))
        .sort();
    },
    read: async (datasourceId, name) => files.readText(pathOf(datasourceId, name)),
    async write(datasourceId, name, text) {
      const path = pathOf(datasourceId, name);
      await files.makeDirectory(directoryOf(datasourceId));
      await writeAtomically(files, path, text);
    },
    delete: async (datasourceId, name) => files.remove(pathOf(datasourceId, name)),
    async rename(datasourceId, from, to) {
      const source = pathOf(datasourceId, from);
      const target = pathOf(datasourceId, to);
      if (from === to) return;
      // A case-only rename finds its own file as the target on a case-insensitive disk.
      if (from.toLowerCase() !== to.toLowerCase() && (await files.readText(target)) !== null) {
        throw new ConsoleFileError(`A console named "${to}" already exists.`, "Choose another name.");
      }
      if ((await files.readText(source)) === null) return;
      await files.rename(source, target);
    },
    path: pathOf,
    deleteAll: async (datasourceId) => files.removeDirectory(directoryOf(datasourceId)),
  };
}
