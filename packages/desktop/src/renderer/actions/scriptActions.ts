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
import {
  isScriptAsking,
  isScriptRunning,
  useScripts,
  type ScriptEntry,
} from "@table-craft/desktop/renderer/state/scripts.js";
import { fileMarks, offsetOf } from "@table-craft/desktop/renderer/model/errorLocation.js";
import { scriptFailure, scriptFailures } from "@table-craft/desktop/renderer/model/scriptText.js";
import type { ErrorAnswer, ScriptError } from "@table-craft/desktop/engine/protocol.js";

export const SCRIPT_ACTION_IDS = {
  run: "database.runSqlScript",
  cancel: "script.cancel",
  goTo: "script.goTo",
  dismiss: "script.dismiss",
  skip: "script.skip",
  skipAll: "script.skipAll",
  stop: "script.stop",
  retry: "script.retry",
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

/**
 * Opens the failed statement's file and lands on where the database pointed, else on the
 * statement's line; every failure of that file is marked in its console (decision 083).
 */
async function goToStatement(entry: ScriptEntry): Promise<void> {
  const failure = scriptFailure(entry.task);
  const file = failure?.file;
  if (failure === null || file === null || file === undefined) return;
  await fileConsoles.open([file], entry.datasourceId);
  const id = fileConsoles.consoleOf(file);
  const session = id === null ? undefined : useConsoles.getState().consoles[id];
  if (id === null || session === undefined || failure.line === null) return;
  const consoles = useConsoles.getState();
  consoles.markErrors(
    id,
    fileMarks(
      session.sql,
      scriptFailures(entry.task).filter((each) => each.file === file),
    ),
  );
  const [mark] = fileMarks(session.sql, [failure]);
  if (mark !== undefined) {
    consoles.jumpTo(id, mark);
    return;
  }
  const from = offsetOf(session.sql, failure.line, failure.column ?? 1);
  const lineEnd = session.sql.indexOf(NEWLINE, from);
  consoles.jumpTo(id, { from, to: lineEnd < 0 ? session.sql.length : lineEnd });
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

/** A failure Go to statement can land on: one with a file and a line. */
export function hasFailedStatement(entry: ScriptEntry): boolean {
  const failure = scriptFailure(entry.task);
  return failure?.file != null && failure.line !== null;
}
const dismissable = (entry: ScriptEntry) => !isScriptRunning(entry);

function answerAction(id: string, title: string, value: ErrorAnswer): AnyAction {
  return defineAction<Partial<ScriptTaskArgs> | undefined>({
    id,
    title,
    category: "Tool Windows",
    when: () => entryFor(undefined, isScriptAsking) !== null,
    run: async (_context, args) => {
      const entry = entryFor(args, isScriptAsking);
      if (entry !== null) await useScripts.getState().answer(entry.task.taskId, value);
    },
  });
}

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
    when: () => entryFor(undefined, hasFailedStatement) !== null,
    run: async (_context, args) => {
      const entry = entryFor(args, hasFailedStatement);
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
  answerAction(SCRIPT_ACTION_IDS.skip, "Skip Failed Script Statement", "skip"),
  answerAction(SCRIPT_ACTION_IDS.skipAll, "Skip All Failed Script Statements", "skipAll"),
  answerAction(SCRIPT_ACTION_IDS.stop, "Stop SQL Script at Failed Statement", "stop"),
  answerAction(SCRIPT_ACTION_IDS.retry, "Retry Failed Script Statement", "retry"),
];
