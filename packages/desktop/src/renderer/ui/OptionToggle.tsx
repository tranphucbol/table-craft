import { invoke, registry, useActionEnabled } from "@table-craft/desktop/renderer/actions/index.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { PRESSED_TOGGLE } from "@table-craft/desktop/renderer/ui/pressClasses.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

/**
 * A find option toggle drawn as its short label, as DataGrip draws Cc, W and .*; `reason` replaces
 * the tooltip while the option is off, saying why. A click never takes focus from the field.
 */
export function OptionToggle({
  actionId,
  label,
  pressed,
  reason,
  className,
}: {
  readonly actionId: string;
  readonly label: string;
  readonly pressed: boolean;
  readonly reason?: string;
  /** Size and placement only; a row tall when absent. */
  readonly className?: string;
}) {
  const enabled = useActionEnabled(actionId);
  const title = registry.get(actionId)?.title ?? label;
  const tip = !enabled && reason !== undefined ? reason : title;
  return (
    <Tooltip label={tip} side="bottom">
      <button
        type="button"
        aria-label={title}
        aria-pressed={pressed}
        disabled={!enabled}
        // A disabled button gets no pointer events, so Radix never opens; the native tooltip still does.
        title={!enabled && reason !== undefined ? reason : undefined}
        className={cn(
          "shrink-0 rounded px-1 font-grid text-ink hover:bg-raised disabled:opacity-50",
          PRESSED_TOGGLE,
          className ?? "h-row",
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => invoke(actionId)}
      >
        {label}
      </button>
    </Tooltip>
  );
}
