import type { ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import type { Execution } from "@table-craft/desktop/renderer/state/executions.js";

/**
 * What the active console is doing, as the title bar's capsule shows it (plan 127 decision 8):
 * running, with its start when Services has one; holding a transaction open; or nothing.
 */
export type Activity =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly startedAt: number | null }
  | { readonly kind: "transaction" };

const IDLE: Activity = { kind: "idle" };
const TRANSACTION: Activity = { kind: "transaction" };

/** Running wins over an open transaction: Cancel is what a running statement needs within reach. */
export function activityOf(
  session: Pick<ConsoleSession, "status" | "transactionOpen"> | undefined,
  executions: readonly Pick<Execution, "outcome" | "startedAt">[],
): Activity {
  if (session === undefined) return IDLE;
  if (session.status === "running") {
    const running = executions.find((execution) => execution.outcome === "running");
    return { kind: "running", startedAt: running?.startedAt ?? null };
  }
  return session.transactionOpen ? TRANSACTION : IDLE;
}
