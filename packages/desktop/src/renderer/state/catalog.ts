import { create } from "zustand";
import type { EngineError, Namespace } from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  catalogKeyPrefix,
  datasourceKey,
  EMPTY_CATALOG,
  namespaceKey,
  pathKey,
  type DatasourceCatalog,
  type NamespaceState,
} from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

export interface CatalogState {
  /** By datasource id; a datasource without an entry has listed nothing since it last attached. */
  readonly catalogs: Readonly<Record<string, DatasourceCatalog>>;
  /** Expanded datasource and catalog node keys (`model/explorerTree`). */
  readonly expanded: ReadonlySet<string>;
  readonly collapsedFolders: ReadonlySet<string>;
  /** Bumped when an action wants the tree to scroll to and focus its selection. */
  readonly focusRequest: number;
  readonly requestFocus: () => void;
  /** The tree's speed search text while its field is open; it owns Escape then. */
  readonly speedSearch: string | null;
  readonly setSpeedSearch: (query: string | null) => void;
  readonly toggleFolder: (path: string) => void;
  /** Opens a collapsed folder, as a drag hovering on it does. */
  readonly expandFolder: (path: string) => void;
  /** Keeps folders a move renamed collapsed under their new paths. */
  readonly renameFolders: (renamed: ReadonlyMap<string, string>) => void;
  readonly setExpanded: (key: string, expanded: boolean) => void;
  /** Expands the datasource, connecting it first; the first listing also opens the current namespace. */
  readonly expandDatasource: (datasourceId: string) => Promise<void>;
  /** Expands the namespace, describing it when it is a schema not read yet. */
  readonly expandNamespace: (datasourceId: string, namespace: Namespace) => Promise<void>;
  /** Describes the schema at `path` unless it already is, without expanding anything. */
  readonly ensureDescribed: (datasourceId: string, path: readonly string[]) => Promise<void>;
  /** Reads `path` again, or the namespace list when `path` is null or names a database. */
  readonly synchronize: (datasourceId: string, path: readonly string[] | null) => Promise<void>;
  /** Reads again the namespace list and every schema already described, after DDL (plan 006). */
  readonly refreshCached: (datasourceId: string) => Promise<void>;
  readonly expandAll: (keys: readonly string[]) => void;
  readonly collapseAll: (folderPaths: readonly string[]) => void;
  /** Forgets the datasource's catalog and expansion; its engine is gone. */
  readonly clear: (datasourceId: string) => void;
}

export interface CatalogDependencies {
  /** The datasource's live client, connecting it when needed. */
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
}

function toEngineError(cause: unknown): EngineError {
  if (cause instanceof EngineRequestError) return { code: cause.code, message: cause.message, hint: cause.hint };
  return {
    code: "internal",
    message: cause instanceof Error ? cause.message : String(cause),
    hint: "Choose Synchronize (⌥⌘Y) to try again; if it happens again, report it.",
  };
}

