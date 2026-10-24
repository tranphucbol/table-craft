import type { Routine } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { openConsoleOn } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { pathKey, routineKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { parseRoutineAnswer, ROUTINE_CHOICES, routineNote } from "@table-craft/desktop/renderer/model/routineCall.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import {
  capabilitiesOf,
  datasourceById,
  pluginOf,
  useDatasources,
} from "@table-craft/desktop/renderer/state/datasources.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { detectsParameters } from "@table-craft/desktop/renderer/state/settings.js";

export const ROUTINE_ACTION_IDS = {
  execute: "catalog.executeRoutine",
} as const;

const ROUTINE_CALL = "routineCall";

export const READ_ONLY_WARNING = "The data source is read-only: if the routine changes data, the server refuses it.";
export const DETECTION_OFF_WARNING =
  "Parameter detection is off: Open in Console's text binds its values only once Settings › Console › Parameters is on.";

/** The routine the Database pane has selected, on a data source whose plugin writes calls. */
interface SelectedRoutine {
  readonly datasourceId: string;
  readonly path: readonly string[];
  readonly routine: Routine;
}

function selectedRoutine(context: ActionContext): SelectedRoutine | null {
  const { selection } = context;
  if (selection?.kind !== "catalog" || selection.name === null) return null;
  const state = useDatasources.getState();
  const view = datasourceById(state, selection.id);
  if (view === undefined || !capabilitiesOf(state.plugins, view.pluginId).includes(ROUTINE_CALL)) return null;
  const described =
    useCatalog.getState().catalogs[selection.id]?.namespaceStates[pathKey(selection.path)]?.described?.catalog ?? null;
  const routine = described?.routines.find(
    (candidate) => routineKey(selection.id, selection.path, candidate) === selection.key,
  );
  return routine === undefined ? null : { datasourceId: selection.id, path: selection.path, routine };
}

async function executeRoutine({ datasourceId, path, routine }: SelectedRoutine): Promise<void> {
  const state = useDatasources.getState();
  const view = datasourceById(state, datasourceId);
  if (view === undefined) return;
  const answer = await useModal.getState().ask({
    kind: "routine",
    title: `Execute ${routine.kind === "procedure" ? "Procedure" : "Function"} ${routine.name}`,
    note: routineNote(routine, path),
    routine,
    warnings: [...(view.readOnly ? [READ_ONLY_WARNING] : []), ...(detectsParameters() ? [] : [DETECTION_OFF_WARNING])],
    preview: async (args) => {
      const client = await useDatasources.getState().connect(datasourceId);
      const { name, kind, signature } = routine;
      return client.call("routine.call", { path, name, kind, signature, args });
    },
    highlight: pluginOf(state.plugins, view.pluginId)?.highlight,
  });
  if (answer === null) return;
  const { choice, call } = parseRoutineAnswer(answer);
  const consoleId = await openConsoleOn(datasourceId, { sql: call.sql, parameterValues: call.params, namespace: path });
  if (choice === ROUTINE_CHOICES.run) await useConsoles.getState().run(consoleId, "all", call.params);
}

export const ROUTINE_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: ROUTINE_ACTION_IDS.execute,
    title: "Execute Routine…",
    category: "Database",
    icon: "run",
    available: (context) => context.datasource === null || context.datasource.capabilities.includes(ROUTINE_CALL),
    when: (context) => selectedRoutine(context) !== null,
    run: async (context) => {
      const target = selectedRoutine(context);
      if (target !== null) await executeRoutine(target);
    },
  }),
];
