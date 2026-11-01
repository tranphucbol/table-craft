import { create } from "zustand";
import {
  serverSeenOf,
  type Capability,
  type EngineError,
  type EngineEvent,
  type OpenedSession,
  type ServerSeen,
} from "@table-craft/desktop/engine/protocol.js";
import {
  SSH_SECRET_LABELS,
  type ConnectionField,
  type DatasourceList,
  type DatasourceView,
  type CatalogPlugin,
  type EngineExited,
  type PluginInfo,
  type PluginsState,
} from "@table-craft/desktop/preload/bridge.js";
import type { TreeItemRef } from "@table-craft/desktop/datasourceTree/arrange.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { itemOf, remapSelection, type TreeSelectionState } from "@table-craft/desktop/renderer/model/treeSelection.js";
import {
  connectEngine,
  EngineRequestError,
  type EngineClient,
  type EngineConnection,
} from "@table-craft/desktop/renderer/engine/client.js";
import { useSecretPrompt } from "@table-craft/desktop/renderer/state/secretPrompt.js";

/** `disconnected` until something connects; `failed` keeps the reason until the next attempt. */
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "failed";

export interface Connection {
  readonly status: ConnectionStatus;
  readonly error: EngineError | null;
  /** What the server reported on the last successful connect. */
  readonly serverVersion: string | null;
  /** The product the server said it is on the last successful connect; null before one or when the plugin names none. */
  readonly serverBrand: string | null;
}

export const DISCONNECTED: Connection = { status: "disconnected", error: null, serverVersion: null, serverBrand: null };

/** What the Database pane can have selected. */
export type TreeSelection =
  | { readonly kind: "datasource"; readonly id: string }
  | { readonly kind: "folder"; readonly path: string }
  /** A node below a datasource (plan 005); `id` is the datasource's. */
  | {
      readonly kind: "catalog";
      readonly id: string;
      /** The row's key in `model/explorerTree`. */
      readonly key: string;
      /** The namespace the node is in, or is. */
      readonly path: readonly string[];
      /** The relation, routine or sequence the node is or belongs to; null on namespaces and groups. */
      readonly name: string | null;
    };

/** The datasource a selection is on or under. */
export function selectedDatasourceId(selection: TreeSelection | null): string | null {
  return selection === null || selection.kind === "folder" ? null : selection.id;
}

export interface SecretRequest {
  readonly datasource: DatasourceView;
  readonly fields: readonly ConnectionField[];
}

export interface DatasourcesState {
  readonly loaded: boolean;
  readonly datasources: readonly DatasourceView[];
  readonly plugins: readonly PluginInfo[];
  /** The plugins TableCraft can download, with each one's install progress (decision 110). */
  readonly catalog: readonly CatalogPlugin[];
  readonly encryption: DatasourceList["encryption"];
  readonly warning: string | null;
  readonly connections: Readonly<Record<string, Connection>>;
  /** The lead of the Database pane's selection: what single-target actions and the keyboard follow. */
  readonly selection: TreeSelection | null;
  /** Every selected datasource and folder while more than one is (plan 136); empty otherwise. */
  readonly multi: readonly TreeItemRef[];
  readonly anchor: TreeItemRef | null;
  /** Every folder in the stored order, ancestors first, empty ones included. */
  readonly folders: readonly string[];
  readonly applyList: (list: DatasourceList) => void;
  readonly setPlugins: (plugins: readonly PluginInfo[]) => void;
  readonly applyPlugins: (state: PluginsState) => void;
  /** Selects one row, dropping any other. */
  readonly select: (selection: TreeSelection | null) => void;
  readonly setTreeSelection: (next: TreeSelectionState) => void;
  /** Makes the selection follow folders a move renamed. */
  readonly renameFolders: (renamed: ReadonlyMap<string, string>) => void;
  /** Starts the engine if needed, checks it with one session, and resolves with its client. */
  readonly connect: (id: string) => Promise<EngineClient>;
  readonly disconnect: (id: string) => Promise<void>;
  readonly engineExited: (exited: EngineExited) => void;
  readonly dismissWarning: () => void;
}

export interface DatasourcesDependencies {
  readonly connectEngine: (id: string, secrets?: Readonly<Record<string, string>>) => Promise<EngineConnection>;
  readonly disconnectEngine: (id: string) => Promise<void>;
  /** Asks the user for secrets kept Never; null when they cancel. */
  readonly promptSecrets: (request: SecretRequest) => Promise<Readonly<Record<string, string>> | null>;
  /**
   * Saves what a connection reported on the datasource (decision 131): its brand shows before the
   * next connect, and Settings › MCP Server explains its timeout without connecting.
   */
  readonly rememberServer: (id: string, seen: ServerSeen) => Promise<void>;
  readonly now?: () => number;
}

export type DetachedListener = (datasourceId: string, error: EngineError | null) => void;
export type DatasourceEventListener = (datasourceId: string, event: EngineEvent) => void;
export type RemovedListener = (datasourceIds: readonly string[]) => void;

