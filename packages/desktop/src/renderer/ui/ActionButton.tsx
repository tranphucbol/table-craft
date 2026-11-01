import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { invoke, registry, useActionBusy, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import type { ActionIcon } from "@table-craft/desktop/renderer/actions/registry.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS, CopiedIcon, SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { FILLED_PRESS, PRESSED_TOGGLE, TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";
import { COPIED_LABEL, useCopyConfirmation } from "@table-craft/desktop/renderer/ui/useCopyConfirmation.js";
import { useDelayedFlag } from "@table-craft/desktop/renderer/ui/useDelayedFlag.js";

/** Long enough that a fast query never swaps the icon (plan 112 decision 3). */
const BUSY_SPINNER_DELAY_MS = 300;

export type ActionTone = "warning" | "success" | "danger";

const PRIMARY_CLASS = `${FILLED_PRESS} flex h-row shrink-0 items-center gap-1 rounded bg-accent px-gap whitespace-nowrap text-accent-ink disabled:not-aria-busy:opacity-50`;
const COMPACT_CLASS = `press flex h-row shrink-0 items-center rounded px-1 text-ink hover:bg-raised disabled:not-aria-busy:opacity-50 ${PRESSED_TOGGLE}`;
const TEXT_CLASS = `${TEXT_PRESS} flex h-row shrink-0 items-center gap-1 rounded border border-line px-gap whitespace-nowrap text-ink hover:bg-raised disabled:not-aria-busy:opacity-50`;
const WARNING_COMPACT_CLASS =
  "press flex h-row shrink-0 items-center rounded border border-warning px-1 text-warning hover:bg-raised disabled:not-aria-busy:opacity-50";
const WARNING_TEXT_CLASS = `${TEXT_PRESS} flex h-row shrink-0 items-center gap-1 rounded border border-warning px-gap whitespace-nowrap text-warning hover:bg-raised disabled:not-aria-busy:opacity-50`;
/** Success and danger colour a compact icon only while it can be pressed, so an idle toolbar stays quiet. */
const ICON_TONE: Readonly<Record<Exclude<ActionTone, "warning">, string>> = {
  success: "enabled:text-success",
  danger: "enabled:text-danger",
};

/** A text button's icon carries the tone, its label stays ink. */
const TEXT_ICON_TONE: Readonly<Record<Exclude<ActionTone, "warning">, string>> = {
  success: "text-success",
  danger: "text-danger",
};

function buttonClass(primary: boolean, compact: boolean, tone: ActionTone | undefined): string {
  if (primary) return PRIMARY_CLASS;
  if (tone === "warning") return compact ? WARNING_COMPACT_CLASS : WARNING_TEXT_CLASS;
  if (!compact) return TEXT_CLASS;
  return tone === undefined ? COMPACT_CLASS : cn(COMPACT_CLASS, ICON_TONE[tone]);
}

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
  icon,
}: {
  readonly actionId: string;
  readonly primary?: boolean;
  readonly compact?: boolean;
  readonly pressed?: boolean;
  readonly reason?: string | null;
  readonly hint?: string;
  /**
   * `warning` marks an action that does more than it looks, as Explain Analyse runs its statement;
   * `success` and `danger` colour the icon of a button that starts or ends work, as Run and Cancel.
   */
  readonly tone?: ActionTone;
  /** Draws another glyph than the action's own, as the tab strip's New Console reads as `+`. */
  readonly icon?: ActionIcon;
}) {
  const enabled = useActionEnabled(actionId);
  const busy = useDelayedFlag(useActionBusy(actionId), BUSY_SPINNER_DELAY_MS);
  const confirmation = useCopyConfirmation();
  const action = registry.get(actionId);
  if (action === undefined) return null;
  const copies = action.icon === "copy";
  const copied = copies && confirmation.copied;
  const glyph = icon ?? action.icon;
  const Icon = copied ? CopiedIcon : busy ? SpinnerIcon : glyph === undefined ? null : ACTION_ICONS[glyph];
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
        className={cn("app-no-drag", buttonClass(primary, compact, tone))}
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
            className={cn(
              "size-icon",
              !compact && enabled && tone !== undefined && tone !== "warning" && TEXT_ICON_TONE[tone],
              copied && "text-success",
              busy && "animate-spin",
            )}
          />
        )}
        {compact ? null : action.title}
      </button>
    </Tooltip>
  );
}
