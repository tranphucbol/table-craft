import { create } from "zustand";
import type { ServerNode } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

/** The servers of each `nodes` datasource (decision 114), as the engine last listed them. */
export interface ServerState {
  /** By datasource id; absent until listed, and after a listing failed. */
  readonly nodes: Readonly<Record<string, readonly ServerNode[]>>;
  /** Lists the datasource's servers again; a failure forgets the last list. */
  readonly loadNodes: (datasourceId: string) => Promise<readonly ServerNode[]>;
}

export interface ServerDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
}

export function createServerStore(dependencies: ServerDependencies) {
  return create<ServerState>()((set) => ({
    nodes: {},
    async loadNodes(datasourceId) {
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
    },
  }));
}

export const useServer = createServerStore({ connect: (id) => useDatasources.getState().connect(id) });
