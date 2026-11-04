import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DEFAULT_DIAGRAM_STATE, type DiagramPosition } from "@table-craft/desktop/diagrams/state.js";
import { DIAGRAM_ACTION_IDS } from "@table-craft/desktop/renderer/actions/diagramActions.js";
import { invoke, registry, subscribeToActions, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { useShortcut } from "@table-craft/desktop/renderer/actions/shortcuts.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import "@table-craft/desktop/renderer/diagram/diagram.css";
import { DiagramToolbar } from "@table-craft/desktop/renderer/diagram/DiagramToolbar.js";
import { layOut } from "@table-craft/desktop/renderer/diagram/elkWorker.js";
import { KeyEdge, type KeyFlowEdge } from "@table-craft/desktop/renderer/diagram/KeyEdge.js";
import { useDiagramMetrics } from "@table-craft/desktop/renderer/diagram/metrics.js";
import { TableNode, type TableFlowNode } from "@table-craft/desktop/renderer/diagram/TableNode.js";
import { registerViewport } from "@table-craft/desktop/renderer/diagram/viewports.js";
import {
  diagramGraph,
  EDGE_ORIGINS,
  hiddenKeysOf,
  edgeLabel,
  shownGraph,
  type EdgeOrigin,
} from "@table-craft/desktop/renderer/model/diagram.js";
import {
  elkGraph,
  placeNew,
  positionsOf,
  tableSizes,
  type Positions,
} from "@table-craft/desktop/renderer/model/diagramLayout.js";
import { pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useDiagrams } from "@table-craft/desktop/renderer/state/diagrams.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { MENU_ITEM, MENU_SEPARATOR, MENU_SHORTCUT, WIDE_MENU_CONTENT } from "@table-craft/desktop/renderer/ui/menu.js";
import { tintFrame } from "@table-craft/desktop/renderer/ui/tint.js";

const NODE_TYPES = { table: TableNode };
const EDGE_TYPES = { key: KeyEdge };
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 2;
const ZOOM_DURATION_MS = 150;
const FIT_PADDING = 0.1;
const DOT_GAP_PX = 20;

/** What a right click landed on, which picks the menu. */
type MenuTarget = { readonly kind: "table" } | { readonly kind: "edge" } | { readonly kind: "pane" };

const TABLE_MENU: readonly (string | null)[] = [
  DIAGRAM_ACTION_IDS.openTable,
  DIAGRAM_ACTION_IDS.goToDdl,
  null,
  DIAGRAM_ACTION_IDS.addRelationshipFrom,
  DIAGRAM_ACTION_IDS.hideTable,
];
/** Only what applies to the edge shows: an inferred key hides or is kept, a virtual one is deleted. */
const EDGE_MENU: readonly (string | null)[] = [
  DIAGRAM_ACTION_IDS.hideKey,
  DIAGRAM_ACTION_IDS.keepKey,
  DIAGRAM_ACTION_IDS.deleteRelationship,
];
const PANE_MENU: readonly (string | null)[] = [
  DIAGRAM_ACTION_IDS.fit,
  DIAGRAM_ACTION_IDS.relayout,
  null,
  DIAGRAM_ACTION_IDS.toggleInferred,
  DIAGRAM_ACTION_IDS.tables,
  DIAGRAM_ACTION_IDS.hiddenKeys,
  null,
  DIAGRAM_ACTION_IDS.addRelationship,
];

function MenuItem({ actionId }: { readonly actionId: string }) {
  const enabled = useActionEnabled(actionId);
  const shortcut = useShortcut(actionId);
  const action = registry.get(actionId);
  if (action === undefined) return null;
  return (
    <ContextMenu.Item disabled={!enabled} className={MENU_ITEM} onSelect={() => invoke(actionId)}>
      <span>{action.title}</span>
      {shortcut === undefined ? null : <span className={MENU_SHORTCUT}>{shortcut}</span>}
    </ContextMenu.Item>
  );
}

function MenuItems({
  items,
  enabledOnly = false,
}: {
  readonly items: readonly (string | null)[];
  readonly enabledOnly?: boolean;
}) {
  useSyncExternalStore(subscribeToActions, () => items.map((id) => (id === null ? "" : registry.isEnabled(id))).join());
  const shown = enabledOnly ? items.filter((id) => id === null || registry.isEnabled(id)) : items;
  if (!shown.some((id) => id !== null))
    return (
      <ContextMenu.Item disabled className={MENU_ITEM}>
        Declared by the database
      </ContextMenu.Item>
    );
  return shown.map((id, index) =>
    id === null ? (
      <ContextMenu.Separator key={`separator-${String(index)}`} className={MENU_SEPARATOR} />
    ) : (
      <MenuItem key={id} actionId={id} />
    ),
  );
}

/** A namespace's ER diagram (plan 152): the tab, its toolbar and the canvas. */
export function DiagramView({ diagramId }: { readonly diagramId: string }) {
  const exists = useDiagrams((state) => state.tabs[diagramId] !== undefined);
  if (!exists) return null;
  return (
    <ReactFlowProvider>
      <DiagramCanvas diagramId={diagramId} />
    </ReactFlowProvider>
  );
}

function pick(positions: Positions, ids: ReadonlySet<string>): Positions {
  return Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id)));
}

