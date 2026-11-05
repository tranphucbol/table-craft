import { DIAGRAM_COLUMN_MODES, type DiagramColumnMode } from "@table-craft/desktop/diagrams/state.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { openDdl } from "@table-craft/desktop/renderer/actions/ddlCommands.js";
import { openDiagram } from "@table-craft/desktop/renderer/actions/diagramCommands.js";
import { canExportDiagram, exportDiagram } from "@table-craft/desktop/renderer/actions/diagramExport.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { openTable } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { viewportOf } from "@table-craft/desktop/renderer/diagram/viewports.js";
import {
  relationshipProblem,
  virtualKeyFor,
  withHiddenKey,
  withoutVirtualKey,
  withRestoredKeys,
  withVirtualKey,
  type DiagramEdge,
  type EdgeOrigin,
} from "@table-craft/desktop/renderer/model/diagram.js";
import { namespaceKey, objectGroupKey, pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { capabilitiesOf, datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import {
  diagramGraphOf,
  diagramLayoutOf,
  useDiagrams,
  type DiagramTarget,
} from "@table-craft/desktop/renderer/state/diagrams.js";
import {
  parseRelationshipAnswer,
  useModal,
  type RelationshipTable,
} from "@table-craft/desktop/renderer/state/modal.js";

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
  hideKey: "diagram.hideKey",
  keepKey: "diagram.keepKey",
  hiddenKeys: "diagram.hiddenKeys",
  restoreKeys: "diagram.restoreKeys",
  addRelationship: "diagram.addRelationship",
  addRelationshipFrom: "diagram.addRelationshipFrom",
  deleteRelationship: "diagram.deleteRelationship",
  hideTable: "diagram.hideTable",
  exportSvg: "diagram.exportSvg",
  exportPng: "diagram.exportPng",
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

type Diagram = NonNullable<ActionContext["diagram"]>;

function stringArg(args: unknown, name: string): string | undefined {
  const value = typeof args === "object" && args !== null ? (args as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** The edge an edge action acts on: `{ edge }` from the caller, else the one last right-clicked. */
function chosenEdge(context: ActionContext, args: unknown, origin: EdgeOrigin): DiagramEdge | null {
  const { diagram } = context;
  if (diagram === null) return null;
  const id = stringArg(args, "edge") ?? diagram.edge;
  if (id === null) return null;
  const edge = diagramGraphOf(useDiagrams.getState(), diagram)?.edges.find((candidate) => candidate.id === id);
  return edge?.origin === origin ? edge : null;
}

/** The namespace's own tables, which Add Relationship joins. */
function relationshipTables(diagram: Diagram): readonly RelationshipTable[] {
  const graph = diagramGraphOf(useDiagrams.getState(), diagram);
  const relations = new Map(
    useCatalog
      .getState()
      .catalogs[diagram.datasourceId]?.namespaceStates[pathKey(diagram.path)]?.described?.catalog.relations.map(
        (relation) => [relation.name, relation],
      ) ?? [],
  );
  return (graph?.tables ?? []).flatMap((table) => {
    if (table.kind === "external") return [];
    return [
      {
        name: table.name,
        columns: table.columns.map((column) => column.name),
        primaryKey: relations.get(table.relation)?.primaryKey?.columns ?? [],
      },
    ];
  });
}

async function addRelationship(diagram: Diagram, from: string | null): Promise<void> {
  const tables = relationshipTables(diagram);
  const answer = await useModal.getState().ask({
    kind: "relationship",
    title: from === null ? "Add Relationship" : `Add Relationship From ${from}`,
    tables,
    from,
  });
  if (answer === null) return;
  const chosen = parseRelationshipAnswer(answer);
  if (relationshipProblem(chosen) !== null) return;
  const key = virtualKeyFor(diagram.path, {
    from: { relation: chosen.from, columns: chosen.columns },
    to: { path: diagram.path, relation: chosen.to, columns: chosen.targetColumns },
  });
  useDiagrams.getState().updateState(diagram.datasourceId, (state) => withVirtualKey(state, key));
}

function hiddenInNamespace(diagram: Diagram): boolean {
  const state = useDiagrams.getState().states[diagram.datasourceId];
  if (state === undefined) return false;
  const prefix = `${JSON.stringify([diagram.path]).slice(0, -1)},`;
  return state.hiddenKeys.some((id) => id.startsWith(prefix));
}

function savedVirtualKey(context: ActionContext, args: unknown): string | null {
  const { diagram } = context;
  if (diagram === null) return null;
  const named = stringArg(args, "key");
  if (named !== undefined)
    return useDiagrams.getState().states[diagram.datasourceId]?.virtualKeys.some((key) => key.id === named) === true
      ? named
      : null;
  return chosenEdge(context, args, "virtual")?.keyId ?? null;
}

/** Only a datasource with a schema tree draws diagrams, so the palette lists none for the others. */
function drawsDiagrams(context: ActionContext): boolean {
  return context.datasource === null || context.datasource.capabilities.includes(SCHEMA_TREE);
}

const ACTIONS: readonly AnyAction[] = [
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
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.hideKey,
    title: "Hide Inferred Key",
    category: "Database",
    icon: "hide",
    tabKind: DIAGRAM,
    when: (context) => chosenEdge(context, undefined, "inferred") !== null,
    run: (context, args) => {
      const { diagram } = context;
      const edge = chosenEdge(context, args, "inferred");
      if (diagram === null || edge === null) return;
      useDiagrams
        .getState()
        .updateState(diagram.datasourceId, (state) => withHiddenKey(state, diagram.path, edge.keyId));
    },
  }),
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.keepKey,
    title: "Keep as Virtual Key",
    category: "Database",
    icon: "pin",
    tabKind: DIAGRAM,
    when: (context) => chosenEdge(context, undefined, "inferred") !== null,
    run: (context, args) => {
      const { diagram } = context;
      const edge = chosenEdge(context, args, "inferred");
      if (diagram === null || edge === null) return;
      const key = virtualKeyFor(diagram.path, edge);
      useDiagrams.getState().updateState(diagram.datasourceId, (state) => withVirtualKey(state, key));
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.hiddenKeys,
    title: "Hidden Keys…",
    category: "Database",
    icon: "hide",
    tabKind: DIAGRAM,
    when: onDiagram,
    run: (context) => {
      const { diagram } = context;
      if (diagram !== null) useDiagrams.getState().setHiddenKeysOpen(diagram.id, !diagram.hiddenKeysOpen);
    },
  }),
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.restoreKeys,
    title: "Restore Hidden Keys",
    category: "Database",
    icon: "revert",
    tabKind: DIAGRAM,
    when: (context) => context.diagram !== null && hiddenInNamespace(context.diagram),
    run: (context, args) => {
      const { diagram } = context;
      if (diagram === null) return;
      const named = typeof args === "object" && args !== null ? (args as { keys?: unknown }).keys : undefined;
      const prefix = `${JSON.stringify([diagram.path]).slice(0, -1)},`;
      const ids = Array.isArray(named)
        ? named.filter((id): id is string => typeof id === "string")
        : (useDiagrams.getState().states[diagram.datasourceId]?.hiddenKeys ?? []).filter((id) => id.startsWith(prefix));
      useDiagrams.getState().updateState(diagram.datasourceId, (state) => withRestoredKeys(state, ids));
    },
  }),
  defineAction({
    id: DIAGRAM_ACTION_IDS.addRelationship,
    title: "Add Relationship…",
    category: "Database",
    icon: "add",
    tabKind: DIAGRAM,
    when: (context) => context.diagram !== null && relationshipTables(context.diagram).length > 0,
    run: async (context) => {
      if (context.diagram !== null) await addRelationship(context.diagram, null);
    },
  }),
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.addRelationshipFrom,
    title: "Add Relationship From Here…",
    category: "Database",
    icon: "add",
    tabKind: DIAGRAM,
    inPalette: false,
    when: (context) => {
      const target = chosenTable(context, undefined);
      return target !== null && context.diagram !== null && pathKey(target.path) === pathKey(context.diagram.path);
    },
    run: async (context, args) => {
      const { diagram } = context;
      const target = chosenTable(context, args);
      if (diagram === null || target === null || pathKey(target.path) !== pathKey(diagram.path)) return;
      await addRelationship(diagram, target.relation);
    },
  }),
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.deleteRelationship,
    title: "Delete Virtual Key",
    category: "Database",
    icon: "delete",
    tabKind: DIAGRAM,
    when: (context) => savedVirtualKey(context, undefined) !== null,
    run: (context, args) => {
      const { diagram } = context;
      const id = savedVirtualKey(context, args);
      if (diagram === null || id === null) return;
      useDiagrams.getState().updateState(diagram.datasourceId, (state) => withoutVirtualKey(state, id));
    },
  }),
  defineAction<unknown>({
    id: DIAGRAM_ACTION_IDS.hideTable,
    title: "Hide Table",
    category: "Database",
    icon: "hide",
    tabKind: DIAGRAM,
    inPalette: false,
    when: hasTable,
    run: (context, args) => {
      const { diagram } = context;
      const table = stringArg(args, "table") ?? diagram?.selected ?? null;
      if (diagram === null || table === null) return;
      useDiagrams
        .getState()
        .updateLayout(diagram.id, (layout) =>
          layout.hiddenTables.includes(table) ? layout : { ...layout, hiddenTables: [...layout.hiddenTables, table] },
        );
      useDiagrams.getState().select(diagram.id, null);
    },
  }),
  ...(["svg", "png"] as const).map((format) =>
    defineAction({
      id: format === "svg" ? DIAGRAM_ACTION_IDS.exportSvg : DIAGRAM_ACTION_IDS.exportPng,
      title: format === "svg" ? "Export Diagram as SVG…" : "Export Diagram as PNG…",
      category: "Database",
      icon: format === "svg" ? "exportSvg" : "exportPng",
      tabKind: DIAGRAM,
      when: (context) => context.diagram !== null && canExportDiagram(context.diagram),
      run: async ({ diagram }) => {
        if (diagram !== null) await exportDiagram(diagram, format);
      },
    }),
  ),
];

export const DIAGRAM_ACTIONS: readonly AnyAction[] = ACTIONS.map((action) => ({ ...action, available: drawsDiagrams }));
