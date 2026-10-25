import { create } from "zustand";
import type { EngineError, ServerInfo, ServerNode, SlowCommand } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  SLOW_LOG_LIMIT,
  type RefreshInterval,
  type ServerView,
} from "@table-craft/desktop/renderer/model/serverInfo.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

/**
 * One Server tab (decision 20 of plan 058). `node` null is the server itself, or in a cluster the
 * Overview of every node.
 */
export interface ServerTab {
  readonly datasourceId: string;
  readonly node: string | null;
  readonly view: ServerView;
  readonly refreshSeconds: RefreshInterval;
  /** The picked node's figures, or by node id every node's for the Overview; kept while a read is in flight. */
  readonly infos: Readonly<Record<string, ServerInfo>>;
  readonly info: ServerInfo | null;
  readonly slowLog: readonly SlowCommand[] | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
  /** When the figures shown were read, by the renderer's clock. */
  readonly readAt: number | null;
  /** The selected slow-log row's `slowCommandKey`. */
  readonly selectedSlow: string | null;
}

/** The servers of each `nodes` datasource (decision 114), and the open Server tabs. */
export interface ServerState {
  /** By datasource id; absent until listed, and after a listing failed. */
  readonly nodes: Readonly<Record<string, readonly ServerNode[]>>;
  /** Lists the datasource's servers again; a failure forgets the last list. */
  readonly loadNodes: (datasourceId: string) => Promise<readonly ServerNode[]>;
  /** By tab id. */
  readonly tabs: Readonly<Record<string, ServerTab>>;
  readonly open: (id: string, datasourceId: string) => Promise<void>;
  /** Reads the tab's view again: the picked node's sections, the Overview or the slow log. */
  readonly refresh: (id: string) => Promise<void>;
  readonly setNode: (id: string, node: string | null) => Promise<void>;
  readonly setView: (id: string, view: ServerView) => Promise<void>;
  readonly setRefresh: (id: string, seconds: RefreshInterval) => void;
  readonly selectSlow: (id: string, key: string | null) => void;
  readonly close: (id: string) => void;
}

export interface ServerDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  readonly now?: () => number;
}

/** The Overview reads every node; a standalone server and a picked node read one. */
export function showsOverview(tab: ServerTab, nodes: readonly ServerNode[] | undefined): boolean {
  return tab.node === null && (nodes?.length ?? 0) > 1;
}

export function createServerStore(dependencies: ServerDependencies) {
  const now = dependencies.now ?? Date.now;
  /** The latest read per tab, so an answer overtaken by a later one is dropped. */
  const reads = new Map<string, number>();
  let readCount = 0;

  return create<ServerState>()((set, get) => {
    function patch(id: string, change: Partial<ServerTab>): void {
      const current = get().tabs[id];
      if (current !== undefined) set({ tabs: { ...get().tabs, [id]: { ...current, ...change } } });
    }

    async function loadNodes(datasourceId: string): Promise<readonly ServerNode[]> {
      try {
        const client = await dependencies.connect(datasourceId);
        const nodes = await client.call("server.nodes", {});
        set((state) => ({ nodes: { ...state.nodes, [datasourceId]: nodes } }));
        return nodes;
      } catch {
        set((state) => {
          const { [datasourceId]: _forgotten, ...rest } = state.nodes;
          return { nodes: rest };
        });
        return [];
      }
    }

    async function read(client: EngineClient, tab: ServerTab): Promise<Partial<ServerTab>> {
      if (tab.view === "slowLog") {
        return { slowLog: await client.call("server.slowLog", { node: tab.node, limit: SLOW_LOG_LIMIT }) };
      }
      const nodes = get().nodes[tab.datasourceId] ?? (await loadNodes(tab.datasourceId));
      if (!showsOverview(tab, nodes)) return { info: await client.call("server.info", { node: tab.node }) };
      const infos: Record<string, ServerInfo> = {};
      for (const node of nodes) infos[node.id] = await client.call("server.info", { node: node.id });
      return { infos };
    }

    async function refresh(id: string): Promise<void> {
      const tab = get().tabs[id];
      if (tab === undefined) return;
      const token = ++readCount;
      reads.set(id, token);
      patch(id, { loading: true });
      try {
        const client = await dependencies.connect(tab.datasourceId);
        const answer = await read(client, tab);
        if (reads.get(id) === token) patch(id, { ...answer, loading: false, error: null, readAt: now() });
      } catch (cause) {
        if (reads.get(id) === token) patch(id, { loading: false, error: toError(cause) });
      }
    }

    return {
      nodes: {},
      loadNodes,
      tabs: {},

      async open(id, datasourceId) {
        const tab: ServerTab = {
          datasourceId,
          node: null,
          view: "info",
          refreshSeconds: 0,
          infos: {},
          info: null,
          slowLog: null,
          loading: false,
          error: null,
          readAt: null,
          selectedSlow: null,
        };
        set({ tabs: { ...get().tabs, [id]: tab } });
        await loadNodes(datasourceId);
        await refresh(id);
      },

      refresh,

      async setNode(id, node) {
        patch(id, { node, info: null, slowLog: null });
        await refresh(id);
      },

      async setView(id, view) {
        patch(id, { view });
        await refresh(id);
      },

      setRefresh(id, seconds) {
        patch(id, { refreshSeconds: seconds });
      },

      selectSlow(id, key) {
        patch(id, { selectedSlow: key });
      },

      close(id) {
        reads.delete(id);
        const { [id]: _gone, ...tabs } = get().tabs;
        set({ tabs });
      },
    };
  });
}

export type ServerStore = ReturnType<typeof createServerStore>;

export const useServer = createServerStore({ connect: (id) => useDatasources.getState().connect(id) });

/** A slow-log row's key: its id, which repeats across the nodes of a cluster, and its node. */
export function slowCommandKey(command: SlowCommand): string {
  return `${String(command.id)}@${command.node ?? ""}`;
}

/** The selected slow-log row as last read, or null. */
export function selectedSlowCommand(tab: ServerTab | undefined): SlowCommand | null {
  if (tab === undefined || tab.selectedSlow === null || tab.view !== "slowLog") return null;
  return tab.slowLog?.find((command) => slowCommandKey(command) === tab.selectedSlow) ?? null;
}

/** The Server tab open on a datasource, if any; there is at most one. */
export function serverTabOf(tabs: ServerState["tabs"], datasourceId: string): string | null {
  return Object.entries(tabs).find(([, tab]) => tab.datasourceId === datasourceId)?.[0] ?? null;
}
