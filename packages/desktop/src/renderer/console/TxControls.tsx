import type { TransactionMode } from "@table-craft/desktop/engine/protocol.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { invoke, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import type { ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";

const MODE_LABEL: Readonly<Record<TransactionMode, string>> = { auto: "Tx: Auto", manual: "Tx: Manual" };
const MODE_OPTIONS = (["auto", "manual"] as const).map((mode) => ({ value: mode, label: MODE_LABEL[mode] }));
const OPEN_STATUS = "transaction open";

/**
 * The console's transaction group (plan 127 decision 3): a borderless mode picker, then Commit and
 * Rollback as icons. An open transaction turns the mode warning-coloured with a dot; its words stay
 * for screen readers alone.
 */
export function TxControls({ session }: { readonly session: Pick<ConsoleSession, "txMode" | "transactionOpen"> }) {
  const canToggle = useActionEnabled(ACTION_IDS.toggleTransactionMode);
  const open = session.transactionOpen;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <span className="flex items-center gap-1">
        {open ? <span aria-hidden data-testid="transaction-dot" className="size-2 rounded-full bg-warning" /> : null}
        <Dropdown
          label="Transaction mode"
          title="Auto commits every statement; Manual keeps a transaction open until Commit or Rollback."
          variant="inline"
          tone={open ? "warning" : "ink"}
          value={session.txMode}
          options={MODE_OPTIONS}
          disabled={!canToggle}
          onChange={(chosen) => {
            if (chosen !== session.txMode) void invoke(ACTION_IDS.toggleTransactionMode);
          }}
        />
      </span>
      <ActionButton actionId={ACTION_IDS.commit} compact tone="success" />
      <ActionButton actionId={ACTION_IDS.rollback} compact tone="danger" />
      {open ? (
        <span role="status" className="sr-only">
          {OPEN_STATUS}
        </span>
      ) : null}
    </div>
  );
}
