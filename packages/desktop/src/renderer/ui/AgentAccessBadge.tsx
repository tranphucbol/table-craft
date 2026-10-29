import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { AGENT_ACCESS_LABELS, effectiveAccess } from "@table-craft/desktop/settings/mcp.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { CAP_CENTRED } from "@table-craft/desktop/renderer/ui/KeyTypeBadge.js";

/**
 * `AI` beside a datasource agents can reach while the MCP server runs (plan 117): muted for Read
 * only, amber for Ask before writes. Nothing while the server is off or the datasource is Off.
 */
export function AgentAccessBadge({ datasource }: { readonly datasource: DatasourceView }) {
  const running = useMcp((state) => state.status.state === "running");
  const access = effectiveAccess(datasource);
  if (!running || datasource.ephemeral || access === "off") return null;
  return (
    <span
      data-testid="agent-access-badge"
      data-access={access}
      title={`AI agents: ${AGENT_ACCESS_LABELS[access]}`}
      className={cn(
        "shrink-0 rounded-sm border px-0.5 font-mono font-semibold",
        CAP_CENTRED,
        access === "ask" ? "border-warning text-warning" : "border-line text-ink-muted",
      )}
    >
      AI
    </span>
  );
}
