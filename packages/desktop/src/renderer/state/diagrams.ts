import { create } from "zustand";
import { DEFAULT_DIAGRAM_STATE, type DiagramState, type NamespaceLayout } from "@table-craft/desktop/diagrams/state.js";
import type { DescribedCatalog, EngineError, InferredKey } from "@table-craft/desktop/engine/protocol.js";
import type { BridgeFailure, InvokeResult } from "@table-craft/desktop/preload/bridge.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { diagramGraph, openingLayout, type DiagramGraph } from "@table-craft/desktop/renderer/model/diagram.js";
import { pathKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useCatalog, type CatalogStore } from "@table-craft/desktop/renderer/state/catalog.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

/** Which namespace a diagram tab draws (plan 152 decision 1). */
export interface DiagramTarget {
  readonly datasourceId: string;
  readonly path: readonly string[];
  /** The namespace's name, which titles the tab and names an export. */
  readonly namespace: string;
}

export interface DiagramTab extends DiagramTarget {
  /** The engine's inferred keys, `null` until the first answer. */
  readonly inferred: readonly InferredKey[] | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
  readonly pickerOpen: boolean;
  readonly hiddenKeysOpen: boolean;
  readonly selected: string | null;
  /** The edge last right-clicked, which its menu's actions act on. */
  readonly edge: string | null;
  /** Where the canvas was panned and zoomed when the tab was last left; `null` fits the diagram. */
  readonly viewport: DiagramViewport | null;
}

export interface DiagramViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface DiagramsState {
  /** By tab id. */
  readonly tabs: Readonly<Record<string, DiagramTab>>;
  /** By datasource id: what the user chose, shared by every diagram of that datasource; absent until read from main. */
  readonly states: Readonly<Record<string, DiagramState>>;
  /** By datasource id: why the state could not be read or saved, until a save goes through. */
  readonly failures: Readonly<Record<string, BridgeFailure>>;
  readonly loadState: (datasourceId: string) => Promise<void>;
  /** Drops a deleted datasource's state; main forgets its entry in `diagrams.json` itself. */
  readonly forget: (datasourceId: string) => void;
  readonly selectEdge: (id: string, edge: string | null) => void;
  /** Bumped per tab by Re-layout, so the view lays every table out again. */
  readonly relayouts: Readonly<Record<string, number>>;
  readonly open: (id: string, target: DiagramTarget) => Promise<void>;
  /** Describes the namespace again from the database; the inferred keys follow (`followDiagramRedescribes`). */
  readonly refresh: (id: string) => Promise<void>;
  readonly reloadKeys: (id: string) => Promise<void>;
  readonly close: (id: string) => void;
  /** Gives a namespace seen for the first time its opening layout (decision 13); a saved one stays. */
  readonly ensureLayout: (id: string, tableIds: readonly string[]) => void;
  readonly updateLayout: (id: string, change: (layout: NamespaceLayout) => NamespaceLayout) => void;
  readonly updateState: (datasourceId: string, change: (state: DiagramState) => DiagramState) => void;
  readonly relayout: (id: string) => void;
  readonly setPickerOpen: (id: string, open: boolean) => void;
  readonly setHiddenKeysOpen: (id: string, open: boolean) => void;
  readonly select: (id: string, table: string | null) => void;
  readonly setViewport: (id: string, viewport: DiagramViewport) => void;
}

/** Where a datasource's diagram state is kept: main's `diagrams.json` in the app, a map in tests. */
export interface DiagramPersistence {
  readonly read: (datasourceId: string) => Promise<DiagramState>;
  readonly save: (datasourceId: string, state: DiagramState) => Promise<void>;
}

export interface DiagramsDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  readonly catalog: () => CatalogStore;
  readonly persistence: DiagramPersistence;
  /** Decision 018: an ephemeral datasource's diagrams are not kept. */
  readonly isEphemeral?: (datasourceId: string) => boolean;
}

/** Drags, hides and adds within this long are written as one save (plan 152 Phase 2). */
export const DIAGRAM_SAVE_DEBOUNCE_MS = 500;

export class DiagramsFailure extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "DiagramsFailure";
  }
}

async function unwrap<T>(pending: Promise<InvokeResult<T>>): Promise<T> {
  const answer = await pending;
  if (!answer.ok) throw new DiagramsFailure(answer.error.message, answer.error.hint);
  return answer.value;
}

export const BRIDGE_DIAGRAMS: DiagramPersistence = {
  read: (datasourceId) => unwrap(bridge().readDiagrams(datasourceId)),
  async save(datasourceId, state) {
    await unwrap(bridge().saveDiagrams(datasourceId, state));
  },
};