export const ENGINE_EXITED_HINT = "Connect again; if it keeps happening, the plugin or its driver crashed.";
const CANCELLED: EngineError = {
  code: "cancelled",
  message: "Connecting was cancelled.",
  hint: "Connect again and enter the password.",
};

function engineExitedError(code: number): EngineError {
  return { code: "internal", message: `Engine exited (code ${String(code)}).`, hint: ENGINE_EXITED_HINT };
}

function toEngineError(cause: unknown): EngineError {
  if (cause instanceof EngineRequestError) return { code: cause.code, message: cause.message, hint: cause.hint };
  return {
    code: "internal",
    message: cause instanceof Error ? cause.message : String(cause),
    hint: "Restart the app; if it happens again, report it.",
  };
}

export function pluginOf(plugins: readonly PluginInfo[], pluginId: string): PluginInfo | undefined {
  return plugins.find((plugin) => plugin.id === pluginId);
}

/** The fields the secret prompt asks for `keys`: the plugin's own, then the SSH tunnel's (decision 070). */
export function promptFields(plugin: PluginInfo | undefined, keys: readonly string[]): readonly ConnectionField[] {
  const own = (plugin?.fields ?? []).filter((field) => keys.includes(field.key));
  const tunnel = keys.flatMap((key): ConnectionField[] => {
    const label = SSH_SECRET_LABELS[key];
    return label === undefined ? [] : [{ key, label, kind: "password", secret: true }];
  });
  return [...own, ...tunnel];
}

export function capabilitiesOf(plugins: readonly PluginInfo[], pluginId: string): readonly Capability[] {
  return pluginOf(plugins, pluginId)?.capabilities ?? [];
}

