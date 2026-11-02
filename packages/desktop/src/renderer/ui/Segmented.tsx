import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

export interface SegmentedOption<K extends string> {
  readonly value: K;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * One choice of a few, drawn as a segmented row. Native radios underneath keep the arrow keys,
 * focus and form semantics; the chosen segment carries the accent edge and ink as a pressed toggle
 * does, since the selection fill alone barely shows on Light.
 */
export function Segmented<K extends string>({
  name,
  label,
  options,
  value,
  onChange,
  testId,
}: {
  readonly name: string;
  /** The group's accessible name, when no enclosing fieldset gives one. */
  readonly label?: string;
  readonly options: readonly SegmentedOption<K>[];
  readonly value: K;
  readonly onChange: (value: K) => void;
  readonly testId?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className="flex shrink-0 self-start rounded border border-line"
    >
      {options.map((option) => (
        <label
          key={option.value}
          data-value={option.value}
          className={cn(
            TEXT_PRESS,
            "flex h-row cursor-default items-center px-gap whitespace-nowrap text-ink first:rounded-l last:rounded-r",
            "has-checked:bg-selection has-checked:text-accent has-checked:inset-ring has-checked:inset-ring-accent",
            "not-has-checked:hover:bg-hover has-disabled:opacity-50",
            "has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-accent",
          )}
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
