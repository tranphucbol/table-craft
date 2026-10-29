import * as Dialog from "@radix-ui/react-dialog";
import { useId, useState } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { MCP_ACTION_IDS, type ApprovalAnswerArgs } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { Button, CONTENT_CLASS, FieldRow, OVERLAY_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { countdown } from "@table-craft/desktop/renderer/model/mcp.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { CAP_CENTRED } from "@table-craft/desktop/renderer/ui/KeyTypeBadge.js";
import { useClock } from "@table-craft/desktop/renderer/ui/useClock.js";
import type { ApprovalKind, McpApprovalView } from "@table-craft/desktop/settings/mcp.js";

const KIND_LABELS: Readonly<Record<ApprovalKind, string>> = {
  write: "Data change",
  ddl: "Schema change",
  other: "Other statement",
};

/** The first keyword names the statement better than its kind, as `UPDATE` or `CALL`. */
const LEADING_KEYWORD = /^\s*([A-Za-z]+)/;

function keywordOf(sql: string): string | null {
  return LEADING_KEYWORD.exec(sql)?.[1]?.toUpperCase() ?? null;
}

function Request({ approval, of }: { readonly approval: McpApprovalView; readonly of: number }) {
  const now = useClock();
  const allowKindId = useId();
  const [allowKind, setAllowKind] = useState(false);
  const leading = keywordOf(approval.sql);
  const keyword = leading ?? KIND_LABELS[approval.kind];
  const answer = (args: ApprovalAnswerArgs["answer"]) =>
    invoke(MCP_ACTION_IDS.answer, { approvalId: approval.id, answer: args } satisfies ApprovalAnswerArgs);
  return (
    <div className="flex flex-col gap-gap p-gap">
      <Dialog.Title className="font-semibold">
        {approval.clientName} wants to change data
        {of > 1 ? <span className="font-normal text-ink-muted"> · 1 of {String(of)}</span> : null}
      </Dialog.Title>
      <div className="grid grid-cols-[8rem_1fr] items-center gap-x-gap gap-y-1">
        <FieldRow label="Data source">
          <span data-testid="mcp-approval-datasource" className="truncate">
            {approval.datasourceName}
          </span>
        </FieldRow>
        <FieldRow label="Kind">
          <span
            className={cn(
              "rounded-sm border px-1 font-mono font-semibold",
              leading !== null && CAP_CENTRED,
              approval.kind === "ddl" || approval.destructive !== null
                ? "border-danger text-danger"
                : "border-warning text-warning",
            )}
          >
            {keyword}
          </span>
          <span className="text-ink-muted">{KIND_LABELS[approval.kind]} · 1 statement</span>
        </FieldRow>
        {approval.destructive === null ? null : <p className="col-start-2 text-danger">{approval.destructive}</p>}
        <FieldRow label="Agent says">
          <span className={cn("min-w-0 wrap-anywhere", approval.reason === null ? "text-ink-muted" : "italic")}>
            {approval.reason ?? "Nothing"}
          </span>
        </FieldRow>
      </div>
      <pre
        data-testid="mcp-approval-sql"
        className="max-h-48 overflow-auto rounded border border-line bg-canvas p-cell font-mono whitespace-pre-wrap select-text"
      >
        {approval.sql}
      </pre>
      {approval.allowable ? (
        <label htmlFor={allowKindId} className="flex items-center gap-cell">
          <input
            id={allowKindId}
            type="checkbox"
            checked={allowKind}
            onChange={(event) => setAllowKind(event.target.checked)}
          />
          Allow {keyword} on {approval.datasourceName} for the rest of this agent session
        </label>
      ) : null}
      <div className="flex items-center gap-gap">
        <span data-testid="mcp-approval-countdown" className="flex-1 text-ink-muted">
          Denied automatically in {countdown(approval.deadline, now)}
        </span>
        <Button
          data-testid="mcp-hand-off"
          title="Open the statement in a console for you to run or change; the agent is told you took it over"
          onClick={() => invoke(MCP_ACTION_IDS.handOff, approval.id)}
        >
          Open in Console
        </Button>
        {/* Deny holds focus so Enter never approves a change. */}
        <Button autoFocus data-testid="mcp-deny" onClick={() => answer("deny")}>
          Deny
        </Button>
        <Button
          variant="primary"
          data-testid="mcp-allow"
          onClick={() => answer(allowKind && approval.allowable ? "allowKind" : "allowOnce")}
        >
          {allowKind && approval.allowable ? "Allow" : "Allow Once"}
        </Button>
      </div>
    </div>
  );
}

/**
 * An agent's write waiting for an answer (plan 117). It opens only from the status bar chip or the
 * palette, never on its own; Escape closes it and leaves the request waiting until its deadline.
 */
export function McpApprovalDialog() {
  const open = useMcp((state) => state.approvalOpen);
  const approvals = useMcp((state) => state.status.approvals);
  const first = approvals[0];
  return (
    <Dialog.Root
      open={open && first !== undefined}
      onOpenChange={(next) => {
        if (!next) useMcp.getState().setApproval(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="mcp-approval"
          className={cn(CONTENT_CLASS, "w-dialog max-w-[95vw]")}
        >
          {first === undefined ? null : <Request key={first.id} approval={first} of={approvals.length} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
