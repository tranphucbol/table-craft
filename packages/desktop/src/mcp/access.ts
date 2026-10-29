import type { ClassifiedStatement } from "@table-craft/desktop/engine/protocol.js";
import type { AgentAccess, ApprovalKind } from "@table-craft/desktop/settings/mcp.js";

export type AccessVerdict =
  | { readonly kind: "read" }
  | { readonly kind: "approve"; readonly approval: ApprovalKind; readonly allowable: boolean }
  | { readonly kind: "refuse"; readonly reason: string };

export const NOT_EXPOSED_REASON =
  "This datasource is not exposed to agents. Turn its access on in TableCraft: Settings › MCP Server.";
export const READ_ONLY_REASON =
  "This datasource is read only for agents; the statement would change data. Ask the user to run it, or to set its access to Ask before writes.";
export const ASK_READS_REASON =
  "This datasource lets agents read only with the user's approval; the statement would change data. Ask the user to run it, or to set its access to Ask before writes.";
export const TRANSACTION_REASON = "Transaction statements are refused: every approved statement commits on its own.";

/**
 * What happens to one classified statement under the datasource's effective access. The plugin's
 * classifier is the first guard; the read-only session the read runs on is the second.
 */
export function accessVerdict(access: AgentAccess, statement: ClassifiedStatement): AccessVerdict {
  if (access === "off") return { kind: "refuse", reason: NOT_EXPOSED_REASON };
  if (statement.kind === "transaction") return { kind: "refuse", reason: TRANSACTION_REASON };
  if (access === "askReads") {
    // A read has no destructive case, so "allow reads for the session" is always offered.
    return statement.kind === "read"
      ? { kind: "approve", approval: "read", allowable: true }
      : { kind: "refuse", reason: ASK_READS_REASON };
  }
  if (statement.kind === "read") return { kind: "read" };
  if (access === "read") return { kind: "refuse", reason: READ_ONLY_REASON };
  const allowable = statement.kind !== "ddl" && statement.destructive === null;
  return { kind: "approve", approval: statement.kind, allowable };
}