function DiagramCanvas({ diagramId }: { readonly diagramId: string }) {
  const tab = useDiagrams((state) => state.tabs[diagramId]);
  const datasourceId = tab?.datasourceId ?? "";
  const key = pathKey(tab?.path ?? []);
  const loadedState = useDiagrams((all) => all.states[datasourceId]);
  const state = loadedState ?? DEFAULT_DIAGRAM_STATE;
  const failure = useDiagrams((all) => all.failures[datasourceId]) ?? null;
  const layout = state.layouts[key];
  const relayouts = useDiagrams((all) => all.relayouts[diagramId] ?? 0);
  const namespace = useCatalog((catalog) => catalog.catalogs[datasourceId]?.namespaceStates[key]);
  const datasource = useConsoleDatasource(diagramId);
  const metrics = useDiagramMetrics();
  const flow = useReactFlow();
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuTarget>({ kind: "pane" });
  const [dragged, setDragged] = useState<Positions>({});

  const described = namespace?.described ?? null;
  const inferred = tab?.inferred ?? null;
  const ready = described !== null && inferred !== null && loadedState !== undefined;
  const graph = useMemo(
    () =>
      !ready || described === null || inferred === null ? null : diagramGraph({ catalog: described, inferred, state }),
    [ready, described, inferred, state],
  );
  const keys = useMemo(
    () => (!ready || described === null || inferred === null ? null : hiddenKeysOf(described, inferred, state)),
    [ready, described, inferred, state],
  );
  const localIds = useMemo(
    () => graph?.tables.filter((table) => table.kind !== "external").map((table) => table.id) ?? null,
    [graph],
  );
  useEffect(() => {
    if (localIds !== null) useDiagrams.getState().ensureLayout(diagramId, localIds);
  }, [diagramId, localIds]);

  const mode = layout?.columns ?? "all";
  const shown = useMemo(
    () => (graph === null || layout === undefined ? null : shownGraph(graph, layout.hiddenTables)),
    [graph, layout],
  );
  const sizes = useMemo(() => tableSizes(shown?.tables ?? [], mode, metrics), [shown, mode, metrics]);
  const positions = useMemo(() => layout?.positions ?? {}, [layout]);

  const request = useMemo(() => {
    if (shown === null || graph === null) return null;
    const fresh = new Set(shown.tables.filter((table) => !(table.id in positions)).map((table) => table.id));
    if (fresh.size === 0) return null;
    const sub = {
      tables: shown.tables.filter((table) => fresh.has(table.id)),
      edges: shown.edges.filter((edge) => fresh.has(edge.source) && fresh.has(edge.target)),
    };
    return {
      elk: elkGraph(sub, sizes, mode, metrics.rowHeight),
      graphIds: new Set(graph.tables.map((table) => table.id)),
      shownIds: new Set(shown.tables.map((table) => table.id)),
      fitAfter: fresh.size === shown.tables.length,
      sizes,
      relayouts,
    };
  }, [shown, graph, positions, sizes, mode, metrics.rowHeight, relayouts]);

  useEffect(() => {
    if (request === null) return;
    let live = true;
    layOut(diagramId, request.elk)
      .then((laidOut) => {
        if (!live || laidOut === null) return;
        setLayoutError(null);
        useDiagrams.getState().updateLayout(diagramId, (current) => {
          const kept = pick(current.positions, request.graphIds);
          const placed = placeNew(pick(kept, request.shownIds), positionsOf(laidOut), request.sizes);
          return { ...current, positions: { ...kept, ...placed } };
        });
        if (request.fitAfter) requestAnimationFrame(() => void flow.fitView({ padding: FIT_PADDING }));
      })
      .catch((cause: unknown) => {
        if (live) setLayoutError(toError(cause).message);
      });
    return () => {
      live = false;
    };
  }, [diagramId, request, flow]);

  useEffect(
    () =>
      registerViewport(diagramId, {
        fit: () => void flow.fitView({ padding: FIT_PADDING, duration: ZOOM_DURATION_MS }),
        zoomIn: () => void flow.zoomIn({ duration: ZOOM_DURATION_MS }),
        zoomOut: () => void flow.zoomOut({ duration: ZOOM_DURATION_MS }),
      }),
    [diagramId, flow],
  );

  const selected = tab?.selected ?? null;
  const nodes = useMemo((): TableFlowNode[] => {
    if (shown === null) return [];
    return shown.tables.flatMap((table) => {
      const at: DiagramPosition | undefined = dragged[table.id] ?? positions[table.id];
      const size = sizes.get(table.id);
      if (at === undefined || size === undefined) return [];
      return [
        {
          id: table.id,
          type: "table",
          position: at,
          width: size.width,
          height: size.height,
          data: { table, mode, selected: table.id === selected },
        },
      ];
    });
  }, [shown, dragged, positions, sizes, mode, selected]);
  const edges = useMemo((): KeyFlowEdge[] => {
    if (shown === null) return [];
    return shown.edges.map((edge) => ({
      id: edge.id,
      type: "key",
      source: edge.source,
      target: edge.target,
      data: {
        edge,
        mode,
        rowHeight: metrics.rowHeight,
        label: edgeLabel(edge, shown.tables),
        selected: selected !== null && (edge.source === selected || edge.target === selected),
      },
    }));
  }, [shown, mode, metrics.rowHeight, selected]);

  const onNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
    const moved = changes.flatMap((change) =>
      change.type === "position" && change.position !== undefined ? [[change.id, change.position] as const] : [],
    );
    if (moved.length > 0) setDragged((current) => ({ ...current, ...Object.fromEntries(moved) }));
  }, []);
  const onNodeDragStop = useCallback(
    (_event: unknown, _node: TableFlowNode, movedNodes: readonly TableFlowNode[]) => {
      const moved = Object.fromEntries(
        movedNodes.map((node) => [node.id, { x: Math.round(node.position.x), y: Math.round(node.position.y) }]),
      );
      useDiagrams.getState().updateLayout(diagramId, (current) => ({
        ...current,
        positions: { ...current.positions, ...moved },
      }));
      setDragged({});
    },
    [diagramId],
  );

  if (tab === undefined) return null;
  const color = datasource?.color ?? null;
  const error = tab.error ?? namespace?.error ?? null;
  const localCount = localIds?.length ?? 0;
  const shownLocal = shown?.tables.filter((table) => table.kind !== "external").length ?? 0;
  const counts = shown === null ? null : countByOrigin(shown.edges);
  const status = !ready
    ? "Reading the schema…"
    : request !== null
      ? "Laying out…"
      : `${String(shownLocal)} of ${plural(localCount, "table")} · ${counts ?? ""}`;
  const empty =
    graph !== null && localCount === 0
      ? `${tab.namespace} has no tables.`
      : shown !== null && shownLocal === 0
        ? "No table shown. Choose tables to draw from Tables."
        : null;
  return (
    <div
      data-testid="diagram-view"
      data-color={color ?? undefined}
      className={cn("flex min-h-0 flex-1 flex-col", tintFrame(color))}
    >
      <DiagramToolbar
        diagramId={diagramId}
        mode={mode}
        inferKeys={state.inferKeys}
        pickerOpen={tab.pickerOpen}
        tables={graph?.tables.filter((table) => table.kind !== "external") ?? []}
        hidden={layout?.hiddenTables ?? []}
        hiddenKeysOpen={tab.hiddenKeysOpen}
        hiddenKeys={keys?.hidden ?? []}
        missingKeys={keys?.missing ?? []}
        status={status}
      />
      {[error, failure, layoutError === null ? null : { message: layoutError, hint: "" }].map((shown, index) =>
        shown === null ? null : (
          <div key={index} role="alert" className="border-b border-line bg-panel px-gap py-1 break-words text-danger">
            {shown.message}
            {shown.hint === "" ? null : <span className="text-ink-muted"> {shown.hint}</span>}
          </div>
        ),
      )}
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="tc-diagram relative min-h-0 flex-1" data-testid="diagram-canvas">
            <ReactFlow<TableFlowNode, KeyFlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={(_event, node) => useDiagrams.getState().select(diagramId, node.id)}
              onNodeDoubleClick={(_event, node) => {
                useDiagrams.getState().select(diagramId, node.id);
                invoke(DIAGRAM_ACTION_IDS.openTable, { table: node.id });
              }}
              onNodeContextMenu={(_event, node) => {
                useDiagrams.getState().select(diagramId, node.id);
                setMenu({ kind: "table" });
              }}
              onEdgeContextMenu={(_event, edge) => {
                useDiagrams.getState().selectEdge(diagramId, edge.id);
                setMenu({ kind: "edge" });
              }}
              onPaneClick={() => useDiagrams.getState().select(diagramId, null)}
              onPaneContextMenu={() => setMenu({ kind: "pane" })}
              onMoveEnd={(_event, viewport) => useDiagrams.getState().setViewport(diagramId, viewport)}
              {...(tab.viewport === null
                ? { fitView: true, fitViewOptions: { padding: FIT_PADDING } }
                : { defaultViewport: tab.viewport })}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              onlyRenderVisibleElements
              nodesConnectable={false}
              elementsSelectable={false}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={DOT_GAP_PX} />
            </ReactFlow>
            {empty === null ? null : (
              <div
                data-testid="diagram-empty"
                className="pointer-events-none absolute inset-0 flex items-center justify-center text-ink-muted"
              >
                {empty}
              </div>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={WIDE_MENU_CONTENT}>
            <MenuItems
              items={menu.kind === "table" ? TABLE_MENU : menu.kind === "edge" ? EDGE_MENU : PANE_MENU}
              enabledOnly={menu.kind === "edge"}
            />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function countByOrigin(edges: readonly { readonly origin: EdgeOrigin }[]): string {
  if (edges.length === 0) return "no keys";
  const parts = EDGE_ORIGINS.flatMap((origin) => {
    const count = edges.filter((edge) => edge.origin === origin).length;
    return count === 0 ? [] : [`${String(count)} ${origin}`];
  });
  return `${plural(edges.length, "key")}: ${parts.join(", ")}`;
}
