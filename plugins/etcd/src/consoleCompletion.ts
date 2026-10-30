import type { Session } from "@table-craft/plugin-api";
import { hexId } from "./args.js";
import type { ParameterDoc } from "./docs.js";

const MAX_SUGGESTIONS = 100;
export interface ConsoleValueSuggestion {
  readonly label: string;
  readonly apply: string;
  readonly detail?: string;
}

/** Service-backed suggestions only; key paths use the namespace-scoped suggestKeys hook. */
export async function suggestConsoleValues(
  session: Pick<Session, "leases" | "access" | "cluster">,
  kind: NonNullable<ParameterDoc["completion"]>,
  prefix: string,
  currentRevision?: () => Promise<string>,
): Promise<readonly ConsoleValueSuggestion[]> {
  let values: ConsoleValueSuggestion[] = [];
  switch (kind) {
    case "lease":
      values = ((await session.leases?.list()) ?? []).map((lease) => {
        const id = hexId(BigInt.asUintN(64, BigInt(lease.id)).toString());
        return {
          label: id,
          apply: id,
          detail: `global lease; TTL ${lease.remainingTtlSeconds === null ? "unknown" : `${lease.remainingTtlSeconds}s`}`,
        };
      });
      break;
    case "user":
      values = ((await session.access?.users()) ?? []).map((user) => ({ label: user.name, apply: user.name }));
      break;
    case "role":
      values = ((await session.access?.roles()) ?? []).map((role) => ({ label: role.name, apply: role.name }));
      break;
    case "member":
      values = ((await session.cluster?.members()) ?? []).map((member) => ({
        label: member.id,
        apply: member.id,
        detail: member.name,
      }));
      break;
    case "endpoint":
      values = ((await session.cluster?.endpoints()) ?? []).map((endpoint) => ({
        label: endpoint.label,
        apply: endpoint.id,
      }));
      break;
    case "revision":
      if (currentRevision !== undefined)
        values = [{ label: "current", apply: await currentRevision(), detail: "current revision" }];
      break;
  }
  return values
    .filter((value) => value.apply.startsWith(prefix) || value.label.startsWith(prefix))
    .slice(0, MAX_SUGGESTIONS);
}
