import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { TEXT_PRESS } from "@table-craft/desktop/renderer/ui/pressClasses.js";

export interface SegmentedOption<K extends string> {
  readonly value: K;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * The frame of a segmented row: one choice of a few, a view switch or a small tab bar. Every such
 * row in the app is this group of `SEGMENT`s, whatever its role (radios, pressed buttons, tabs).
 * Its `overflow-hidden` drops its automatic minimum size, so a grid that scrolls crushes its row;
 * wrap it in a plain block there.
 */
export const SEGMENT_GROUP = "flex shrink-0 flex-wrap self-start overflow-hidden rounded border border-line";

const SEGMENT_SHAPE = "flex h-segment cursor-default items-center px-gap whitespace-nowrap text-ink";

/**
 * One segment of a `SEGMENT_GROUP`, chosen by `aria-pressed`, `aria-selected` or `aria-checked`.
 * The chosen one carries the accent edge and ink as a pressed toggle does, since the selection
 * fill alone barely shows on Light.
 */
export const SEGMENT = cn(
  TEXT_PRESS,
  SEGMENT_SHAPE,
  "disabled:opacity-50",
  "not-aria-pressed:not-aria-selected:not-aria-checked:enabled:hover:bg-hover",
  "aria-pressed:bg-selection aria-pressed:text-accent aria-pressed:inset-ring aria-pressed:inset-ring-accent",
  "aria-selected:bg-selection aria-selected:text-accent aria-selected:inset-ring aria-selected:inset-ring-accent",
  "aria-checked:bg-selection aria-checked:text-accent aria-checked:inset-ring aria-checked:inset-ring-accent",
);

/**
 * One choice of a few, drawn as a segmented row. Native radios underneath keep the arrow keys,
 * focus and form semantics.
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
    <div role="radiogroup" aria-label={label} data-testid={testId} className={SEGMENT_GROUP}>
      {options.map((option) => (
        <label
          key={option.value}
          data-value={option.value}
          className={cn(
            TEXT_PRESS,
            SEGMENT_SHAPE,
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
