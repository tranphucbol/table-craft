import type { SqlFileOpened } from "@table-craft/desktop/preload/bridge.js";
import { fileNameOf } from "@table-craft/desktop/renderer/model/exportText.js";
import {
  AUTOSAVE_DELAY_MS,
  ConsoleFileFailure,
  type Timers,
} from "@table-craft/desktop/renderer/state/consoleFiles.js";
import {
  DETACHED,
  fileSourceOf,
  isDirty,
  type ConsolesStore,
  type FileConsoleSource,
} from "@table-craft/desktop/renderer/state/consoles.js";
import type { ModalRequest } from "@table-craft/desktop/renderer/state/modal.js";
import type { SqlFileAccess } from "@table-craft/desktop/renderer/state/sqlFiles.js";
import {
  assertConsoleTextPersistable,
  ConsolePersistenceFailure,
} from "@table-craft/desktop/renderer/state/consolePersistence.js";
import type { Tab, TabsStore } from "@table-craft/desktop/renderer/state/tabs.js";

/** The answers of the unsaved-files question; Cancel answers null. */
export const UNSAVED_CHOICES = { save: "save", discard: "discard" } as const;
export const SAVE_AS_TITLE = "Save Console As";
export const SQL_EXTENSION = ".sql";
const FILE_HINT = "Check that the file exists and that you may read and write it.";

export interface FileConsoleDependencies {
  readonly files: SqlFileAccess;
  readonly consoles: ConsolesStore;
  readonly tabs: TabsStore;
  readonly ask: (request: ModalRequest) => Promise<string | null>;
  readonly newTab: (title: string) => Tab;
  readonly datasourceExists: (id: string) => boolean;
  readonly validateText?: (datasourceId: string, text: string) => Promise<void>;
  /** Absent, the global timers. */
  readonly timers?: Timers;
  readonly autosaveDelayMs?: number;
}

const GLOBAL_TIMERS: Timers = {
  set: (run, ms) => globalThis.setTimeout(run, ms),
  clear: (timer) => globalThis.clearTimeout(timer as number),
};

