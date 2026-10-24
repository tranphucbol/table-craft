import type { SqlFileOpened } from "@table-craft/desktop/preload/bridge.js";
import { fileNameOf } from "@table-craft/desktop/renderer/model/exportText.js";
import { ConsoleFileFailure } from "@table-craft/desktop/renderer/state/consoleFiles.js";
import {
  DETACHED,
  fileSourceOf,
  isDirty,
  type ConsolesStore,
  type FileConsoleSource,
} from "@table-craft/desktop/renderer/state/consoles.js";
import type { ModalRequest } from "@table-craft/desktop/renderer/state/modal.js";
import type { SqlFileAccess } from "@table-craft/desktop/renderer/state/sqlFiles.js";
import type { Tab, TabsStore } from "@table-craft/desktop/renderer/state/tabs.js";

/** The answers of the unsaved-files question; Cancel answers null. */
export const UNSAVED_CHOICES = { save: "save", discard: "discard" } as const;
export const SAVE_AS_TITLE = "Save Console As";
export const SQL_EXTENSION = ".sql";
/** A kept file's modification time once it is gone from disk, so Keep Mine stops asking about it. */
const GONE_MODIFIED_AT = -1;
const FILE_HINT = "Check that the file exists and that you may read and write it.";

export interface FileConsoleDependencies {
  readonly files: SqlFileAccess;
  readonly consoles: ConsolesStore;
  readonly tabs: TabsStore;
  readonly ask: (request: ModalRequest) => Promise<string | null>;
  readonly newTab: (title: string) => Tab;
  readonly datasourceExists: (id: string) => boolean;
}

/** File consoles (plan 041): consoles whose text is a `.sql` file the user chose, saved explicitly. */
export interface FileConsoles {
  /** The console holding `path`, or null. */
  readonly consoleOf: (path: string) => string | null;
  /**
   * Opens each file in a tab, or activates the tab already holding it. A file goes on the data
   * source it was last used with, else on `datasourceId`, else detached.
   */
  readonly open: (paths: readonly string[], datasourceId: string | null) => Promise<void>;
  /**
   * Reads the files the layout had open; one notice names those gone or unreadable, which come
   * back null so their tabs are skipped (decision 5).
   */
  readonly reopen: (paths: readonly string[]) => Promise<readonly (SqlFileOpened | null)[]>;
  /** A tab for a file already read, on `datasourceId` (or detached when that is gone); its tab id. */
  readonly openTab: (file: SqlFileOpened, datasourceId: string) => string;
  readonly save: (id: string) => Promise<boolean>;
  /** Writes the console to a path the user picks; a scratch console becomes a file console. */
  readonly saveAs: (id: string) => Promise<boolean>;
  /** Renames the file on disk, in its folder. */
  readonly rename: (id: string, name: string) => Promise<boolean>;
  /** Replaces the text with the file's: Reload on the changed-on-disk banner. */
  readonly reload: (id: string) => Promise<void>;
  /** Keeps the editor's text over a change on disk until the next one. */
  readonly keepMine: (id: string) => Promise<void>;
  /** Reloads clean consoles whose file changed and flags the dirty ones: run on window focus. */
  readonly checkDisk: () => Promise<void>;
  /** Asks Save / Don't Save / Cancel for the dirty file consoles among `ids`; false on Cancel or a failed save. */
  readonly settleDirty: (ids: readonly string[], verb: string) => Promise<boolean>;
  /** Remembers each file console's data source and namespace as they change; the unsubscribe. */
  readonly rememberAttachments: () => () => void;
}

function sourceOf(file: SqlFileOpened): FileConsoleSource {
  return {
    kind: "file",
    path: file.path,
    savedSql: file.sql,
    lineEnding: file.lineEnding,
    modifiedAt: file.modifiedAt,
  };
}

const namespaceKey = (namespace: readonly string[] | null) => (namespace === null ? null : JSON.stringify(namespace));

