import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import type { ParameterValues } from "@table-craft/desktop/renderer/model/parameters.js";
import {
  autosave,
  bridgeConsoleFiles,
  closedConsoleNames,
  ConsoleFileFailure,
  firstFreeName,
  unwrap,
  type ConsoleFileAccess,
} from "@table-craft/desktop/renderer/state/consoleFiles.js";
import {
  consolesOf,
  fileSourceOf,
  openTransactions,
  SCRATCH,
  useConsoles,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { useDdl } from "@table-craft/desktop/renderer/state/ddl.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { createFileConsoles } from "@table-craft/desktop/renderer/state/fileConsoles.js";
import { useLayout, type OpenConsole } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { bridgeSqlFiles } from "@table-craft/desktop/renderer/state/sqlFiles.js";
import { useSessions } from "@table-craft/desktop/renderer/state/sessions.js";
import { activeTab, useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import { pendingTables, tablesOf, useTables } from "@table-craft/desktop/renderer/state/tables.js";
import { settlePendingEdits } from "@table-craft/desktop/renderer/actions/tableCommands.js";

const CONSOLE_ID_PREFIX = "console-";
const COMMIT = "commit";
const ROLLBACK = "rollback";
let consolesOpened = 0;
/** One allocation at a time per datasource, so two quick New Consoles never take the same name. */
const allocating = new Map<string, Promise<unknown>>();
const files: ConsoleFileAccess = bridgeConsoleFiles();

function newTab(name: string): Tab {
  return { id: `${CONSOLE_ID_PREFIX}${String(consolesOpened++)}`, kind: "console", title: name };
}

/** The window's file consoles (plan 041). */
export const fileConsoles = createFileConsoles({
  files: bridgeSqlFiles(),
  consoles: useConsoles,
  tabs: useTabs,
  ask: (request) => useModal.getState().ask(request),
  newTab,
  datasourceExists: (id) => datasourceById(useDatasources.getState(), id) !== undefined,
});

/** Whether the datasource's consoles are kept on disk: an ephemeral one is never saved (decision 018). */
export function persists(datasourceId: string): boolean {
  const view = datasourceById(useDatasources.getState(), datasourceId);
  return view !== undefined && !view.ephemeral;
}

/** Opens a console tab on the datasource, named with the first free `console`, `console_1`… (decision 16); answers its tab id. */
export function openConsole(datasourceId: string, sql?: string, parameterValues?: ParameterValues): Promise<string> {
  return allocateConsole(datasourceId, (id, name) => {
    void useConsoles.getState().open(id, datasourceId, { name, sql, parameterValues });
  });
}

/**
 * Opens a console tab like `openConsole`, in `namespace`, and answers its tab id once its session
 * is open (or failed to open), so a caller can run it straight away.
 */
export async function openConsoleOn(
  datasourceId: string,
  options: { readonly sql: string; readonly parameterValues: ParameterValues; readonly namespace: readonly string[] },
): Promise<string> {
  let session: Promise<void> = Promise.resolve();
  const id = await allocateConsole(datasourceId, (tabId, name) => {
    session = useConsoles.getState().open(tabId, datasourceId, { name, ...options });
  });
  await session;
  return id;
}

function allocateConsole(datasourceId: string, open: (id: string, name: string) => void): Promise<string> {
  const previous = allocating.get(datasourceId) ?? Promise.resolve();
  const opened = previous.then(async () => {
    const saved = persists(datasourceId) ? await files.list(datasourceId).catch(() => []) : [];
    const name = firstFreeName([...saved, ...openNames(datasourceId)]);
    const tab = newTab(name);
    useTabs.getState().open(tab);
    open(tab.id, name);
    return tab.id;
  });
  allocating.set(datasourceId, opened);
  return opened;
}

function openNames(datasourceId: string): readonly string[] {
  const { consoles } = useConsoles.getState();
  return consolesOf(consoles, datasourceId).map((id) => consoles[id]?.name ?? "");
}

/** The datasource's saved consoles no tab has open; pending writes land first, so one just closed is listed. */
export async function closedConsoles(datasourceId: string): Promise<readonly string[]> {
  await autosave.flush();
  return closedConsoleNames(await files.list(datasourceId), openNames(datasourceId));
}

export function readConsole(datasourceId: string, name: string): Promise<string> {
  return files.read(datasourceId, name).then((text) => text ?? "");
}

export function deleteConsoleFile(datasourceId: string, name: string): Promise<void> {
  return files.remove(datasourceId, name);
}

/** Opens a saved console as a tab under its own name, with its text (plan 011 decision 14). */
export async function reopenConsole(datasourceId: string, name: string): Promise<void> {
  const sql = await readConsole(datasourceId, name);
  const tab = newTab(name);
  useTabs.getState().open(tab);
  void useConsoles.getState().open(tab.id, datasourceId, { name, sql });
}

/**
 * Reopens the console tabs the layout remembers, with their saved text, each disconnected until
 * its first Run: launching connects nothing (decision 17).
 */
export async function restoreConsoles(): Promise<void> {
  const remembered = useLayout
    .getState()
    .layout.openConsoles.filter((entry) => entry.path !== undefined || persists(entry.datasourceId));
  const paths = remembered.flatMap((entry) => (entry.path === undefined ? [] : [entry.path]));
  const [scratch, opened] = await Promise.all([
    Promise.all(
      remembered.map((entry) =>
        entry.path === undefined ? files.read(entry.datasourceId, entry.name).catch(() => null) : Promise.resolve(null),
      ),
    ),
    fileConsoles.reopen(paths),
  ]);
  const byPath = new Map(paths.map((path, index) => [path, opened[index] ?? null]));
  let active: string | null = null;
  for (const [index, entry] of remembered.entries()) {
    let tabId: string;
    if (entry.path === undefined) {
      const tab = newTab(entry.name);
      useTabs.getState().open(tab);
      const sql = scratch[index] ?? "";
      void useConsoles.getState().open(tab.id, entry.datasourceId, { name: entry.name, sql, connect: false });
      tabId = tab.id;
    } else {
      const file = byPath.get(entry.path) ?? null;
      if (file === null) continue;
      tabId = fileConsoles.openTab(file, entry.datasourceId);
    }
    if (entry.active) active = tabId;
  }
  if (active !== null) useTabs.getState().activate(active);
}

/** Keeps the layout's list of open console tabs in step with the tab strip. */
export function rememberOpenConsoles(): () => void {
  const remember = () => {
    const strip = useTabs.getState();
    const current = activeTab(strip)?.id ?? null;
    const { consoles } = useConsoles.getState();
    useLayout.getState().setOpenConsoles(
      strip.tabs.flatMap((tab): OpenConsole[] => {
        const session = consoles[tab.id];
        if (tab.kind !== "console" || session === undefined) return [];
        const active = tab.id === current;
        const source = fileSourceOf(session);
        if (source !== null)
          return [{ datasourceId: session.datasourceId, name: session.name, active, path: source.path }];
        if (!persists(session.datasourceId)) return [];
        return [{ datasourceId: session.datasourceId, name: session.name, active }];
      }),
    );
  };
  remember();
  const offTabs = useTabs.subscribe(remember);
  const offConsoles = useConsoles.subscribe((state, previous) => {
    if (Object.keys(state.consoles).length !== Object.keys(previous.consoles).length) remember();
  });
  return () => {
    offTabs();
    offConsoles();
  };
}

/**
 * Writes each scratch console as it changes and when it closes, unless its datasource is gone or
 * ephemeral; file consoles save only when asked (plan 041 decision 3).
 */
export function autosaveConsoles(): () => void {
  return useConsoles.subscribe((state, previous) => {
    for (const [id, session] of Object.entries(state.consoles)) {
      const before = previous.consoles[id];
      if (before === undefined || before.sql === session.sql || fileSourceOf(session) !== null) continue;
      if (!persists(session.datasourceId)) continue;
      autosave.changed(session.datasourceId, session.name, session.sql);
    }
    for (const [id, session] of Object.entries(previous.consoles)) {
      if (id in state.consoles || fileSourceOf(session) !== null) continue;
      if (persists(session.datasourceId)) void autosave.closed(session.datasourceId, session.name, session.sql);
      else autosave.discard(session.datasourceId);
    }
  });
}

/**
 * Asks once whether to commit or roll back the open transactions in `consoleIds`, then does it;
 * false when the user cancelled or an end failed, which its console's Output explains.
 */
export async function settleTransactions(consoleIds: readonly string[], verb: string): Promise<boolean> {
  const { consoles } = useConsoles.getState();
  const open = consoleIds.filter((id) => consoles[id]?.transactionOpen === true);
  if (open.length === 0) return true;
  const tabs = useTabs.getState().tabs;
  const answer = await useModal.getState().ask({
    kind: "choice",
    title: open.length === 1 ? "Open transaction" : "Open transactions",
    message: `${open.length === 1 ? "This console has" : "These consoles have"} uncommitted changes. Commit or roll back to ${verb}.`,
    items: open.map((id) => {
      const session = consoles[id];
      const datasource = datasourceById(useDatasources.getState(), session?.datasourceId ?? "");
      const title = tabs.find((tab) => tab.id === id)?.title ?? session?.name ?? id;
      return { label: datasource === undefined ? title : `${title} [${datasource.name}]`, detail: "" };
    }),
    choices: [
      { id: COMMIT, label: "Commit", variant: "primary" },
      { id: ROLLBACK, label: "Rollback", variant: "danger" },
    ],
  });
  if (answer === null) return false;
  const store = useConsoles.getState();
  const ended = await Promise.all(open.map((id) => (answer === COMMIT ? store.commit(id) : store.rollback(id))));
  return ended.every(Boolean);
}

/** Settles the pending result edits of the consoles among `ids` (plan 026), one console at a time. */
async function settleConsoleEdits(ids: readonly string[], verb: string): Promise<boolean> {
  for (const id of ids) {
    if (useConsoles.getState().consoles[id] === undefined) continue;
    if (!(await useConsoles.getState().settleEdits(id, verb))) return false;
  }
  return true;
}

/**
 * Closes tabs as `close` picks them, once their consoles' open transactions (decision 15) and their
 * tables' pending changes (plan 008) are settled.
 */
export async function closeTabs(ids: readonly string[], close: () => readonly Tab[]): Promise<void> {
  if (!(await fileConsoles.settleDirty(ids, "close"))) return;
  if (!(await settlePendingEdits(ids, "close"))) return;
  if (!(await settleConsoleEdits(ids, "close"))) return;
  if (!(await settleTransactions(ids, "close"))) return;
  for (const tab of close()) {
    if (tab.kind === "console") useConsoles.getState().close(tab.id);
    else if (tab.kind === "table") useTables.getState().close(tab.id);
    else if (tab.kind === "sessions") useSessions.getState().close(tab.id);
    else useDdl.getState().close(tab.id);
  }
}

/** Save: a file console writes its file; a scratch console's pending autosave lands now. */
export async function saveConsole(id: string): Promise<boolean> {
  const session = useConsoles.getState().consoles[id];
  if (session === undefined) return false;
  if (fileSourceOf(session) !== null) return fileConsoles.save(id);
  await autosave.flush();
  return true;
}

/** Rename Console…: a scratch console's saved file, checked against the name pattern in main, or a file on disk. */
export async function renameConsole(id: string): Promise<void> {
  const session = useConsoles.getState().consoles[id];
  if (session === undefined) return;
  const file = fileSourceOf(session) !== null;
  const name = await useModal.getState().ask({
    kind: "text",
    title: file ? "Rename File" : "Rename Console",
    label: file ? "File name" : "Name",
    initial: session.name,
    confirm: "Rename",
  });
  if (name === null || name.trim() === session.name) return;
  if (file) {
    await fileConsoles.rename(id, name);
    return;
  }
  const renamed = name.trim();
  if (openNames(session.datasourceId).includes(renamed)) {
    await useModal.getState().ask({
      kind: "notice",
      title: "Could not rename the console",
      message: `A console named "${renamed}" is open.`,
      hint: "Choose another name.",
    });
    return;
  }
  if (persists(session.datasourceId)) {
    // A pending write under the old name would recreate the old file after the rename.
    await autosave.flush();
    try {
      await unwrap(bridge().renameConsole(session.datasourceId, session.name, renamed));
    } catch (cause) {
      await useModal.getState().ask({
        kind: "notice",
        title: "Could not rename the console",
        message: cause instanceof Error ? cause.message : String(cause),
        hint: cause instanceof ConsoleFileFailure ? cause.hint : "Check that the profile directory is writable.",
      });
      return;
    }
  }
  useConsoles.getState().saved(id, SCRATCH, renamed);
  useTabs.getState().retitle(id, renamed);
}

export async function disconnectDatasource(datasourceId: string): Promise<void> {
  if (!(await settlePendingEdits(tablesOf(useTables.getState().tables, datasourceId), "disconnect"))) return;
  if (!(await settleConsoleEdits(consolesOf(useConsoles.getState().consoles, datasourceId), "disconnect"))) return;
  if (!(await settleTransactions(consolesOf(useConsoles.getState().consoles, datasourceId), "disconnect"))) return;
  await useDatasources.getState().disconnect(datasourceId);
}

/** Main holds a close or quit until the window settles its pending changes and transactions and saves its consoles. */
export function answerCloseRequests(): () => void {
  return bridge().onCloseRequested(() => {
    void (async () => {
      const proceed =
        (await fileConsoles.settleDirty(Object.keys(useConsoles.getState().consoles), "quit")) &&
        (await settlePendingEdits(pendingTables(useTables.getState().tables), "quit")) &&
        (await settleConsoleEdits(Object.keys(useConsoles.getState().consoles), "quit")) &&
        (await settleTransactions(openTransactions(useConsoles.getState().consoles), "quit"));
      if (proceed) await autosave.flush();
      await bridge().answerClose(proceed);
    })();
  });
}
