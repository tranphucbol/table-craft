import { EditorView } from "@codemirror/view";
import type { Capability, CurrentNamespace, Declaration, RelationKind } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { openDdl } from "@table-craft/desktop/renderer/actions/ddlCommands.js";
import { revealInDatabase } from "@table-craft/desktop/renderer/actions/explorerActions.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { openTable } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { editorOf } from "@table-craft/desktop/renderer/console/caretAnchor.js";
import { requestParameterInfo } from "@table-craft/desktop/renderer/console/signatureHint.js";
import { pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

export const NAVIGATION_ACTION_IDS = {
  goToDeclaration: "editor.goToDeclaration",
  openData: "editor.openData",
  parameterInfo: "editor.parameterInfo",
} as const;

const CODE_EDITOR_SELECTOR = ".cm-editor";

/** The SQL field Parameter Info asks in: the focused one, else the active console's editor. */
function parameterInfoTarget(context: ActionContext): EditorView | null {
  const focused = document.activeElement?.closest(CODE_EDITOR_SELECTOR);
  const view = focused instanceof HTMLElement ? EditorView.findFromDOM(focused) : null;
  if (view !== null) return view;
  return context.activeTab?.kind === "console" ? editorOf(context.activeTab.id) : null;
}

/** A relation Go to Declaration or Open Data lands on. */
type RelationDeclaration = Extract<Declaration, { kind: "relation" | "column" }>;

export interface Caret {
  readonly consoleId: string;
  readonly datasourceId: string;
  readonly text: string;
  readonly offset: number;
  /** The console's namespace, which unqualified names resolve against (decision 048). */
  readonly namespace: CurrentNamespace;
}

export function caretOf(context: ActionContext): Caret | null {
  if (context.activeTab?.kind !== "console" || context.console === null) return null;
  return {
    consoleId: context.activeTab.id,
    datasourceId: context.console.datasourceId,
    text: context.console.sql,
    offset: context.console.selection.from,
    namespace: context.console.namespace,
  };
}

const inConsole = (context: ActionContext) => caretOf(context) !== null && context.capabilities.includes("sql");

/** What the name at `offset` declares, asked of the engine; an explicit command may connect. */
export async function resolve(caret: Caret, offset = caret.offset): Promise<Declaration | null> {
  const client = await useDatasources.getState().connect(caret.datasourceId);
  return client.call("navigation.resolve", {
    text: caret.text,
    offset,
    ...(caret.namespace === null ? {} : { current: caret.namespace }),
  });
}

/** The relation an alias stands for: what is declared at the alias declaration's start. */
export async function relationOf(caret: Caret, declaration: Declaration | null): Promise<RelationDeclaration | null> {
  if (declaration === null) return null;
  if (!("from" in declaration)) return declaration;
  if (declaration.kind === "cte") return null;
  const aliased = await resolve(caret, declaration.from);
  return aliased?.kind === "relation" ? aliased : null;
}

/** Where Go to Declaration lands (plan 010 decision 9). */
export type DeclarationTarget = "jump" | "ddl" | "reveal";

/**
 * An alias or CTE jumps to where the console declares it; a relation opens its DDL when the
 * plugin can read definitions, else it is revealed, as a column always is.
 */
export function declarationTarget(declaration: Declaration, capabilities: readonly Capability[]): DeclarationTarget {
  if ("from" in declaration) return "jump";
  return declaration.kind === "relation" && capabilities.includes("ddl") ? "ddl" : "reveal";
}

/**
 * The relation's kind from the renderer's catalog, listing and describing its namespace first,
 * as expanding it by hand would, so the reveal has rows to land on.
 */
async function relationKind(datasourceId: string, path: readonly string[], name: string): Promise<RelationKind> {
  const catalog = useCatalog.getState();
  await catalog.expandDatasource(datasourceId);
  const namespaces = useCatalog.getState().catalogs[datasourceId]?.namespaces ?? [];
  for (let length = 1; length <= path.length; length += 1) {
    const key = pathKey(path.slice(0, length));
    const namespace = namespaces.find((candidate) => pathKey(candidate.path) === key);
    if (namespace !== undefined) await useCatalog.getState().expandNamespace(datasourceId, namespace);
  }
  const described = useCatalog.getState().catalogs[datasourceId]?.namespaceStates[pathKey(path)]?.described;
  return described?.catalog.relations.find((relation) => relation.name === name)?.kind ?? "table";
}

export const NAVIGATION_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: NAVIGATION_ACTION_IDS.goToDeclaration,
    title: "Go to Declaration",
    category: "Navigation",
    icon: "goTo",
    shortcut: "Mod+B",
    shortcutRegion: "editor",
    tabKind: "console",
    when: inConsole,
    run: async (context) => {
      const caret = caretOf(context);
      if (caret === null) return;
      const declaration = await resolve(caret);
      if (declaration === null) return;
      if ("from" in declaration) {
        useConsoles.getState().jumpTo(caret.consoleId, { from: declaration.from, to: declaration.to });
        return;
      }
      if (declarationTarget(declaration, context.capabilities) === "ddl") {
        await openDdl({ datasourceId: caret.datasourceId, path: declaration.path, relation: declaration.relation });
        return;
      }
      const kind = await relationKind(caret.datasourceId, declaration.path, declaration.relation);
      revealInDatabase(context, {
        datasourceId: caret.datasourceId,
        path: declaration.path,
        name: declaration.relation,
        kind,
        ...(declaration.kind === "column" ? { column: declaration.column } : {}),
      });
    },
  }),
  defineAction({
    id: NAVIGATION_ACTION_IDS.openData,
    title: "Open Data",
    category: "Navigation",
    icon: "table",
    shortcut: "F4",
    shortcutRegion: "editor",
    tabKind: "console",
    when: inConsole,
    run: async (context) => {
      const caret = caretOf(context);
      if (caret === null) return;
      const target = await relationOf(caret, await resolve(caret));
      if (target === null) return;
      await openTable({ datasourceId: caret.datasourceId, path: target.path, relation: target.relation });
    },
  }),
  defineAction({
    id: NAVIGATION_ACTION_IDS.parameterInfo,
    title: "Parameter Info",
    category: "Editor",
    icon: "quickDoc",
    shortcut: "Mod+P",
    shortcutRegion: ["editor", "tableEditor"],
    when: (context) =>
      context.capabilities.includes("sql") &&
      (context.activeTab?.kind === "console" || context.activeTab?.kind === "table"),
    run: (context) => {
      const view = parameterInfoTarget(context);
      if (view === null) return;
      view.focus();
      requestParameterInfo(view);
    },
  }),
];
