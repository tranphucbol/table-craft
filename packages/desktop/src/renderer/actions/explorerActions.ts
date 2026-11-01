import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import type { RelationKind } from "@table-craft/desktop/engine/protocol.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { folderPaths } from "@table-craft/desktop/renderer/model/datasourceTree.js";
import { columnRevealKeys, revealKeys } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useDatasources, type TreeSelection } from "@table-craft/desktop/renderer/state/datasources.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";

/** Names a relation to reveal, as Search Everywhere's Tables tab does. */
export interface RevealArgs {
  readonly datasourceId: string;
  readonly path: readonly string[];
  readonly name: string;
  readonly kind: RelationKind;
  /** A column of the relation to select instead of the relation itself. */
  readonly column?: string;
}

const canIntrospect = (context: ActionContext) => context.datasource?.capabilities.includes("schemaTree") === true;
const browsesKeys = (context: ActionContext) => context.datasource?.capabilities.includes("keyValue") === true;

/**
 * What Synchronize reads again: the selected namespace when the selection is inside the target
 * datasource, the namespace list when the datasource itself is selected, else its current namespace.
 */
export function synchronizeTarget(context: ActionContext): readonly string[] | null {
  const id = context.datasource?.view.id;
  if (id === undefined) return null;
  const { selection } = context;
  if (selection?.kind === "catalog" && selection.id === id) return selection.path;
  if (selection?.kind === "datasource" && selection.id === id && context.focus === "database") return null;
  const current = useCatalog.getState().catalogs[id]?.namespaces?.find((namespace) => namespace.current);
  return current?.path ?? null;
}

/** The outermost row still shown once everything collapses: the top folder or the datasource. */
function collapsedSelection(selection: TreeSelection | null): TreeSelection | null {
  if (selection === null) return null;
  if (selection.kind === "folder") return { kind: "folder", path: selection.path.split("/")[0] ?? selection.path };
  const folder = useDatasources.getState().datasources.find((datasource) => datasource.id === selection.id)?.folder;
  if (folder == null) return { kind: "datasource", id: selection.id };
  return { kind: "folder", path: folder.split("/")[0] ?? folder };
}

function isRevealArgs(args: unknown): args is RevealArgs {
  return typeof args === "object" && args !== null && "datasourceId" in args && "path" in args && "name" in args;
}

/**
 * Opens the Database pane, expands down to `target` and selects and focuses it; without a target,
 * selects the context's datasource. Go to Declaration lands here too (plan 009 decision 14).
 */
export function revealInDatabase(context: ActionContext, target: RevealArgs | null): void {
  if (!context.toolWindows.database) useLayout.getState().toggle("database");
  if (target !== null) {
    const relation = { name: target.name, kind: target.kind };
    const keys =
      target.column === undefined
        ? revealKeys(target.datasourceId, target.path, relation)
        : columnRevealKeys(target.datasourceId, target.path, relation, target.column);
    useCatalog.getState().expandAll(keys.slice(0, -1));
    useDatasources.getState().select({
      kind: "catalog",
      id: target.datasourceId,
      key: keys[keys.length - 1] ?? "",
      path: target.path,
      name: target.name,
    });
  } else if (context.datasource !== null) {
    useDatasources.getState().select({ kind: "datasource", id: context.datasource.view.id });
  }
  useCatalog.getState().requestFocus();
}

export const EXPLORER_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: ACTION_IDS.synchronize,
    title: "Synchronize",
    category: "Database",
    icon: "synchronize",
    shortcut: "Mod+Alt+Y",
    when: (context) => canIntrospect(context) || browsesKeys(context),
    run: async (context) => {
      if (context.datasource === null) return;
      if (browsesKeys(context)) {
        await useKeys.getState().synchronize(context.datasource.view.id);
        return;
      }
      await useCatalog.getState().synchronize(context.datasource.view.id, synchronizeTarget(context));
    },
  }),
  defineAction({
    id: ACTION_IDS.collapseAll,
    title: "Collapse All",
    category: "Database",
    icon: "collapseAll",
    shortcut: "Mod+-",
    shortcutRegion: "database",
    run: (context) => {
      const { datasources, folders } = useDatasources.getState();
      useCatalog.getState().collapseAll(folderPaths(datasources, folders));
      useDatasources.getState().select(collapsedSelection(context.selection));
    },
  }),
  defineAction({
    id: ACTION_IDS.toggleSystemSchemas,
    title: "Show System Schemas",
    category: "Database",
    run: () => useLayout.getState().toggleSystemSchemas(),
  }),
  defineAction({
    id: ACTION_IDS.copyName,
    title: "Copy Qualified Name",
    category: "Database",
    icon: "copy",
    shortcut: "Mod+Alt+Shift+C",
    shortcutRegion: "database",
    when: (context) =>
      context.selection?.kind === "catalog" &&
      context.selection.name !== null &&
      context.datasource?.connection.status === "connected",
    run: async (context) => {
      const { selection } = context;
      if (selection?.kind !== "catalog" || selection.name === null) return;
      if (browsesKeys(context)) {
        await writeClipboard(selection.name);
        return;
      }
      const client = await useDatasources.getState().connect(selection.id);
      await writeClipboard(await client.call("catalog.qualifiedName", { path: selection.path, name: selection.name }));
    },
  }),
  defineAction<RevealArgs | undefined>({
    id: ACTION_IDS.reveal,
    title: "Select in Database View",
    category: "Database",
    when: (context) => context.datasource !== null,
    run: (context, args) => revealInDatabase(context, isRevealArgs(args) ? args : null),
  }),
];
