import type { ReactNode } from "react";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { ServerMessage } from "@table-craft/desktop/engine/protocol.js";
import { ConsoleResult } from "@table-craft/desktop/renderer/console/ConsoleResult.js";
import { OutputLog } from "@table-craft/desktop/renderer/console/OutputLog.js";
import { PlanView } from "@table-craft/desktop/renderer/console/PlanView.js";
import {
  activeTabOf,
  OUTPUT_TAB,
  useConsoles,
  type ConsoleSession,
  type ConsoleTab,
} from "@table-craft/desktop/renderer/state/consoles.js";
import {
  serverMessagesTooltip,
  warningCount,
  warningsText,
} from "@table-craft/desktop/renderer/model/serverMessages.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { TAB_FOCUS_RING } from "@table-craft/desktop/renderer/ui/focusRing.js";
import { ACTION_ICONS, WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";

const OUTPUT_TITLE = "Output";
const PinIcon = ACTION_ICONS.pin;

function TabButton({
  selected,
  title,
  kind,
  tooltip,
  onSelect,
  children,
}: {
  readonly selected: boolean;
  readonly title: string;
  readonly kind?: ConsoleTab["kind"];
  readonly tooltip?: string;
  readonly onSelect: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div
      role="tab"
      aria-selected={selected}
      data-kind={kind}
      tabIndex={selected ? 0 : -1}
      title={tooltip}
      className={cn(
        "flex h-full shrink-0 cursor-default items-center gap-1 border-r border-b-2 border-r-line px-gap",
        TAB_FOCUS_RING,
        selected ? "border-b-accent bg-canvas text-ink" : "border-b-transparent text-ink-muted hover:bg-raised",
      )}
      onMouseDown={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
    >
      {title}
      {children}
    </div>
  );
}

/** How many warnings the server left on the tab's statement, with each one in the tooltip (decision 066). */
function WarningBadge({ messages }: { readonly messages: readonly ServerMessage[] | undefined }) {
  const count = warningCount(messages);
  if (messages === undefined || count === 0) return null;
  return (
    <span
      role="status"
      aria-label={warningsText(count)}
      title={serverMessagesTooltip(messages)}
      data-testid="warning-badge"
      className="flex items-center gap-px text-warning tabular-nums"
    >
      <WarningIcon aria-hidden weight="fill" className="size-icon" />
      {count}
    </span>
  );
}

/**
 * The console's lower half (plan 006 decision 10): `Output`, then a tab per row-returning
 * statement of the last run, or the plan of the last explain, plus any pinned ones, each with its
 * statement as tooltip.
 */
export function ResultTabs({ consoleId, session }: { readonly consoleId: string; readonly session: ConsoleSession }) {
  const showResult = useConsoles((state) => state.showResult);
  const active = activeTabOf(session);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Results"
        className="flex h-row shrink-0 overflow-x-auto overflow-y-hidden border-b border-line bg-panel"
      >
        <TabButton selected={active === null} title={OUTPUT_TITLE} onSelect={() => showResult(consoleId, OUTPUT_TAB)} />
        {session.results.map((result) => (
          <TabButton
            key={result.id}
            selected={active?.id === result.id}
            title={result.title}
            kind={result.kind}
            tooltip={result.sql}
            onSelect={() => showResult(consoleId, result.id)}
          >
            <WarningBadge messages={result.kind === "rows" ? result.messages : result.plan.messages} />
            <button
              type="button"
              tabIndex={-1}
              aria-label={result.pinned ? `Unpin ${result.title}` : `Pin ${result.title}`}
              aria-pressed={result.pinned}
              className={cn(
                "flex items-center",
                result.pinned ? "text-accent" : "text-ink-muted opacity-60 hover:opacity-100",
              )}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => {
                showResult(consoleId, result.id);
                invoke(ACTION_IDS.pinResult, { resultId: result.id });
              }}
            >
              <PinIcon aria-hidden weight={result.pinned ? "fill" : "regular"} className="size-icon" />
            </button>
          </TabButton>
        ))}
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {active === null ? (
          <OutputLog entries={session.output} datasourceId={session.datasourceId} />
        ) : active.kind === "plan" ? (
          <PlanView key={active.id} consoleId={consoleId} plan={active} />
        ) : (
          <ConsoleResult key={active.id} consoleId={consoleId} session={session} result={active} />
        )}
      </div>
    </div>
  );
}