export function createFileConsoles(dependencies: FileConsoleDependencies): FileConsoles {
  const { files, consoles, tabs, ask } = dependencies;

  async function fail(title: string, cause: unknown): Promise<void> {
    await ask({
      kind: "notice",
      title,
      message: cause instanceof Error ? cause.message : String(cause),
      hint: cause instanceof ConsoleFileFailure ? cause.hint : FILE_HINT,
    });
  }

  function consoleOf(path: string): string | null {
    const entry = Object.entries(consoles.getState().consoles).find(
      ([, session]) => fileSourceOf(session)?.path === path,
    );
    return entry?.[0] ?? null;
  }

  function openTab(file: SqlFileOpened, datasourceId: string): string {
    const attached = dependencies.datasourceExists(datasourceId) ? datasourceId : DETACHED;
    const namespace = file.attachment?.datasourceId === attached ? file.attachment.namespace : null;
    const name = fileNameOf(file.path);
    const tab = dependencies.newTab(name);
    tabs.getState().open(tab);
    void consoles.getState().open(tab.id, attached, {
      name,
      sql: file.sql,
      connect: false,
      source: sourceOf(file),
      namespace,
    });
    return tab.id;
  }

  function remember(id: string): void {
    const session = consoles.getState().consoles[id];
    const source = session === undefined ? null : fileSourceOf(session);
    if (session === undefined || source === null || session.datasourceId === DETACHED) return;
    const namespace = session.namespace ?? session.pendingNamespace;
    void files.attach(source.path, { datasourceId: session.datasourceId, namespace }).catch(() => undefined);
  }

  async function save(id: string): Promise<boolean> {
    const session = consoles.getState().consoles[id];
    const source = session === undefined ? null : fileSourceOf(session);
    if (session === undefined || source === null) return false;
    const sql = session.sql;
    try {
      const modifiedAt = await files.write(source.path, sql, source.lineEnding);
      consoles.getState().saved(id, { ...source, savedSql: sql, modifiedAt });
      return true;
    } catch (cause) {
      await fail(`Could not save ${fileNameOf(source.path)}`, cause);
      return false;
    }
  }

  async function reload(id: string): Promise<void> {
    const source = fileSourceOf(consoles.getState().consoles[id]);
    if (source === null) return;
    try {
      const file = await files.read(source.path);
      consoles.getState().reloaded(id, file.sql, sourceOf(file));
    } catch (cause) {
      await fail(`Could not reload ${fileNameOf(source.path)}`, cause);
    }
  }

  return {
    consoleOf,
    openTab,
    save,
    reload,

    async open(paths, datasourceId) {
      for (const path of paths) {
        const existing = consoleOf(path);
        if (existing !== null) {
          tabs.getState().activate(existing);
          continue;
        }
        let file: SqlFileOpened;
        try {
          file = await files.open(path);
        } catch (cause) {
          await fail(`Could not open ${fileNameOf(path)}`, cause);
          continue;
        }
        const remembered = file.attachment?.datasourceId;
        const target =
          remembered !== undefined && dependencies.datasourceExists(remembered)
            ? remembered
            : (datasourceId ?? DETACHED);
        openTab(file, target);
      }
    },

    async reopen(paths) {
      const missing: string[] = [];
      const read = await Promise.all(
        paths.map((path) =>
          files.read(path).catch((cause: unknown) => {
            missing.push(cause instanceof Error ? cause.message : String(cause));
            return null;
          }),
        ),
      );
      if (missing.length > 0) {
        void ask({
          kind: "notice",
          title: missing.length === 1 ? "A file did not reopen" : "Some files did not reopen",
          message: missing.join("\n"),
          hint: `${missing.length === 1 ? "Its tab was" : "Their tabs were"} skipped. Open the file with Open File… once it is back.`,
        });
      }
      return read;
    },

    async saveAs(id) {
      const session = consoles.getState().consoles[id];
      if (session === undefined) return false;
      const source = fileSourceOf(session);
      const defaultName = source === null ? `${session.name}${SQL_EXTENSION}` : fileNameOf(source.path);
      let path: string | null;
      try {
        path = await files.chooseSavePath(SAVE_AS_TITLE, defaultName);
      } catch (cause) {
        await fail("Could not save the console", cause);
        return false;
      }
      if (path === null) return false;
      const holder = consoleOf(path);
      if (holder !== null && holder !== id) {
        await ask({
          kind: "notice",
          title: "Could not save the console",
          message: `${fileNameOf(path)} is open in another tab.`,
          hint: "Close that tab first, or choose another name.",
        });
        return false;
      }
      const sql = consoles.getState().consoles[id]?.sql ?? session.sql;
      const lineEnding = source?.lineEnding ?? "lf";
      try {
        const modifiedAt = await files.write(path, sql, lineEnding);
        const name = fileNameOf(path);
        consoles.getState().saved(id, { kind: "file", path, savedSql: sql, lineEnding, modifiedAt }, name);
        tabs.getState().retitle(id, name);
        remember(id);
        return true;
      } catch (cause) {
        await fail(`Could not save ${fileNameOf(path)}`, cause);
        return false;
      }
    },

    async rename(id, name) {
      const source = fileSourceOf(consoles.getState().consoles[id]);
      if (source === null) return false;
      try {
        const path = await files.rename(source.path, name);
        const current = fileSourceOf(consoles.getState().consoles[id]) ?? source;
        const renamed = fileNameOf(path);
        consoles.getState().saved(id, { ...current, path }, renamed);
        tabs.getState().retitle(id, renamed);
        return true;
      } catch (cause) {
        await fail(`Could not rename ${fileNameOf(source.path)}`, cause);
        return false;
      }
    },

    async keepMine(id) {
      const source = fileSourceOf(consoles.getState().consoles[id]);
      if (source === null) return;
      const [modifiedAt] = await files.stat([source.path]).catch(() => [null]);
      consoles.getState().saved(id, { ...source, modifiedAt: modifiedAt ?? GONE_MODIFIED_AT });
    },

    async checkDisk() {
      const open = Object.entries(consoles.getState().consoles).flatMap(([id, session]) => {
        const source = fileSourceOf(session);
        return source === null ? [] : [{ id, path: source.path }];
      });
      if (open.length === 0) return;
      const times = await files.stat(open.map((entry) => entry.path)).catch(() => null);
      if (times === null) return;
      for (const [index, entry] of open.entries()) {
        const session = consoles.getState().consoles[entry.id];
        const source = fileSourceOf(session);
        const time = times[index] ?? null;
        if (session === undefined || source?.path !== entry.path) continue;
        if (time === null) {
          if (source.modifiedAt !== GONE_MODIFIED_AT) consoles.getState().setDiskChanged(entry.id, "deleted");
        } else if (time !== source.modifiedAt) {
          if (isDirty(session)) consoles.getState().setDiskChanged(entry.id, "changed");
          else await reload(entry.id);
        }
      }
    },

    async settleDirty(ids, verb) {
      const dirty = ids.flatMap((id) => {
        const session = consoles.getState().consoles[id];
        const source = session === undefined ? null : fileSourceOf(session);
        return session !== undefined && source !== null && isDirty(session) ? [{ id, path: source.path }] : [];
      });
      if (dirty.length === 0) return true;
      const one = dirty.length === 1;
      const answer = await ask({
        kind: "choice",
        title: one ? "Unsaved file" : "Unsaved files",
        message: `${one ? "This file has" : "These files have"} changes that are not saved. Save before you ${verb}?`,
        items: dirty.map(({ path }) => ({ label: fileNameOf(path), detail: path, tone: "info" })),
        choices: [
          { id: UNSAVED_CHOICES.save, label: "Save", variant: "primary" },
          { id: UNSAVED_CHOICES.discard, label: "Don't Save", variant: "danger" },
        ],
      });
      if (answer === null) return false;
      if (answer === UNSAVED_CHOICES.discard) return true;
      for (const { id } of dirty) if (!(await save(id))) return false;
      return true;
    },

    rememberAttachments() {
      return consoles.subscribe((state, previous) => {
        for (const [id, session] of Object.entries(state.consoles)) {
          const before = previous.consoles[id];
          if (before === undefined || before === session || fileSourceOf(session) === null) continue;
          const moved =
            before.datasourceId !== session.datasourceId ||
            (session.namespace !== null && namespaceKey(before.namespace) !== namespaceKey(session.namespace));
          if (moved) remember(id);
        }
      });
    },
  };
}
