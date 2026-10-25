/** Mirrors `NODE_ROLES` in plugin-api (decision 114). */
export const NODE_ROLES = ["primary", "replica"] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

/** Mirrors `ServerNode` in plugin-api: one server of a `nodes` datasource. */
export interface ServerNode {
  readonly id: string;
  readonly address: string;
  readonly role: NodeRole;
  readonly slots: readonly (readonly [number, number])[];
  readonly primaryId: string | null;
  readonly state: string;
}

/** Mirrors `ServerInfoSection` in plugin-api. */
export interface ServerInfoSection {
  readonly title: string;
  readonly entries: readonly { readonly name: string; readonly value: string }[];
}

/** Mirrors `ServerInfo` in plugin-api: what one node reports about itself (decision 114). */
export interface ServerInfo {
  readonly node: string | null;
  readonly sections: readonly ServerInfoSection[];
}

/** Mirrors `SlowCommand` in plugin-api. */
export interface SlowCommand {
  readonly id: number;
  readonly at: string;
  readonly durationMicros: number;
  readonly command: string;
  readonly client: string | null;
  readonly node: string | null;
}