/** A diagram tab's id: one per datasource and namespace (decision 1). */
export function diagramTabId(datasourceId: string, path: readonly string[]): string {
  return `diagram-${datasourceId}-${pathKey(path)}`;
}

export function diagramLayoutOf(state: Pick<DiagramsState, "states">, tab: DiagramTarget): NamespaceLayout | undefined {
  return state.states[tab.datasourceId]?.layouts[pathKey(tab.path)];
}

export function createDiagramsStore(dependencies: DiagramsDependencies) {
  /** The latest keys request per tab, so an answer overtaken by a later one is dropped. */
  const reads = new Map<string, number>();
  let readCount = 0;
  const stateReads = new Map<string, Promise<void>>();
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  return create<DiagramsState>()((set, get) => {
    function failed(datasourceId: string, cause: unknown): void {
      const failure =
        cause instanceof DiagramsFailure
          ? { message: cause.message, hint: cause.hint }
          : { message: toError(cause).message, hint: "Move a table to save the diagram again." };
      set({ failures: { ...get().failures, [datasourceId]: failure } });
    }

    function settled(datasourceId: string): void {
      if (!(datasourceId in get().failures)) return;
      const { [datasourceId]: _gone, ...failures } = get().failures;
      set({ failures });
    }

    function scheduleSave(datasourceId: string): void {
      if (dependencies.isEphemeral?.(datasourceId) === true) return;
      clearTimeout(saveTimers.get(datasourceId));
      saveTimers.set(
        datasourceId,
        setTimeout(() => {
          saveTimers.delete(datasourceId);
          const state = get().states[datasourceId];
          if (state === undefined) return;
          dependencies.persistence.save(datasourceId, state).then(
            () => settled(datasourceId),
            (cause: unknown) => failed(datasourceId, cause),
          );
        }, DIAGRAM_SAVE_DEBOUNCE_MS),
      );
    }

    function patch(id: string, change: Partial<DiagramTab>): void {
      const current = get().tabs[id];
      if (current === undefined) return;
      set({ tabs: { ...get().tabs, [id]: { ...current, ...change } } });
    }

    function stateOf(datasourceId: string): DiagramState {
      return get().states[datasourceId] ?? DEFAULT_DIAGRAM_STATE;
    }

    function updateState(datasourceId: string, change: (state: DiagramState) => DiagramState): void {
      const current = stateOf(datasourceId);
      const next = change(current);
      if (next === current) return;
      set({ states: { ...get().states, [datasourceId]: next } });
      scheduleSave(datasourceId);
    }

    function loadState(datasourceId: string): Promise<void> {
      if (get().states[datasourceId] !== undefined) return Promise.resolve();
      const reading = stateReads.get(datasourceId);
      if (reading !== undefined) return reading;
      const read = dependencies.persistence
        .read(datasourceId)
        .then(
          (state) => state,
          (cause: unknown) => {
            failed(datasourceId, cause);
            return DEFAULT_DIAGRAM_STATE;
          },
        )
        .then((state) => {
          stateReads.delete(datasourceId);
          if (get().states[datasourceId] === undefined) set({ states: { ...get().states, [datasourceId]: state } });
        });
      stateReads.set(datasourceId, read);
      return read;
    }

    function updateLayout(id: string, change: (layout: NamespaceLayout) => NamespaceLayout): void {
      const tab = get().tabs[id];
      if (tab === undefined) return;
      const key = pathKey(tab.path);
      updateState(tab.datasourceId, (state) => {
        const layout = state.layouts[key] ?? openingLayout([]).layout;
        return { ...state, layouts: { ...state.layouts, [key]: change(layout) } };
      });
    }

    async function reloadKeys(id: string): Promise<void> {
      const current = get().tabs[id];
      if (current === undefined) return;
      const token = ++readCount;
      reads.set(id, token);
      patch(id, { loading: true, error: null });
      try {
        const client = await dependencies.connect(current.datasourceId);
        const inferred = await client.call("catalog.inferredKeys", { path: current.path });
        if (reads.get(id) === token) patch(id, { inferred, loading: false, error: null });
      } catch (cause) {
        if (reads.get(id) === token) patch(id, { loading: false, error: toError(cause) });
      }
    }

    return {
      tabs: {},
      states: {},
      failures: {},
      relayouts: {},
      loadState,

      forget(datasourceId) {
        clearTimeout(saveTimers.get(datasourceId));
        saveTimers.delete(datasourceId);
        const { [datasourceId]: _state, ...states } = get().states;
        const { [datasourceId]: _failure, ...failures } = get().failures;
        set({ states, failures });
      },

      selectEdge(id, edge) {
        patch(id, { edge });
      },

      async open(id, target) {
        const { datasourceId, path, namespace } = target;
        set({
          tabs: {
            ...get().tabs,
            [id]: {
              datasourceId,
              path,
              namespace,
              inferred: null,
              loading: false,
              error: null,
              pickerOpen: false,
              hiddenKeysOpen: false,
              selected: null,
              edge: null,
              viewport: null,
            },
          },
        });
        await Promise.all([
          loadState(datasourceId),
          dependencies.catalog().getState().ensureDescribed(datasourceId, path),
          reloadKeys(id),
        ]);
      },

      async refresh(id) {
        const tab = get().tabs[id];
        if (tab === undefined) return;
        await dependencies.catalog().getState().synchronize(tab.datasourceId, tab.path);
      },

      reloadKeys,

      close(id) {
        reads.delete(id);
        const { [id]: _gone, ...tabs } = get().tabs;
        const { [id]: _relayout, ...relayouts } = get().relayouts;
        set({ tabs, relayouts });
      },

      ensureLayout(id, tableIds) {
        const tab = get().tabs[id];
        if (tab === undefined || get().states[tab.datasourceId] === undefined) return;
        if (diagramLayoutOf(get(), tab) !== undefined) return;
        const opening = openingLayout(tableIds);
        updateLayout(id, () => opening.layout);
        if (opening.pickerOpen) patch(id, { pickerOpen: true });
      },

      updateLayout,
      updateState,

      relayout(id) {
        updateLayout(id, (layout) => ({ ...layout, positions: {} }));
        patch(id, { viewport: null });
        set({ relayouts: { ...get().relayouts, [id]: (get().relayouts[id] ?? 0) + 1 } });
      },

      setPickerOpen(id, open) {
        patch(id, { pickerOpen: open });
      },

      setHiddenKeysOpen(id, open) {
        patch(id, { hiddenKeysOpen: open });
      },

      select(id, table) {
        patch(id, { selected: table });
      },

      setViewport(id, viewport) {
        patch(id, { viewport });
      },
    };
  });
}

