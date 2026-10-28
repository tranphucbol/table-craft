import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { invoke, registry, useActionBusy, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS, CopiedIcon, SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { FILLED_PRESS, TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";
import { COPIED_LABEL, useCopyConfirmation } from "@table-craft/desktop/renderer/ui/useCopyConfirmation.js";
import { useDelayedFlag } from "@table-craft/desktop/renderer/ui/useDelayedFlag.js";

/** Long enough that a fast query never swaps the icon (plan 112 decision 3). */
const BUSY_SPINNER_DELAY_MS = 300;

/**
 * A toolbar button that is an action: its label, icon, tooltip, enabled and busy state come from
 * the registry; a busy action spins at full strength once busy has lasted a moment. `compact` draws the icon alone, the title moving to the tooltip; `reason` replaces the
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
  const busy = useDelayedFlag(useActionBusy(actionId), BUSY_SPINNER_DELAY_MS);
  const confirmation = useCopyConfirmation();
  const action = registry.get(actionId);
  if (action === undefined) return null;
  const copies = action.icon === "copy";
  const copied = copies && confirmation.copied;
  const Icon = copied ? CopiedIcon : busy ? SpinnerIcon : action.icon === undefined ? null : ACTION_ICONS[action.icon];
  const shortcut = action.shortcut === undefined ? undefined : formatChord(action.shortcut, currentPlatform());
  return (
    <Tooltip
      label={copied ? COPIED_LABEL : !enabled && reason != null ? reason : (hint ?? action.title)}
      shortcut={shortcut}
      side="bottom"
    >
      <button
        type="button"
        aria-label={compact ? action.title : undefined}
        aria-pressed={pressed}
        aria-busy={busy ? true : undefined}
        data-copied={copied ? "" : undefined}
        // A disabled button gets no pointer events, so Radix never opens; the native tooltip still does.
        title={!enabled && reason != null ? reason : undefined}
        className={cn(
          "app-no-drag",
          primary
            ? `${FILLED_PRESS} flex h-row shrink-0 items-center gap-1 rounded bg-accent px-gap whitespace-nowrap text-accent-ink disabled:not-aria-busy:opacity-50`
            : compact && tone === "warning"
              ? "press flex h-row shrink-0 items-center rounded border border-warning px-1 text-warning hover:bg-raised disabled:not-aria-busy:opacity-50"
              : compact
                ? "press flex h-row shrink-0 items-center rounded px-1 text-ink hover:bg-raised disabled:not-aria-busy:opacity-50 aria-pressed:bg-selection"
                : tone === "warning"
                  ? `${TEXT_PRESS} flex h-row shrink-0 items-center gap-1 rounded border border-warning px-gap whitespace-nowrap text-warning hover:bg-raised disabled:not-aria-busy:opacity-50`
                  : `${TEXT_PRESS} flex h-row shrink-0 items-center gap-1 rounded border border-line px-gap whitespace-nowrap text-ink hover:bg-raised disabled:not-aria-busy:opacity-50`,
        )}
        disabled={!enabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (copies) confirmation.arm();
          invoke(actionId);
        }}
      >
        {Icon === null ? null : (
          <Icon
            aria-hidden
            weight={copied || busy ? "bold" : compact ? "regular" : "fill"}
            className={cn("size-icon", copied && "text-success", busy && "animate-spin")}
          />
        )}
        {compact ? null : action.title}
      </button>
    </Tooltip>
  );
}
