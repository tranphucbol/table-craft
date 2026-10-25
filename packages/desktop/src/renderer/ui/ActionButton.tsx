import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { invoke, registry, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

/**
 * A toolbar button that is an action: its label, icon, tooltip and enabled state come from the
 * registry. `compact` draws the icon alone, the title moving to the tooltip; `reason` replaces the
 * tooltip while the button is off, saying why; `hint` replaces it while on, saying what the action
 * does here. A click never takes focus, so Run leaves the caret
 * where it was (plan 015 decision 8); Tab still reaches the button.
 */
export function ActionButton({
  actionId,
  primary = false,
  compact = false,
  pressed,
  reason,
  hint,
  tone,
}: {
  readonly actionId: string;
  readonly primary?: boolean;
  readonly compact?: boolean;
  readonly pressed?: boolean;
  readonly reason?: string | null;
  readonly hint?: string;
  /** `warning` marks an action that does more than it looks, as Explain Analyse runs its statement. */
  readonly tone?: "warning";
}) {
  const enabled = useActionEnabled(actionId);
  const action = registry.get(actionId);
  if (action === undefined) return null;
  const Icon = action.icon === undefined ? null : ACTION_ICONS[action.icon];
  const shortcut = action.shortcut === undefined ? undefined : formatChord(action.shortcut, currentPlatform());
  return (
    <Tooltip label={!enabled && reason != null ? reason : (hint ?? action.title)} shortcut={shortcut} side="bottom">
      <button
        type="button"
        aria-label={compact ? action.title : undefined}
        aria-pressed={pressed}
        // A disabled button gets no pointer events, so Radix never opens; the native tooltip still does.
        title={!enabled && reason != null ? reason : undefined}
        className={cn(
          "app-no-drag",
          primary
            ? "flex h-row shrink-0 items-center gap-1 rounded bg-accent px-gap whitespace-nowrap text-accent-ink disabled:opacity-50"
            : compact && tone === "warning"
              ? "flex h-row shrink-0 items-center rounded border border-warning px-1 text-warning hover:bg-raised disabled:opacity-50"
              : compact
                ? "flex h-row shrink-0 items-center rounded px-1 text-ink hover:bg-raised disabled:opacity-50 aria-pressed:bg-selection"
                : tone === "warning"
                  ? "flex h-row shrink-0 items-center gap-1 rounded border border-warning px-gap whitespace-nowrap text-warning disabled:opacity-50"
                  : "flex h-row shrink-0 items-center gap-1 rounded border border-line px-gap whitespace-nowrap text-ink disabled:opacity-50",
        )}
        disabled={!enabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => invoke(actionId)}
      >
        {Icon === null ? null : <Icon aria-hidden weight={compact ? "regular" : "fill"} className="size-icon" />}
        {compact ? null : action.title}
      </button>
    </Tooltip>
  );
}
