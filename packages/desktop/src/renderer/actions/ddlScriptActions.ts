import { SCRIPT_RELATION_KINDS, type RelationKind, type SchemaScript } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { openConsole, openConsoleOn } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { reportExportFailure } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import {
  namespaceKey,
  objectGroupKey,
  pathKey,
  type ObjectGroup,
} from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import { capabilitiesOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useExports } from "@table-craft/desktop/renderer/state/exports.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

export const DDL_SCRIPT_ACTION_IDS = {
  toConsole: "ddl.scriptToConsole",
  toClipboard: "ddl.scriptToClipboard",
  toFile: "ddl.scriptToFile",
} as const;

const DDL = "ddl";
const CURRENT_NAMESPACE = "currentNamespace";
const SAVE_TITLE = "Generate DDL to File";
const SQL_EXTENSION = ".sql";
const FAILED_TITLE = "Could not generate DDL";
const FAILED_HINT = "Check that this user may read those definitions, then generate the DDL again.";

/** The relations a Tables, Views or Materialized Views node scripts; a namespace scripts them all. */
const GROUP_KINDS: Readonly<Partial<Record<ObjectGroup, RelationKind>>> = {
  tables: "table",
  views: "view",
  materializedViews: "materializedView",
};

/** What a whole-namespace script covers (plan 148). */
export interface ScriptScope {
  readonly datasourceId: string;
  readonly title: string;
  readonly path: readonly string[];
  readonly name: string;
  readonly kinds: readonly RelationKind[];
  /** Where the console opens; null on a plugin that cannot switch namespaces, whose console stays put. */
  readonly consoleNamespace: readonly string[] | null;
}

/** The schema, or the Tables, Views or Materialized Views node, the Database pane has selected. */
export function scriptScope(context: ActionContext): ScriptScope | null {
  const { selection } = context;
  if (!context.inDatabasePane || selection?.kind !== "catalog" || selection.name !== null) return null;
  const state = useDatasources.getState();
  const view = datasourceById(state, selection.id);
  if (view === undefined) return null;
  const capabilities = capabilitiesOf(state.plugins, view.pluginId);
  if (!capabilities.includes(DDL)) return null;
  const key = pathKey(selection.path);
  const namespace = useCatalog
    .getState()
    .catalogs[selection.id]?.namespaces?.find((candidate) => pathKey(candidate.path) === key);
  if (namespace?.kind !== "schema") return null;
  const scope = {
    datasourceId: selection.id,
    title: view.name,
    path: namespace.path,
    name: namespace.name,
    consoleNamespace: capabilities.includes(CURRENT_NAMESPACE) ? namespace.path : null,
  };
  if (selection.key === namespaceKey(selection.id, namespace.path)) return { ...scope, kinds: SCRIPT_RELATION_KINDS };
  const group = Object.entries(GROUP_KINDS).find(
    ([candidate]) => selection.key === objectGroupKey(selection.id, namespace.path, candidate as ObjectGroup),
  );
  return group === undefined ? null : { ...scope, kinds: [group[1]] };
}

function notice(title: string, message: string, hint: string, tone?: "info"): Promise<unknown> {
  return useModal.getState().ask({ kind: "notice", title, message, hint, ...(tone === undefined ? {} : { tone }) });
}

/** The namespace's script from the engine, after its catalog is read; null when there is nothing to use. */
async function scriptOf(scope: ScriptScope): Promise<SchemaScript | null> {
  try {
    await useCatalog.getState().ensureDescribed(scope.datasourceId, scope.path);
    const client = await useDatasources.getState().connect(scope.datasourceId);
    const script = await client.call("catalog.script", { path: scope.path, kinds: scope.kinds, title: scope.title });
    if (script.relations === 0) {
      await notice("Nothing to generate", `${scope.name} has no tables or views.`, "", "info");
      return null;
    }
    return script;
  } catch (cause) {
    const error = toError(cause);
    await notice(FAILED_TITLE, error.message, error.hint);
    return null;
  }
}

/** Said after the script is delivered, so the comments it points to are already in view. */
async function reportFailures(script: SchemaScript): Promise<void> {
  if (script.failed === 0) return;
  const generated = script.relations - script.failed;
  await notice(
    "Some definitions failed",
    `Generated DDL for ${String(generated)} of ${String(script.relations)} relations; ${String(script.failed)} failed (see the comments in the script).`,
    FAILED_HINT,
  );
}

const canScript = (context: ActionContext) => scriptScope(context) !== null;

export const DDL_SCRIPT_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: DDL_SCRIPT_ACTION_IDS.toConsole,
    title: "Generate DDL to Console",
    category: "Database",
    icon: "newConsole",
    when: canScript,
    run: async (context) => {
      const scope = scriptScope(context);
      if (scope === null) return;
      const script = await scriptOf(scope);
      if (script === null) return;
      if (scope.consoleNamespace === null) await openConsole(scope.datasourceId, script.text);
      else {
        await openConsoleOn(scope.datasourceId, {
          sql: script.text,
          parameterValues: {},
          namespace: scope.consoleNamespace,
        });
      }
      await reportFailures(script);
    },
  }),
  defineAction({
    id: DDL_SCRIPT_ACTION_IDS.toClipboard,
    title: "Generate DDL to Clipboard",
    category: "Database",
    icon: "copy",
    when: canScript,
    run: async (context) => {
      const scope = scriptScope(context);
      if (scope === null) return;
      const script = await scriptOf(scope);
      if (script === null) return;
      await writeClipboard(script.text);
      await reportFailures(script);
    },
  }),
  defineAction({
    id: DDL_SCRIPT_ACTION_IDS.toFile,
    title: "Generate DDL to File…",
    category: "Database",
    icon: "export",
    when: canScript,
    run: async (context) => {
      const scope = scriptScope(context);
      if (scope === null) return;
      const chosen = await bridge().saveFile(SAVE_TITLE, `${scope.name}${SQL_EXTENSION}`);
      if (!chosen.ok || chosen.value === null) return;
      try {
        await useCatalog.getState().ensureDescribed(scope.datasourceId, scope.path);
        await useExports.getState().start(scope.datasourceId, {
          source: { kind: "ddl", path: scope.path, kinds: scope.kinds, title: scope.title },
          format: "sql",
          path: chosen.value,
        });
      } catch (cause) {
        await reportExportFailure(cause);
      }
    },
  }),
];
