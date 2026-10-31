import { useActionEnabled, invoke, registry } from "@table-craft/desktop/renderer/actions/index.js";
import { formatChord, currentPlatform } from "@table-craft/desktop/renderer/actions/chords.js";
import { useLayout, type ToolWindowId } from "@table-craft/desktop/renderer/state/layout.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

export interface StripeButton {
  readonly toolWindow: ToolWindowId;
  readonly actionId: string;
}

export interface StripeAction {
  readonly actionId: string;
}

export type StripeEntry = StripeButton | StripeAction;

function ToolWindowButton({ toolWindow, actionId }: StripeButton) {
  const action = registry.get(actionId);
  const open = useLayout((state) => state.layout.visible[toolWindow]);
  const enabled = useActionEnabled(actionId);
  if (action === undefined) return null;
  const Icon = action.icon === undefined ? null : ACTION_ICONS[action.icon];
  const shortcut = action.shortcut === undefined ? undefined : formatChord(action.shortcut, currentPlatform());
  return (
    <Tooltip label={action.title} shortcut={shortcut}>
      <button
        type="button"
        aria-label={action.title}
        aria-pressed={open}
        disabled={!enabled}
        className={cn(
          "flex size-tab items-center justify-center rounded text-ink-muted hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
        )}
        onClick={() => invoke(actionId)}
      >
        {Icon === null ? action.title : <Icon aria-hidden className="size-icon" />}
      </button>
    </Tooltip>
  );
}

function ActionButton2({ actionId }: StripeAction) {
  const action = registry.get(actionId);
  const enabled = useActionEnabled(actionId);
  if (action === undefined) return null;
  const Icon = action.icon === undefined ? null : ACTION_ICONS[action.icon];
  const shortcut = action.shortcut === undefined ? undefined : formatChord(action.shortcut, currentPlatform());
  return (
    <Tooltip label={action.title} shortcut={shortcut}>
      <button
        type="button"
        aria-label={action.title}
        disabled={!enabled}
        className="flex size-tab items-center justify-center rounded text-ink-muted hover:bg-raised hover:text-ink"
        onClick={() => invoke(actionId)}
      >
        {Icon === null ? action.title : <Icon aria-hidden className="size-icon" />}
      </button>
    </Tooltip>
  );
}

export interface StripeProps {
  readonly side: "left" | "right";
  readonly top?: readonly StripeEntry[];
  readonly bottom?: readonly StripeEntry[];
}

/** The column of tool-window buttons at a window edge; each button is an action (decision 015). */
export function Stripe({ side, top = [], bottom = [] }: StripeProps) {
  return (
    <nav
      aria-label={`${side === "left" ? "Left" : "Right"} tool window stripe`}
      className={cn(
        "flex w-stripe shrink-0 flex-col items-center justify-between bg-panel py-1",
        side === "left" ? "border-r border-line" : "border-l border-line",
      )}
    >
      <div className="flex flex-col gap-1">
        {top.map((entry, i) =>
          "toolWindow" in entry ? (
            <ToolWindowButton key={entry.toolWindow} {...entry} />
          ) : (
            <ActionButton2 key={entry.actionId + i} actionId={entry.actionId} />
          ),
        )}
      </div>
      <div className="flex flex-col gap-1">
        {bottom.map((entry, i) =>
          "toolWindow" in entry ? (
            <ToolWindowButton key={entry.toolWindow} {...entry} />
          ) : (
            <ActionButton2 key={entry.actionId + i} actionId={entry.actionId} />
          ),
        )}
      </div>
    </nav>
  );
}
