/** What a diagram table shows of its columns (plan 152, decision 13). */
export const DIAGRAM_COLUMN_MODES = ["all", "keys", "names"] as const;
export type DiagramColumnMode = (typeof DIAGRAM_COLUMN_MODES)[number];

export interface DiagramPosition {
  readonly x: number;
  readonly y: number;
}

/** One namespace's canvas: where its tables sit, which are hidden, and how much of each shows. */
export interface NamespaceLayout {
  readonly positions: Readonly<Record<string, DiagramPosition>>;
  readonly hiddenTables: readonly string[];
  readonly columns: DiagramColumnMode;
}

/** A relationship the user drew because the database declares none and the heuristic missed it. */
export interface VirtualKey {
  readonly id: string;
  readonly path: readonly string[];
  readonly relation: string;
  readonly columns: readonly string[];
  readonly target: { readonly path: readonly string[]; readonly relation: string; readonly columns: readonly string[] };
}

/** One datasource's diagrams, as `<userData>/diagrams.json` keeps them (plan 152, decision 8). */
export interface DiagramState {
  readonly inferKeys: boolean;
  /** Inferred keys the user hid, each as `hiddenKeyId` spells it. */
  readonly hiddenKeys: readonly string[];
  readonly virtualKeys: readonly VirtualKey[];
  /** Keyed by the namespace path key, `JSON.stringify(path)`. */
  readonly layouts: Readonly<Record<string, NamespaceLayout>>;
}

export const DEFAULT_DIAGRAM_STATE: DiagramState = { inferKeys: true, hiddenKeys: [], virtualKeys: [], layouts: {} };

/**
 * How a hidden inferred key is saved: its namespace with its `InferredKey.id`, which names only
 * tables and columns, so hiding `orders(customer_id)->customers(id)` in one schema leaves another
 * schema's alone.
 */
export function hiddenKeyId(path: readonly string[], keyId: string): string {
  return JSON.stringify([path, keyId]);
}

/** The id a virtual key is saved under: its two ends, so the same relationship cannot be added twice. */
export function virtualKeyId(key: Omit<VirtualKey, "id">): string {
  return JSON.stringify([
    key.path,
    key.relation,
    key.columns,
    key.target.path,
    key.target.relation,
    key.target.columns,
  ]);
}
