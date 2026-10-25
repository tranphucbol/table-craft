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