export function createCatalogStore(dependencies: CatalogDependencies) {
  /** Bumped by `clear`, so an answer from an engine that has since gone is dropped. */
  const generations = new Map<string, number>();
  const generationOf = (id: string) => generations.get(id) ?? 0;

  return create<CatalogState>()((set, get) => {
    function catalogOf(id: string): DatasourceCatalog {
      return get().catalogs[id] ?? EMPTY_CATALOG;
    }

    function update(id: string, change: (catalog: DatasourceCatalog) => DatasourceCatalog): void {
      set({ catalogs: { ...get().catalogs, [id]: change(catalogOf(id)) } });
    }

    function setNamespaceState(id: string, path: readonly string[], state: NamespaceState): void {
      update(id, (catalog) => ({
        ...catalog,
        namespaceStates: { ...catalog.namespaceStates, [pathKey(path)]: state },
      }));
    }

    function expand(keys: readonly string[]): void {
      const expanded = new Set(get().expanded);
      for (const key of keys) expanded.add(key);
      set({ expanded });
    }

    function collapse(key: string): void {
      if (!get().expanded.has(key)) return;
      const expanded = new Set(get().expanded);
      expanded.delete(key);
      set({ expanded });
    }

    async function describe(id: string, path: readonly string[], refresh: boolean): Promise<void> {
      const generation = generationOf(id);
      const previous = catalogOf(id).namespaceStates[pathKey(path)]?.described ?? null;
      setNamespaceState(id, path, { described: previous, loading: true, error: null });
      try {
        const client = await dependencies.connect(id);
        const described = await client.call("catalog.describe", { path, ...(refresh ? { refresh } : {}) });
        if (generationOf(id) === generation) setNamespaceState(id, path, { described, loading: false, error: null });
      } catch (cause) {
        if (generationOf(id) !== generation) return;
        setNamespaceState(id, path, { described: previous, loading: false, error: toEngineError(cause) });
      }
    }

    /** Lists the namespaces; the first listing since attach expands and describes the current one. */
    async function listNamespaces(id: string, refresh: boolean): Promise<void> {
      const generation = generationOf(id);
      const first = catalogOf(id).namespaces === null;
      update(id, (catalog) => ({ ...catalog, loading: true, error: null }));
      let namespaces: readonly Namespace[];
      try {
        const client = await dependencies.connect(id);
        namespaces = await client.call("catalog.namespaces", refresh ? { refresh } : {});
      } catch (cause) {
        if (generationOf(id) !== generation) return;
        update(id, (catalog) => ({ ...catalog, loading: false, error: toEngineError(cause) }));
        return;
      }
      if (generationOf(id) !== generation) return;
      update(id, (catalog) => ({ ...catalog, namespaces, loading: false, error: null }));
      const current = first
        ? namespaces.find((namespace) => namespace.current && namespace.kind === "schema")
        : undefined;
      if (current === undefined) return;
      expand(current.path.map((_, index) => namespaceKey(id, current.path.slice(0, index + 1))));
      await describe(id, current.path, false);
    }

    return {
      catalogs: {},
      expanded: new Set(),
      collapsedFolders: new Set(),
      focusRequest: 0,
      speedSearch: null,

      requestFocus() {
        set({ focusRequest: get().focusRequest + 1 });
      },

      setSpeedSearch(speedSearch) {
        set({ speedSearch });
      },

      toggleFolder(path) {
        const collapsedFolders = new Set(get().collapsedFolders);
        if (collapsedFolders.has(path)) collapsedFolders.delete(path);
        else collapsedFolders.add(path);
        set({ collapsedFolders });
      },

      expandFolder(path) {
        if (!get().collapsedFolders.has(path)) return;
        const collapsedFolders = new Set(get().collapsedFolders);
        collapsedFolders.delete(path);
        set({ collapsedFolders });
      },

      renameFolders(renamed) {
        if (renamed.size === 0) return;
        set({ collapsedFolders: new Set([...get().collapsedFolders].map((path) => renamed.get(path) ?? path)) });
      },

      setExpanded(key, expanded) {
        if (expanded) expand([key]);
        else collapse(key);
      },

      async expandDatasource(id) {
        const key = datasourceKey(id);
        expand([key]);
        if (catalogOf(id).namespaces !== null || catalogOf(id).loading) return;
        const generation = generationOf(id);
        update(id, (catalog) => ({ ...catalog, loading: true, error: null }));
        try {
          await dependencies.connect(id);
        } catch {
          // The datasource row shows why (plan 004); there is nothing to list.
          if (generationOf(id) !== generation) return;
          update(id, () => EMPTY_CATALOG);
          collapse(key);
          return;
        }
        await listNamespaces(id, false);
      },

      async expandNamespace(id, namespace) {
        expand([namespaceKey(id, namespace.path)]);
        if (namespace.kind !== "schema" || catalogOf(id).namespaceStates[pathKey(namespace.path)] !== undefined) return;
        await describe(id, namespace.path, false);
      },

      async ensureDescribed(id, path) {
        const state = catalogOf(id).namespaceStates[pathKey(path)];
        if (state?.described != null || state?.loading === true) return;
        await describe(id, path, false);
      },

      async synchronize(id, path) {
        const namespace =
          path === null
            ? undefined
            : catalogOf(id).namespaces?.find((candidate) => pathKey(candidate.path) === pathKey(path));
        if (path === null || namespace?.kind !== "schema") await listNamespaces(id, true);
        else await describe(id, path, true);
      },

      async refreshCached(id) {
        const { namespaces, namespaceStates } = catalogOf(id);
        if (namespaces === null) return;
        const described = namespaces.filter(
          (namespace) => (namespaceStates[pathKey(namespace.path)]?.described ?? null) !== null,
        );
        await Promise.all([
          listNamespaces(id, true),
          ...described.map((namespace) => describe(id, namespace.path, true)),
        ]);
      },

      expandAll: expand,

      collapseAll(folderPaths) {
        set({ expanded: new Set(), collapsedFolders: new Set(folderPaths) });
      },

      clear(id) {
        generations.set(id, generationOf(id) + 1);
        const { [id]: _gone, ...catalogs } = get().catalogs;
        const prefix = catalogKeyPrefix(id);
        const own = datasourceKey(id);
        const expanded = new Set([...get().expanded].filter((key) => key !== own && !key.startsWith(prefix)));
        set({ catalogs, expanded });
      },
    };
  });
}

export type CatalogStore = ReturnType<typeof createCatalogStore>;

export const useCatalog = createCatalogStore({ connect: (id) => useDatasources.getState().connect(id) });
