import { describe, expect, it, vi } from "vitest";
import type { FileAttachment, LineEnding, SqlFileOpened } from "@table-craft/desktop/preload/bridge.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { ConsoleFileFailure, type Timers } from "@table-craft/desktop/renderer/state/consoleFiles.js";
import { createConsolesStore, DETACHED, isDirty } from "@table-craft/desktop/renderer/state/consoles.js";
import { createFileConsoles, UNSAVED_CHOICES } from "@table-craft/desktop/renderer/state/fileConsoles.js";
import { checkConsolePersistence } from "@table-craft/desktop/renderer/state/consolePersistence.js";
import type { ModalRequest } from "@table-craft/desktop/renderer/state/modal.js";
import type { SqlFileAccess } from "@table-craft/desktop/renderer/state/sqlFiles.js";
import { createTabsStore, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";

const FILE = "/repo/migrations/seed.sql";
const OTHER = "/repo/migrations/other.sql";
const DATASOURCE = "pg";

interface DiskFile {
  sql: string;
  lineEnding: LineEnding;
  modifiedAt: number;
}

function fakeDisk(initial: Record<string, string>) {
  let clock = 1;
  const disk = new Map<string, DiskFile>(
    Object.entries(initial).map(([path, sql]) => [path, { sql, lineEnding: "lf", modifiedAt: clock }]),
  );
  const attachments = new Map<string, FileAttachment>();
  const writes: { path: string; sql: string; lineEnding: LineEnding }[] = [];
  let savePath: string | null = null;
  const opened = (path: string): Promise<SqlFileOpened> => {
    const file = disk.get(path);
    if (file === undefined) return Promise.reject(new ConsoleFileFailure(`Could not read ${path}: ENOENT`, "Check."));
    return Promise.resolve({ path, ...file, attachment: attachments.get(path) ?? null });
  };
  const files: SqlFileAccess = {
    choose: () => Promise.resolve([]),
    chooseSavePath: () => Promise.resolve(savePath),
    open: opened,
    read: opened,
    write: (path, sql, lineEnding) => {
      writes.push({ path, sql, lineEnding });
      const modifiedAt = ++clock;
      disk.set(path, { sql, lineEnding, modifiedAt });
      return Promise.resolve(modifiedAt);
    },
    rename: (path, name) => {
      const file = disk.get(path);
      if (file === undefined) return Promise.reject(new ConsoleFileFailure("gone", "Check."));
      const target = `${path.slice(0, path.lastIndexOf("/"))}/${name}`;
      disk.delete(path);
      disk.set(target, file);
      return Promise.resolve(target);
    },
    stat: (paths) => Promise.resolve(paths.map((path) => disk.get(path)?.modifiedAt ?? null)),
    attach: (path, attachment) => {
      attachments.set(path, attachment);
      return Promise.resolve();
    },
    recent: () => Promise.resolve([]),
  };
  /** Another program writes the file. */
  const edit = (path: string, sql: string) => disk.set(path, { sql, lineEnding: "lf", modifiedAt: ++clock });
  const chooseSaveAt = (path: string | null) => {
    savePath = path;
  };
  return { disk, files, writes, attachments, edit, chooseSaveAt };
}

/** Timers the test fires by hand: `fire()` runs every timer still set. */
function manualTimers() {
  const set = new Map<number, () => void>();
  let next = 0;
  const timers: Timers = {
    set: (run) => {
      const id = next++;
      set.set(id, run);
      return id;
    },
    clear: (timer) => set.delete(timer as number),
  };
  const fire = async () => {
    const due = [...set.values()];
    set.clear();
    for (const run of due) run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { timers, fire, count: () => set.size };
}

function harness(
  initial: Record<string, string> = { [FILE]: "SELECT 1;\n" },
  answer: string | null = null,
  validateText?: (datasourceId: string, text: string) => Promise<void>,
) {
  const disk = fakeDisk(initial);
  const clock = manualTimers();
  const consoles = createConsolesStore({
    connect: () => Promise.resolve({ call: vi.fn() } as unknown as EngineClient),
    now: () => 0,
  });
  const tabs = createTabsStore();
  const asked: ModalRequest[] = [];
  let opened = 0;
  const fileConsoles = createFileConsoles({
    files: disk.files,
    consoles,
    tabs,
    ask: (request) => {
      asked.push(request);
      return Promise.resolve(answer);
    },
    newTab: (title): Tab => ({ id: `console-${String(opened++)}`, kind: "console", title }),
    datasourceExists: (id) => id === DATASOURCE,
    timers: clock.timers,
    validateText: validateText ?? (() => Promise.resolve()),
  });
  const session = (id: string) => {
    const current = consoles.getState().consoles[id];
    if (current === undefined) throw new Error(`console ${id} is gone`);
    return current;
  };
  return { ...disk, consoles, tabs, asked, fileConsoles, session, clock };
}

async function openedFile(initial?: Record<string, string>, answer?: string | null) {
  const context = harness(initial, answer);
  await context.fileConsoles.open([FILE], DATASOURCE);
  const id = context.fileConsoles.consoleOf(FILE);
  if (id === null) throw new Error("the file did not open");
  return { ...context, id };
}

describe("file consoles", () => {
  it("givenAttachmentChangedDuringSaveAs_whenNewTextIsRead_thenAdmissionUsesItsCurrentDatasource", async () => {
    const validateText = vi.fn(() => Promise.reject(new Error("Text was not saved.")));
    const context = harness(undefined, null, validateText);
    await context.fileConsoles.open([FILE], DATASOURCE);
    const id = context.fileConsoles.consoleOf(FILE)!;
    context.chooseSaveAt(OTHER);
    const saving = context.fileConsoles.saveAs(id);
    context.consoles.getState().release(id);
    context.consoles.getState().attach(id, "commands-source");
    context.consoles.getState().setSql(id, "user add bob:private-password");
    expect(await saving).toBe(false);
    expect(validateText).toHaveBeenCalledWith("commands-source", "user add bob:private-password");
    expect(context.writes).toEqual([]);
  });

  it("givenInlinePassword_whenFileAutosavesOrSavesAsBeforeExecute_thenNoSecretIsWritten", async () => {
    const call = vi.fn(() => Promise.resolve([{ admit: "reject", safeLabel: "credential command" }]));
    const validator = vi.fn((_datasourceId: string, text: string) =>
      checkConsolePersistence(text, {
        capabilities: ["commands"],
        client: () => Promise.resolve({ call } as unknown as EngineClient),
        scrub: () => undefined,
      }),
    );
    const context = harness({ [FILE]: "get /a" }, null, validator);
    await context.fileConsoles.open([FILE], DATASOURCE);
    const id = context.fileConsoles.consoleOf(FILE)!;
    const stop = context.fileConsoles.autosave();
    context.consoles.getState().setSql(id, "user add bob:private-password");
    await context.clock.fire();
    expect(context.writes).toEqual([]);
    expect(await context.fileConsoles.save(id)).toBe(false);
    context.chooseSaveAt(OTHER);
    expect(await context.fileConsoles.saveAs(id)).toBe(false);
    expect(context.writes).toEqual([]);
    expect(validator).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(context.asked)).not.toContain("private-password");
    stop();
  });

  it("givenSqlFile_whenOpened_thenTabNamedAfterFileOnDatasource", async () => {
    const { id, tabs, session } = await openedFile();

    expect(tabs.getState().tabs).toEqual([{ id, kind: "console", title: "seed.sql" }]);
    expect(session(id)).toMatchObject({ datasourceId: DATASOURCE, sql: "SELECT 1;\n", status: "disconnected" });
    expect(session(id).source).toMatchObject({ kind: "file", path: FILE, savedSql: "SELECT 1;\n" });
  });

  it("givenFileAlreadyOpen_whenOpenedAgain_thenSameTabActivated", async () => {
    const { id, fileConsoles, tabs } = await openedFile({ [FILE]: "a", [OTHER]: "b" });
    await fileConsoles.open([OTHER], null);

    await fileConsoles.open([FILE], null);

    expect(tabs.getState().tabs).toHaveLength(2);
    expect(tabs.getState().activeId).toBe(id);
    expect(fileConsoles.consoleOf(OTHER)).not.toBeNull();
  });

  it("givenNoDatasourceAndNoneRemembered_whenOpened_thenDetached", async () => {
    const context = harness();
    await context.fileConsoles.open([FILE], null);

    expect(context.session(context.fileConsoles.consoleOf(FILE) ?? "").datasourceId).toBe(DETACHED);
  });

  it("givenRememberedAttachment_whenOpened_thenRememberedDatasourceAndNamespaceWin", async () => {
    const context = harness();
    context.attachments.set(FILE, { datasourceId: DATASOURCE, namespace: ["shop"] });

    await context.fileConsoles.open([FILE], "mysql");

    const session = context.session(context.fileConsoles.consoleOf(FILE) ?? "");
    expect(session).toMatchObject({ datasourceId: DATASOURCE, pendingNamespace: ["shop"] });
  });

  it("givenFileConsole_whenSave_thenFileOnDiskMatches", async () => {
    const { id, consoles, fileConsoles, disk, session } = await openedFile();
    consoles.getState().setSql(id, "SELECT 2;\n");
    expect(isDirty(session(id))).toBe(true);

    expect(await fileConsoles.save(id)).toBe(true);

    expect(disk.get(FILE)?.sql).toBe("SELECT 2;\n");
    expect(isDirty(session(id))).toBe(false);
  });

  it("givenDirtyFileConsole_whenClose_thenWrittenWithoutAsking", async () => {
    const { id, consoles, fileConsoles, disk, asked, session } = await openedFile();
    consoles.getState().setSql(id, "SELECT 2;");

    expect(await fileConsoles.settleDirty([id], "close")).toBe(true);

    expect(asked).toEqual([]);
    expect(disk.get(FILE)?.sql).toBe("SELECT 2;");
    expect(isDirty(session(id))).toBe(false);
  });

  it("givenFileChangedOnDiskWhileDirty_whenClose_thenAsksToSave", async () => {
    const saving = await openedFile(undefined, UNSAVED_CHOICES.save);
    saving.consoles.getState().setSql(saving.id, "SELECT 2;");
    saving.edit(FILE, "theirs");

    expect(await saving.fileConsoles.settleDirty([saving.id], "close")).toBe(true);
    expect(saving.asked[0]).toMatchObject({ kind: "choice", title: "Unsaved file" });
    expect(saving.disk.get(FILE)?.sql).toBe("SELECT 2;");

    const cancelling = await openedFile(undefined, null);
    cancelling.consoles.getState().setSql(cancelling.id, "SELECT 3;");
    cancelling.edit(FILE, "theirs");
    expect(await cancelling.fileConsoles.settleDirty([cancelling.id], "close")).toBe(false);
    expect(cancelling.writes).toEqual([]);

    const discarding = await openedFile(undefined, UNSAVED_CHOICES.discard);
    discarding.consoles.getState().setSql(discarding.id, "SELECT 4;");
    discarding.edit(FILE, "theirs");
    expect(await discarding.fileConsoles.settleDirty([discarding.id], "close")).toBe(true);
    expect(discarding.writes).toEqual([]);
  });

  it("givenTypingInFileConsole_whenTypingPauses_thenFileWrittenOnce", async () => {
    const { id, consoles, fileConsoles, disk, writes, session, clock } = await openedFile();
    const stop = fileConsoles.autosave();
    consoles.getState().setSql(id, "SELECT");
    consoles.getState().setSql(id, "SELECT 2;");
    expect(clock.count()).toBe(1);

    await clock.fire();
    stop();

    expect(writes).toEqual([{ path: FILE, sql: "SELECT 2;", lineEnding: "lf" }]);
    expect(disk.get(FILE)?.sql).toBe("SELECT 2;");
    expect(isDirty(session(id))).toBe(false);
  });

  it("givenFileChangedOnDisk_whenAutosaveFires_thenBannerAndNothingWritten", async () => {
    const { id, consoles, fileConsoles, edit, writes, session, clock } = await openedFile();
    const stop = fileConsoles.autosave();
    consoles.getState().setSql(id, "mine");
    edit(FILE, "theirs");

    await clock.fire();
    stop();

    expect(writes).toEqual([]);
    expect(session(id)).toMatchObject({ sql: "mine", diskChanged: "changed" });
  });

  it("givenPendingAutosave_whenFlushed_thenWrittenNow", async () => {
    const { id, consoles, fileConsoles, disk, clock } = await openedFile();
    const stop = fileConsoles.autosave();
    consoles.getState().setSql(id, "SELECT 5;");

    await fileConsoles.flush();
    stop();

    expect(disk.get(FILE)?.sql).toBe("SELECT 5;");
    expect(clock.count()).toBe(0);
  });

  it("givenScratchConsole_whenEdited_thenNoFileAutosave", async () => {
    const context = harness({});
    await context.consoles.getState().open("c1", DATASOURCE, { name: "console", sql: "x", connect: false });
    const stop = context.fileConsoles.autosave();

    context.consoles.getState().setSql("c1", "y");
    stop();

    expect(context.clock.count()).toBe(0);
  });

  it("givenCleanFileConsole_whenClose_thenNothingAsked", async () => {
    const { id, fileConsoles, asked } = await openedFile();

    expect(await fileConsoles.settleDirty([id], "close")).toBe(true);
    expect(asked).toEqual([]);
  });

  it("givenScratchConsole_whenSaveAs_thenBecomesFileConsole", async () => {
    const context = harness({});
    context.tabs.getState().open({ id: "c1", kind: "console", title: "console" });
    await context.consoles.getState().open("c1", DATASOURCE, { name: "console", sql: "SELECT 1;", connect: false });
    context.chooseSaveAt("/repo/report.sql");

    expect(await context.fileConsoles.saveAs("c1")).toBe(true);

    expect(context.disk.get("/repo/report.sql")?.sql).toBe("SELECT 1;");
    expect(context.session("c1")).toMatchObject({
      name: "report.sql",
      source: { kind: "file", path: "/repo/report.sql" },
    });
    expect(context.tabs.getState().tabs[0]?.title).toBe("report.sql");
    expect(context.attachments.get("/repo/report.sql")).toEqual({ datasourceId: DATASOURCE, namespace: null });
  });

  it("givenSaveAsCancelled_whenSaveAs_thenStaysScratch", async () => {
    const context = harness({});
    await context.consoles.getState().open("c1", DATASOURCE, { name: "console", sql: "x", connect: false });

    expect(await context.fileConsoles.saveAs("c1")).toBe(false);
    expect(context.session("c1").source).toEqual({ kind: "scratch" });
  });

  it("givenFileConsole_whenRenamed_thenTabAndPathFollow", async () => {
    const { id, fileConsoles, tabs, session, disk } = await openedFile();

    expect(await fileConsoles.rename(id, "renamed.sql")).toBe(true);

    expect(session(id).source).toMatchObject({ path: "/repo/migrations/renamed.sql" });
    expect(tabs.getState().tabs[0]?.title).toBe("renamed.sql");
    expect(disk.has(FILE)).toBe(false);
  });

  it("givenFileChangedOnDisk_whenFocus_thenCleanReloadsAndDirtyBanners", async () => {
    const { id: clean, fileConsoles, consoles, edit, session, disk } = await openedFile({ [FILE]: "a", [OTHER]: "b" });
    await fileConsoles.open([OTHER], DATASOURCE);
    const dirty = fileConsoles.consoleOf(OTHER) ?? "";
    consoles.getState().setSql(dirty, "mine");
    edit(FILE, "theirs 1");
    edit(OTHER, "theirs 2");

    await fileConsoles.checkDisk();

    expect(session(clean)).toMatchObject({ sql: "theirs 1", diskChanged: null });
    expect(session(dirty)).toMatchObject({ sql: "mine", diskChanged: "changed" });

    await fileConsoles.keepMine(dirty);
    await fileConsoles.checkDisk();
    expect(session(dirty)).toMatchObject({ sql: "mine", diskChanged: null });
    expect(isDirty(session(dirty))).toBe(false);
    expect(disk.get(OTHER)?.sql).toBe("mine");
  });

  it("givenFileDeletedOnDisk_whenFocus_thenBannerSaysDeleted", async () => {
    const { id, fileConsoles, disk, session } = await openedFile();
    disk.delete(FILE);

    await fileConsoles.checkDisk();

    expect(session(id).diskChanged).toBe("deleted");
  });

  it("givenMissingFile_whenLayoutRestores_thenNotifiesAndSkips", async () => {
    const { fileConsoles, asked } = harness({ [FILE]: "a" });

    const reopened = await fileConsoles.reopen([OTHER, FILE]);

    expect(reopened.map((file) => file?.path ?? null)).toEqual([null, FILE]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: "notice", title: "A file did not reopen" });
  });

  it("givenFileConsoleMovedToAnotherNamespace_whenRemembering_thenAttachmentSaved", async () => {
    const { id, consoles, fileConsoles, attachments } = await openedFile();
    const stop = fileConsoles.rememberAttachments();

    consoles.setState((state) => ({
      consoles: { ...state.consoles, [id]: { ...state.consoles[id]!, namespace: ["sales"] } },
    }));
    stop();

    expect(attachments.get(FILE)).toEqual({ datasourceId: DATASOURCE, namespace: ["sales"] });
  });
});
