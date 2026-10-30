import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { useActionAvailable } from "@table-craft/desktop/renderer/actions/index.js";
import { activityOf } from "@table-craft/desktop/renderer/model/activity.js";
import { formatDuration } from "@table-craft/desktop/renderer/model/format.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { NO_EXECUTIONS, useExecutions } from "@table-craft/desktop/renderer/state/executions.js";
import { activeTab, useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { useClock } from "@table-craft/desktop/renderer/ui/useClock.js";

const CAPSULE_CLASS = "flex h-row shrink-0 items-center gap-1 rounded-full pr-0.5 pl-gap";
const TRANSACTION_TEXT = "Tx open";
const RUNNING_LABEL = "Running";

function Elapsed({ startedAt }: { readonly startedAt: number }) {
  const now = useClock();
  return <span className="tabular-nums">{formatDuration(Math.max(0, now - startedAt))}</span>;
}

/**
 * The title bar's activity capsule (plan 127 decision 8): while the active console runs, its
 * elapsed time and Cancel; while it holds a transaction open, Commit and Rollback; otherwise
 * nothing, so the idle title bar keeps only Run.
 */
export function ActivityCapsule() {
  const tabId = useTabs((state) => activeTab(state)?.id ?? "");
  const session = useConsoles((state) => state.consoles[tabId]);
  const executions = useExecutions((state) => state.byTab[tabId] ?? NO_EXECUTIONS);
  const canCancel = useActionAvailable(ACTION_IDS.cancel);
  const canEnd = useActionAvailable(ACTION_IDS.commit);
  const activity = activityOf(session, executions);
  if (activity.kind === "running") {
    return (
      <div data-testid="activity-capsule" data-kind="running" className={`${CAPSULE_CLASS} bg-selection text-accent`}>
        <span role="status" aria-label={RUNNING_LABEL} className="flex items-center gap-1">
          <SpinnerIcon aria-hidden weight="bold" className="size-icon animate-spin" />
          {activity.startedAt === null ? null : <Elapsed startedAt={activity.startedAt} />}
        </span>
        {canCancel ? <ActionButton actionId={ACTION_IDS.cancel} compact tone="danger" /> : null}
      </div>
    );
  }
  if (activity.kind === "transaction" && canEnd) {
    return (
      <div
        data-testid="activity-capsule"
        data-kind="transaction"
        className={`${CAPSULE_CLASS} bg-warning/20 text-warning`}
      >
        <span aria-hidden className="size-2 rounded-full bg-warning" />
        <span>{TRANSACTION_TEXT}</span>
        <ActionButton actionId={ACTION_IDS.commit} compact tone="success" />
        <ActionButton actionId={ACTION_IDS.rollback} compact tone="danger" />
      </div>
    );
  }
  return null;
}
