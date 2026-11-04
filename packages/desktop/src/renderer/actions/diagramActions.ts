import { DIAGRAM_COLUMN_MODES, type DiagramColumnMode } from "@table-craft/desktop/diagrams/state.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { openDdl } from "@table-craft/desktop/renderer/actions/ddlCommands.js";
import { openDiagram } from "@table-craft/desktop/renderer/actions/diagramCommands.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { openTable } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { viewportOf } from "@table-craft/desktop/renderer/diagram/viewports.js";
import { namespaceKey, objectGroupKey, pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { capabilitiesOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { diagramLayoutOf, useDiagrams, type DiagramTarget } from "@table-craft/desktop/renderer/state/diagrams.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";

export const DIAGRAM_ACTION_IDS = {
  show: "diagram.show",
  refresh: "diagram.refresh",
  fit: "diagram.fit",
  zoomIn: "diagram.zoomIn",
  zoomOut: "diagram.zoomOut",
  relayout: "diagram.relayout",
  columns: "diagram.columns",
  toggleInferred: "diagram.toggleInferred",
  tables: "diagram.tables",
  openTable: "diagram.openTable",
  goToDdl: "diagram.goToDdl",
} as const;

const DIAGRAM = "diagram";
const SCHEMA_TREE = "schemaTree";
const DDL = "ddl";

function capabilitiesOfDatasource(datasourceId: string): readonly string[] {
  const state = useDatasources.getState();
  const view = datasourceById(state, datasourceId);
  return view === undefined ? [] : capabilitiesOf(state.plugins, view.pluginId);
}

/** The schema, or its Tables node, the Database pane has selected, on a datasource that describes schemas. */
export function diagramScope(context: ActionContext): DiagramTarget | null {
  const { selection } = context;
  if (!context.inDatabasePane || selection?.kind !== "catalog" || selection.name !== null) return null;
  if (!capabilitiesOfDatasource(selection.id).includes(SCHEMA_TREE)) return null;
  const key = pathKey(selection.path);
  const namespace = useCatalog
    .getState()
    .catalogs[selection.id]?.namespaces?.find((candidate) => pathKey(candidate.path) === key);
  if (namespace?.kind !== "schema") return null;
  const keys = [namespaceKey(selection.id, namespace.path), objectGroupKey(selection.id, namespace.path, "tables")];
  return keys.includes(selection.key)
    ? { datasourceId: selection.id, path: namespace.path, namespace: namespace.name }
    : null;
}

/** A diagram table's relation: a local table by its name, a ghost by the full path its id spells. */
export function diagramRelation(
  diagram: NonNullable<ActionContext["diagram"]>,
  tableId: string,
): { readonly datasourceId: string; readonly path: readonly string[]; readonly relation: string } | null {
  const described =
    useCatalog.getState().catalogs[diagram.datasourceId]?.namespaceStates[pathKey(diagram.path)]?.described;
  if (described?.catalog.relations.some((relation) => relation.name === tableId) === true)
    return { datasourceId: diagram.datasourceId, path: diagram.path, relation: tableId };
  try {
    const parts: unknown = JSON.parse(tableId);
    if (!Array.isArray(parts) || parts.length < 2 || !parts.every((part) => typeof part === "string")) return null;
    return { datasourceId: diagram.datasourceId, path: parts.slice(0, -1), relation: parts.at(-1) ?? "" };
  } catch {
    return null;
  }
}

interface TableArgs {
  readonly table: string;
}

function isTableArgs(args: unknown): args is TableArgs {
  return typeof args === "object" && args !== null && typeof (args as { table?: unknown }).table === "string";
}

function chosenTable(context: ActionContext, args: unknown) {
  const { diagram } = context;
  if (diagram === null) return null;
  const table = isTableArgs(args) ? args.table : diagram.selected;
  return table === null ? null : diagramRelation(diagram, table);
}

function isColumnMode(value: unknown): value is DiagramColumnMode {
  return DIAGRAM_COLUMN_MODES.some((mode) => mode === value);
}

const onDiagram = (context: ActionContext) => context.diagram !== null;
const hasTable = (context: ActionContext) => chosenTable(context, undefined) !== null;

export const DIAGRAM_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: DIAGRAM_ACTION_IDS.show,
    title: "Show Diagram",
    category: "Database",
    icon: "diagram",
    shortcut: "Mod+Alt+Shift+U",
    shortcutRegion: "database",
    when: (context) => diagramScope(context) !== null,
    run: async (context) => {
      const scope = diagramScope(context);
      if (scope !== null) await openDiagram(scope);
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.refresh,
    title: "Refresh Diagram",
    category: "Database",
    icon: "synchronize",
    tabKind: DIAGRAM,
    when: (context) => context.diagram !== null && !context.diagram.loading,
    run: async (context) => {
      if (context.diagram !== null) await useDiagrams.getState().refresh(context.diagram.id);
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.fit,
    title: "Fit Diagram",
    category: "Database",
    icon: "fit",
    tabKind: DIAGRAM,
    when: onDiagram,
    run: (context) => {
      if (context.diagram !== null) viewportOf(context.diagram.id)?.fit();
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.zoomIn,
    title: "Zoom In Diagram",
    category: "Database",
    icon: "zoomIn",
    tabKind: DIAGRAM,
    when: onDiagram,
    run: (context) => {
      if (context.diagram !== null) viewportOf(context.diagram.id)?.zoomIn();
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.zoomOut,
    title: "Zoom Out Diagram",
    category: "Database",
    icon: "zoomOut",
    tabKind: DIAGRAM,
    when: onDiagram,
    run: (context) => {
      if (context.diagram !== null) viewportOf(context.diagram.id)?.zoomOut();
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.relayout,
    title: "Re-layout Diagram",
    category: "Database",
    icon: "layout",
    tabKind: DIAGRAM,
    when: onDiagram,
    run: async (context) => {
      const { diagram } = context;
      if (diagram === null) return;
      const layout = diagramLayoutOf(useDiagrams.getState(), diagram);
      if (layout !== undefined && Object.keys(layout.positions).length > 0) {
        const confirmed = await useModal.getState().ask({
          kind: "confirm",
          title: "Re-layout Diagram",
          message: `Every table of ${diagram.namespace} goes back where the automatic layout puts it; the positions you dragged are discarded.`,
          confirm: "Re-layout",
        });
        if (confirmed === null) return;
      }
      useDiagrams.getState().relayout(diagram.id);
    },
  }),
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.columns,
    title: "Diagram Columns…",
    category: "Database",
    tabKind: DIAGRAM,
    when: onDiagram,
    run: (context, args) => {
      const { diagram } = context;
      if (diagram === null) return;
      const chosen = typeof args === "object" && args !== null ? (args as { mode?: unknown }).mode : undefined;
      useDiagrams.getState().updateLayout(diagram.id, (layout) => {
        const next =
          DIAGRAM_COLUMN_MODES[(DIAGRAM_COLUMN_MODES.indexOf(layout.columns) + 1) % DIAGRAM_COLUMN_MODES.length];
        return { ...layout, columns: isColumnMode(chosen) ? chosen : (next ?? layout.columns) };
      });
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.toggleInferred,
    title: "Show Inferred Keys",
    category: "Database",
    icon: "inferredKeys",
    tabKind: DIAGRAM,
    when: onDiagram,
    run: (context) => {
      const { diagram } = context;
      if (diagram === null) return;
      useDiagrams.getState().updateState(diagram.datasourceId, (state) => ({ ...state, inferKeys: !state.inferKeys }));
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.tables,
    title: "Diagram Tables…",
    category: "Database",
    icon: "tables",
    tabKind: DIAGRAM,
    when: onDiagram,
    run: (context) => {
      const { diagram } = context;
      if (diagram !== null) useDiagrams.getState().setPickerOpen(diagram.id, !diagram.pickerOpen);
    },
  }),
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.openTable,
    title: "Open Table Data",
    category: "Navigation",
    icon: "table",
    tabKind: DIAGRAM,
    when: hasTable,
    run: async (context, args) => {
      const target = chosenTable(context, args);
      if (target !== null) await openTable(target);
    },
  }),
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.goToDdl,
    title: "Go to DDL",
    category: "Navigation",
    icon: "ddl",
    tabKind: DIAGRAM,
    when: (context) =>
      context.diagram !== null &&
      hasTable(context) &&
      capabilitiesOfDatasource(context.diagram.datasourceId).includes(DDL),
    run: async (context, args) => {
      const target = chosenTable(context, args);
      if (target !== null) await openDdl(target);
    },
  }),
];
