import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/** An on/off control that applies at once, as a `role="switch"` button; a checkbox reads as a form choice. */
export function Switch({
  id,
  checked,
  label,
  testId,
  onChange,
}: {
  readonly id?: string;
  readonly checked: boolean;
  readonly label: string;
  readonly testId?: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      className={cn(
        "press relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors",
        checked ? "border-accent bg-accent" : "border-line bg-raised",
      )}
      onClick={() => onChange(!checked)}
    >
      <span
        aria-hidden
        className={cn(
          "absolute size-3 rounded-full transition-transform",
          checked ? "translate-x-3.5 bg-accent-ink" : "translate-x-0.5 bg-ink-muted",
        )}
      />
    </button>
  );
}