export type DiagramsStore = ReturnType<typeof createDiagramsStore>;

export const useDiagrams = createDiagramsStore({
  connect: (id) => useDatasources.getState().connect(id),
  catalog: () => useCatalog,
  persistence: BRIDGE_DIAGRAMS,
  isEphemeral: (id) => datasourceById(useDatasources.getState(), id)?.ephemeral ?? true,
});

/** The diagram tabs open on a datasource, by tab id. */
export function diagramsOf(tabs: DiagramsState["tabs"], datasourceId: string): readonly string[] {
  return Object.entries(tabs)
    .filter(([, tab]) => tab.datasourceId === datasourceId)
    .map(([id]) => id);
}

/**
 * Asks for an open diagram's inferred keys again whenever the catalog describes its namespace anew:
 * after DDL runs in a console, on Synchronize, or on the diagram's own Refresh.
 */
export function followDiagramRedescribes(diagrams: DiagramsStore, catalog: CatalogStore): () => void {
  return catalog.subscribe((state, previous) => {
    for (const [id, tab] of Object.entries(diagrams.getState().tabs)) {
      const key = pathKey(tab.path);
      const before = previous.catalogs[tab.datasourceId]?.namespaceStates[key]?.described ?? null;
      const after = state.catalogs[tab.datasourceId]?.namespaceStates[key]?.described ?? null;
      if (before !== null && after !== null && before !== after) void diagrams.getState().reloadKeys(id);
    }
  });
}

interface CachedGraph {
  readonly inferred: readonly InferredKey[];
  readonly state: DiagramState;
  readonly graph: DiagramGraph;
}

const graphs = new WeakMap<DescribedCatalog, CachedGraph>();

/**
 * The graph a diagram tab draws, or null until its schema, its inferred keys and the saved state are
 * in. The last graph per described schema is kept, so menus asking which actions apply stay cheap.
 */
export function diagramGraphOf(diagrams: Pick<DiagramsState, "states">, tab: DiagramTab): DiagramGraph | null {
  const catalog = useCatalog.getState().catalogs[tab.datasourceId]?.namespaceStates[pathKey(tab.path)]?.described;
  const state = diagrams.states[tab.datasourceId];
  if (catalog === null || catalog === undefined || tab.inferred === null || state === undefined) return null;
  const cached = graphs.get(catalog);
  if (cached !== undefined && cached.inferred === tab.inferred && cached.state === state) return cached.graph;
  const graph = diagramGraph({ catalog, inferred: tab.inferred, state });
  graphs.set(catalog, { inferred: tab.inferred, state, graph });
  return graph;
}