export function createDatasourcesStore(dependencies: DatasourcesDependencies) {
  /** Live clients by datasource; not state, because nothing renders a port. */
  const clients = new Map<string, Promise<EngineClient>>();
  /** Disconnects in flight, which a new connect waits out so it gets a fresh engine. */
  const stopping = new Map<string, Promise<void>>();
  const detachedListeners = new Set<DetachedListener>();
  const eventListeners = new Set<DatasourceEventListener>();
  const removedListeners = new Set<RemovedListener>();

  const store = create<DatasourcesState>()((set, get) => {
    function setConnection(id: string, connection: Connection): void {
      set({ connections: { ...get().connections, [id]: connection } });
    }

    function find(id: string): DatasourceView {
      const found = get().datasources.find((datasource) => datasource.id === id);
      if (found === undefined) {
        throw new EngineRequestError({
          code: "invalidRequest",
          message: `No data source with id "${id}".`,
          hint: "It may have been deleted; pick another one.",
        });
      }
      return found;
    }

    async function open(id: string): Promise<EngineClient> {
      await stopping.get(id);
      const datasource = find(id);
      let secrets: Readonly<Record<string, string>> | undefined;
      for (;;) {
        const connection = await dependencies.connectEngine(id, secrets);
        if (connection.status === "connected") return connection.client;
        if (connection.status === "failed") throw new EngineRequestError(connection.error);
        const fields = promptFields(pluginOf(get().plugins, datasource.pluginId), connection.keys);
        const typed = await dependencies.promptSecrets({ datasource, fields });
        if (typed === null) throw new EngineRequestError(CANCELLED);
        secrets = typed;
      }
    }

    async function verify(client: EngineClient): Promise<OpenedSession> {
      const opened = await client.call("session.open", {});
      void client.call("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
      return opened;
    }

    function remember(id: string, opened: OpenedSession): void {
      const view = get().datasources.find((datasource) => datasource.id === id);
      if (view === undefined || view.ephemeral) return;
      const seen = serverSeenOf(opened, (dependencies.now ?? Date.now)());
      void dependencies.rememberServer(id, seen).catch(() => undefined);
    }

    function stop(id: string): Promise<void> {
      const running = stopping.get(id);
      if (running !== undefined) return running;
      const done = dependencies
        .disconnectEngine(id)
        .catch(() => undefined)
        .finally(() => stopping.delete(id));
      stopping.set(id, done);
      return done;
    }

    function detach(id: string, error: EngineError | null): void {
      const client = clients.get(id);
      clients.delete(id);
      if (client !== undefined) {
        void client
          .then((engine) =>
            engine.fail(error ?? { code: "cancelled", message: "Disconnected.", hint: "Run again to reconnect." }),
          )
          .catch(() => undefined);
      }
      for (const listener of detachedListeners) listener(id, error);
    }

    return {
      loaded: false,
      datasources: [],
      plugins: [],
      catalog: [],
      encryption: { available: true, reason: null },
      warning: null,
      connections: {},
      selection: null,
      multi: [],
      anchor: null,
      folders: [],

      applyList(list) {
        const known = new Set(list.datasources.map((datasource) => datasource.id));
        const removed = get()
          .datasources.map((datasource) => datasource.id)
          .filter((id) => !known.has(id));
        const connections = Object.fromEntries(Object.entries(get().connections).filter(([id]) => known.has(id)));
        const folders = new Set(list.folders);
        const { lead, multi, anchor } = remapSelection(treeSelectionOf(get()), new Map(), (item) =>
          item.kind === "folder" ? folders.has(item.path) : known.has(item.id),
        );
        set({
          loaded: true,
          datasources: list.datasources,
          folders: list.folders,
          encryption: list.encryption,
          warning: list.warning ?? get().warning,
          connections,
          selection: lead,
          multi,
          anchor,
        });
        for (const id of removed) detach(id, null);
        if (removed.length > 0) for (const listener of removedListeners) listener(removed);
      },

      setPlugins(plugins) {
        set({ plugins });
      },

      applyPlugins({ plugins, catalog }) {
        set({ plugins, catalog });
      },

      select(selection) {
        set({ selection, multi: [], anchor: itemOf(selection) });
      },

      setTreeSelection({ lead, multi, anchor }) {
        set({ selection: lead, multi, anchor });
      },

      renameFolders(renamed) {
        if (renamed.size === 0) return;
        const { lead, multi, anchor } = remapSelection(treeSelectionOf(get()), renamed, () => true);
        set({ selection: lead, multi, anchor });
      },

      connect(id) {
        const existing = clients.get(id);
        if (existing !== undefined) return existing;
        const previous = get().connections[id] ?? DISCONNECTED;
        setConnection(id, { ...previous, status: "connecting", error: null });
        // Started on a later tick so it can compare itself with the map: a disconnect or a crash
        // mid-connect leaves this attempt stale.
        const connecting = Promise.resolve().then(async () => {
          const client = await open(id);
          client.onEvent((event) => {
            for (const listener of eventListeners) listener(id, event);
          });
          try {
            const opened = await verify(client);
            if (clients.get(id) === connecting) {
              const { serverVersion, serverBrand } = opened;
              setConnection(id, { status: "connected", error: null, serverVersion, serverBrand });
              remember(id, opened);
            }
            return client;
          } catch (cause) {
            client.fail(toEngineError(cause));
            throw cause;
          }
        });
        clients.set(id, connecting);
        connecting.catch((cause: unknown) => {
          if (clients.get(id) !== connecting) return;
          clients.delete(id);
          const error = toEngineError(cause);
          setConnection(id, { ...DISCONNECTED, status: "failed", error });
          // A wrong password typed into the prompt must not stay in a running engine.
          void stop(id);
        });
        return connecting;
      },

      async disconnect(id) {
        const wasLive = clients.has(id);
        detach(id, null);
        if (wasLive || get().connections[id]?.status === "connected") {
          const last = get().connections[id] ?? DISCONNECTED;
          setConnection(id, { ...DISCONNECTED, serverVersion: last.serverVersion, serverBrand: last.serverBrand });
        }
        await stop(id);
      },

      engineExited(exited) {
        if (!clients.has(exited.datasourceId)) return;
        const error = exited.clean ? null : engineExitedError(exited.code);
        detach(exited.datasourceId, error);
        setConnection(exited.datasourceId, {
          ...DISCONNECTED,
          status: error === null ? "disconnected" : "failed",
          error,
        });
      },

      dismissWarning() {
        set({ warning: null });
      },
    };
  });

  return Object.assign(store, {
    /** Called when a datasource's sessions are gone: disconnected, crashed or deleted. */
    onDetached(listener: DetachedListener): () => void {
      detachedListeners.add(listener);
      return () => detachedListeners.delete(listener);
    },
    /** Every event any datasource's engine pushes, such as export progress. */
    onEngineEvent(listener: DatasourceEventListener): () => void {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onRemoved(listener: RemovedListener): () => void {
      removedListeners.add(listener);
      return () => removedListeners.delete(listener);
    },
  });
}

export type DatasourcesStore = ReturnType<typeof createDatasourcesStore>;

export function treeSelectionOf(state: Pick<DatasourcesState, "selection" | "multi" | "anchor">): TreeSelectionState {
  return { lead: state.selection, multi: state.multi, anchor: state.anchor };
}

export const useDatasources = createDatasourcesStore({
  connectEngine,
  async disconnectEngine(id) {
    await bridge().disconnectEngine(id);
  },
  promptSecrets: (request) => useSecretPrompt.getState().ask(request),
  async rememberServer(id, seen) {
    await bridge().rememberServer(id, seen);
  },
});

export function datasourceById(state: DatasourcesState, id: string | null | undefined): DatasourceView | undefined {
  return id == null ? undefined : state.datasources.find((datasource) => datasource.id === id);
}

export function connectionOf(state: DatasourcesState, id: string): Connection {
  return state.connections[id] ?? DISCONNECTED;
}
