import type { ServerMessage } from "./plugin.js";

/** A name and its value as the database printed it, such as `Filter` and `(total > 10)`. */
export interface PlanProperty {
  readonly name: string;
  readonly value: string;
}

/**
 * One step of a plan (decision 031), normalised from whatever the dialect prints. Numbers are plain
 * JavaScript numbers, not wire values: they are estimates and timings, never data. Null where the
 * dialect reports nothing, so a view leaves the cell empty.
 */
export interface PlanNode {
  /** What the step does, such as `Seq Scan` or `Nested loop inner join`. */
  readonly operation: string;
  /** The relation it reads, such as `orders o`; null when it reads none or the dialect does not say. */
  readonly target: string | null;
  /** One line more about the step, such as the index it uses; null when there is none. */
  readonly detail: string | null;
  readonly estimatedRows: number | null;
  /** The planner's total cost, in the dialect's own units. */
  readonly estimatedCost: number | null;
  readonly actualRows: number | null;
  /** Milliseconds until the step returned its last row, per loop. */
  readonly actualTimeMs: number | null;
  readonly loops: number | null;
  /** Everything else the dialect reports about the step, in its order. */
  readonly properties: readonly PlanProperty[];
  readonly children: readonly PlanNode[];
  /**
   * What a reviewer should notice about the step, one sentence each, such as a full table scan or
   * estimates made without statistics (decision 130). The host marks the step and lists each
   * distinct sentence once. Absent or empty when there is nothing to say.
   */
  readonly warnings?: readonly string[];
}

/** What `Session.explain` answers. */
export interface ExplainedPlan {
  /** The EXPLAIN statement the plugin sent, which is what history records. */
  readonly statement: string;
  /** Whether the statement ran (Explain Analyse) rather than only being planned. */
  readonly analyzed: boolean;
  readonly roots: readonly PlanNode[];
  /** Facts about the whole plan, such as `Planning Time` and `Execution Time`. */
  readonly summary: readonly PlanProperty[];
  /** The plan as the database printed it. */
  readonly raw: string;
  /** What the server said while explaining, as `ExecuteResult.messages`; present exactly when the plugin declares `serverMessages`. */
  readonly messages?: readonly ServerMessage[];
}

export interface ExplainOptions {
  /** Run the statement and report what it did (Explain Analyse), not only how it would run. */
  readonly analyze: boolean;
  /** `ExecuteOptions.serverTimeoutMs` for the statement `explain` runs (decision 129). */
  readonly serverTimeoutMs?: number;
}

/**
 * Whether a statement can be explained, decided without a database. `writes` says the statement
 * changes something, so analysing it, which runs it, needs the user's consent first.
 */
export type Explainability =
  { readonly ok: true; readonly writes: boolean } | { readonly ok: false; readonly reason: string };
