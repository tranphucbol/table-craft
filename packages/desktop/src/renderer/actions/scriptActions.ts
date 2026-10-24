import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { fileConsoles } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { capabilitiesOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { isScriptRunning, useScripts, type ScriptEntry } from "@table-craft/desktop/renderer/state/scripts.js";
import type { ScriptError } from "@table-craft/desktop/engine/protocol.js";

export const SCRIPT_ACTION_IDS = {
  run: "database.runSqlScript",
  cancel: "script.cancel",
  goTo: "script.goTo",
  dismiss: "script.dismiss",
} as const;

const CHOOSE_TITLE = "Run SQL Script";
const SQL = "sql";
const NEWLINE = "\n";

/**
 * Where a script runs: the selected datasource, or the schema or database of the selected tree
 * node, else the focused tab's datasource in its default namespace.
 */
export function scriptTarget(
  context: ActionContext,
): { readonly datasourceId: string; readonly namespace: readonly string[] | null } | null {
  const datasourceId = context.datasource?.view.id;
  if (datasourceId === undefined) return null;
  const state = useDatasources.getState();
  const view = datasourceById(state, datasourceId);
  if (view === undefined || !capabilitiesOf(state.plugins, view.pluginId).includes(SQL)) return null;
  const { selection } = context;
  if (!context.inDatabasePane || selection?.kind !== "catalog" || selection.id !== datasourceId) {
    return { datasourceId, namespace: null };
  }
  const key = pathKey(selection.path);
  const namespaces = useCatalog.getState().catalogs[datasourceId]?.namespaces ?? [];
  return namespaces.some((namespace) => pathKey(namespace.path) === key)
    ? { datasourceId, namespace: selection.path }
    : { datasourceId, namespace: null };
}

/** A failed script says where it stopped even when its Services line is scrolled away. */
function noticeWhenFailed(taskId: string): void {
  void useScripts
    .getState()
    .finished(taskId)
    .then(async (task) => {
      if (task.state !== "failed" || task.error === null) return;
      await useModal.getState().ask({
        kind: "notice",
        title: "SQL script failed",
        message: task.error.line === null ? task.error.message : `${located(task.error)}: ${task.error.message}`,
        hint: task.error.hint,
      });
    });
}

/** "orders.sql, line 12, column 3". */
export function located(error: ScriptError): string {
  const name = error.file?.split(/[\\/]/u).pop() ?? "";
  return error.line === null ? name : `${name}, line ${String(error.line)}, column ${String(error.column ?? 1)}`;
}

/** The offset of `line` and `column` (both from 1) in `text`, clamped to the text. */
export function offsetOf(text: string, line: number, column: number): number {
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const end = text.indexOf(NEWLINE, start);
    if (end < 0) return text.length;
    start = end + 1;
  }
  const end = text.indexOf(NEWLINE, start);
  return Math.min(start + column - 1, end < 0 ? text.length : end);
}

async function goToStatement(entry: ScriptEntry): Promise<void> {
  const { error } = entry.task;
  if (error?.file === null || error?.file === undefined) return;
  await fileConsoles.open([error.file], entry.datasourceId);
  const id = fileConsoles.consoleOf(error.file);
  const session = id === null ? undefined : useConsoles.getState().consoles[id];
  if (id === null || session === undefined || error.line === null) return;
  const from = offsetOf(session.sql, error.line, error.column ?? 1);
  const lineEnd = session.sql.indexOf(NEWLINE, from);
  useConsoles.getState().jumpTo(id, { from, to: lineEnd < 0 ? session.sql.length : lineEnd });
}

/** A Services line names its task; from the palette the newest one the action fits. */
export interface ScriptTaskArgs {
  readonly taskId: string;
}

function entryFor(
  args: Partial<ScriptTaskArgs> | undefined,
  fits: (entry: ScriptEntry) => boolean,
): ScriptEntry | null {
  const { entries } = useScripts.getState();
  if (args?.taskId !== undefined) {
    const entry = entries.find((candidate) => candidate.task.taskId === args.taskId);
    return entry !== undefined && fits(entry) ? entry : null;
  }
  return [...entries].reverse().find(fits) ?? null;
}

const stoppedAtStatement = (entry: ScriptEntry) => entry.task.state === "failed" && entry.task.error?.file != null;
const dismissable = (entry: ScriptEntry) => !isScriptRunning(entry);

export const SCRIPT_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: SCRIPT_ACTION_IDS.run,
    title: "Run SQL Script…",
    category: "Database",
    icon: "run",
    when: (context) => scriptTarget(context) !== null,
    run: async (context) => {
      const target = scriptTarget(context);
      if (target === null) return;
      const chosen = await bridge().chooseSqlFiles(CHOOSE_TITLE);
      if (!chosen.ok || chosen.value.length === 0) return;
      try {
        const task = await useScripts.getState().start(target.datasourceId, chosen.value, target.namespace);
        noticeWhenFailed(task.taskId);
      } catch (cause) {
        const error = toError(cause);
        await useModal
          .getState()
          .ask({ kind: "notice", title: "Could not run the script", message: error.message, hint: error.hint });
      }
    },
  }),
  defineAction<Partial<ScriptTaskArgs> | undefined>({
    id: SCRIPT_ACTION_IDS.cancel,
    title: "Cancel SQL Script",
    category: "Tool Windows",
    icon: "cancel",
    when: () => entryFor(undefined, isScriptRunning) !== null,
    run: async (_context, args) => {
      const entry = entryFor(args, isScriptRunning);
      if (entry !== null) await useScripts.getState().cancel(entry.task.taskId);
    },
  }),
  defineAction<Partial<ScriptTaskArgs> | undefined>({
    id: SCRIPT_ACTION_IDS.goTo,
    title: "Go to Failed Script Statement",
    category: "Tool Windows",
    icon: "search",
    when: () => entryFor(undefined, stoppedAtStatement) !== null,
    run: async (_context, args) => {
      const entry = entryFor(args, stoppedAtStatement);
      if (entry !== null) await goToStatement(entry);
    },
  }),
  defineAction<Partial<ScriptTaskArgs> | undefined>({
    id: SCRIPT_ACTION_IDS.dismiss,
    title: "Remove Finished SQL Script",
    category: "Tool Windows",
    icon: "close",
    when: () => entryFor(undefined, dismissable) !== null,
    run: (_context, args) => {
      const entry = entryFor(args, dismissable);
      if (entry !== null) useScripts.getState().dismiss(entry.task.taskId);
    },
  }),
];