/** File consoles (plan 041): consoles whose text is a `.sql` file the user chose, autosaved (decision 089). */
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
  /** Writes the file now, over any change made on disk. */
  readonly save: (id: string) => Promise<boolean>;
  /** Writes the console to a path the user picks; a scratch console becomes a file console. */
  readonly saveAs: (id: string) => Promise<boolean>;
  /** Renames the file on disk, in its folder. */
  readonly rename: (id: string, name: string) => Promise<boolean>;
  /** Replaces the text with the file's: Reload on the changed-on-disk banner. */
  readonly reload: (id: string) => Promise<void>;
  /** Writes the editor's text over the change made on disk. */
  readonly keepMine: (id: string) => Promise<void>;
  /** Reloads clean consoles whose file changed and flags the dirty ones: run on window focus. */
  readonly checkDisk: () => Promise<void>;
  /**
   * Writes the unsaved file consoles among `ids`, then asks Save / Don't Save / Cancel for those
   * that could not be written or changed on disk; false on Cancel or a failed save.
   */
  readonly settleDirty: (ids: readonly string[], verb: string) => Promise<boolean>;
  /**
   * Writes each file console once typing pauses, unless its file changed on disk since it was
   * read, which raises the changed-on-disk banner instead; the unsubscribe.
   */
  readonly autosave: () => () => void;
  /** Writes every pending autosave now: the window lost focus or a tab is closing. */
  readonly flush: () => Promise<void>;
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
  const timers = dependencies.timers ?? GLOBAL_TIMERS;
  const delayMs = dependencies.autosaveDelayMs ?? AUTOSAVE_DELAY_MS;
  const validateText = dependencies.validateText ?? assertConsoleTextPersistable;
  const pending = new Map<string, unknown>();
  /** Each console's write in flight, so two never race and the older text never lands last. */
  const writing = new Map<string, Promise<unknown>>();
  /** Consoles whose last autosave failed: the notice shows once per run of failures. */
  const failing = new Set<string>();

  async function fail(title: string, cause: unknown): Promise<void> {
    await ask({
      kind: "notice",
      title,
      message: cause instanceof Error ? cause.message : String(cause),
      hint: cause instanceof ConsoleFileFailure || cause instanceof ConsolePersistenceFailure ? cause.hint : FILE_HINT,
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

  function serially<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (writing.get(id) ?? Promise.resolve()).then(task, task);
    writing.set(id, run);
    void run
      .finally(() => {
        if (writing.get(id) === run) writing.delete(id);
      })
      .catch(() => undefined);
    return run;
  }

  function cancelPending(id: string): boolean {
    if (!pending.has(id)) return false;
    timers.clear(pending.get(id));
    pending.delete(id);
    return true;
  }

  async function write(id: string): Promise<void> {
    const session = consoles.getState().consoles[id];
    const source = session === undefined ? null : fileSourceOf(session);
    if (session === undefined || source === null) return;
    const sql = session.sql;
    await validateText(session.datasourceId, sql);
    const modifiedAt = await files.write(source.path, sql, source.lineEnding);
    const current = fileSourceOf(consoles.getState().consoles[id]) ?? source;
    consoles.getState().saved(id, { ...current, savedSql: sql, modifiedAt });
    failing.delete(id);
  }

  function save(id: string): Promise<boolean> {
    cancelPending(id);
    return serially(id, async () => {
      try {
        await write(id);
        return true;
      } catch (cause) {
        const path = fileSourceOf(consoles.getState().consoles[id])?.path ?? "";
        await fail(`Could not save ${fileNameOf(path)}`, cause);
        return false;
      }
    });
  }

  /** The quiet save: skipped for a clean console or one whose file changed on disk, which it flags. */
  function autosaveNow(id: string): Promise<void> {
    cancelPending(id);
    return serially(id, async () => {
      const session = consoles.getState().consoles[id];
      const source = session === undefined ? null : fileSourceOf(session);
      if (session === undefined || source === null || !isDirty(session) || session.diskChanged !== null) return;
      const [time] = await files.stat([source.path]).catch(() => [undefined]);
      if (time === null) {
        consoles.getState().setDiskChanged(id, "deleted");
        return;
      }
      if (time !== undefined && time !== source.modifiedAt) {
        consoles.getState().setDiskChanged(id, "changed");
        return;
      }
      try {
        await write(id);
      } catch (cause) {
        if (failing.has(id)) return;
        failing.add(id);
        await fail(`Could not save ${fileNameOf(source.path)}`, cause);
      }
    });
  }

  function schedule(id: string): void {
    cancelPending(id);
    const timer = timers.set(() => {
      if (pending.get(id) !== timer) return;
      pending.delete(id);
      void autosaveNow(id);
    }, delayMs);
    pending.set(id, timer);
  }

  async function flush(): Promise<void> {
    await Promise.all([...pending.keys()].map((id) => autosaveNow(id)));
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
    flush,

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
      cancelPending(id);
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
      const current = consoles.getState().consoles[id];
      if (current === undefined) return false;
      const sql = current.sql;
      const lineEnding = source?.lineEnding ?? "lf";
      try {
        await validateText(current.datasourceId, sql);
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
      if (fileSourceOf(consoles.getState().consoles[id]) === null) return;
      await save(id);
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
          consoles.getState().setDiskChanged(entry.id, "deleted");
        } else if (time !== source.modifiedAt) {
          if (isDirty(session)) consoles.getState().setDiskChanged(entry.id, "changed");
          else await reload(entry.id);
        }
      }
    },

    async settleDirty(ids, verb) {
      await flush();
      await Promise.all(ids.map((id) => autosaveNow(id)));
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

    autosave() {
      const stop = consoles.subscribe((state, previous) => {
        for (const [id, session] of Object.entries(state.consoles)) {
          const before = previous.consoles[id];
          if (before === undefined || before.sql === session.sql) continue;
          if (fileSourceOf(session) !== null && isDirty(session)) schedule(id);
        }
      });
      return () => {
        stop();
        for (const id of [...pending.keys()]) cancelPending(id);
      };
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
