import * as Primitive from "@radix-ui/react-select";
import { Fragment } from "react";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { CurrentIcon, DropdownIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { FIELD_CLASS } from "@table-craft/desktop/renderer/ui/fieldClasses.js";
import { SURFACE_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";

const SIDE_OFFSET_PX = 4;

/** The flush rule (plan 129 decision 8): a control filling the strip it sits in has no radius. */
const VARIANT_CLASS = {
  inline:
    "h-row min-w-0 border border-transparent bg-transparent px-1 outline-none hover:border-line focus-visible:border-accent disabled:opacity-50",
  field: FIELD_CLASS,
  cell: "absolute inset-0 w-full border border-accent bg-canvas px-cell font-grid text-grid outline-none",
} as const;

const TONE_CLASS = { ink: "text-ink", warning: "text-warning" } as const;

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** Consecutive options with the same group sit under its heading. */
  readonly group?: string;
}

interface Indexed {
  readonly option: DropdownOption;
  readonly at: number;
}

interface Section {
  readonly group: string | undefined;
  readonly items: readonly Indexed[];
}

/** Runs of options sharing a group, in order; a native `<optgroup>`. */
function sectionsOf(options: readonly DropdownOption[]): readonly Section[] {
  const sections: { group: string | undefined; items: Indexed[] }[] = [];
  options.forEach((option, at) => {
    const last = sections.at(-1);
    if (last !== undefined && last.group === option.group) last.items.push({ option, at });
    else sections.push({ group: option.group, items: [{ option, at }] });
  });
  return sections;
}

function item({ option, at }: Indexed) {
  return (
    <Primitive.Item
      key={option.value}
      value={String(at)}
      data-value={option.value}
      disabled={option.disabled}
      className="flex h-row cursor-default items-center gap-cell rounded-sm px-cell whitespace-nowrap outline-none data-disabled:text-ink-muted data-highlighted:bg-selection"
    >
      <span className="flex size-icon shrink-0 items-center">
        <Primitive.ItemIndicator>
          <CurrentIcon aria-hidden className="size-icon text-accent" />
        </Primitive.ItemIndicator>
      </span>
      <Primitive.ItemText>{option.label}</Primitive.ItemText>
    </Primitive.Item>
  );
}

export interface DropdownProps {
  /** The combobox's accessible name. */
  readonly label: string;
  readonly value: string;
  readonly options: readonly DropdownOption[];
  readonly onChange: (value: string) => void;
  /**
   * `inline` sits in a toolbar or header line and shows its border only on hover and focus, like
   * the icon buttons beside it; `field` stands free in a form; `cell` fills a grid cell being edited.
   */
  readonly variant: keyof typeof VARIANT_CLASS;
  readonly tone?: keyof typeof TONE_CLASS;
  readonly id?: string;
  readonly invalid?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly testId?: string;
  /** Width and layout only. */
  readonly className?: string;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * The app's dropdown (decision 140): a themed list under the trigger instead of the OS menu, with a
 * native select's keyboard. Items carry their index, since Radix reserves the empty string an
 * option's value may be; a value no option has still shows its own text. The trigger and each
 * item carry the real value in `data-value`, which the end-to-end suites read.
 */
export function Dropdown({
  label,
  value,
  options,
  onChange,
  variant,
  tone = "ink",
  id,
  invalid,
  disabled,
  title,
  testId,
  className,
  defaultOpen,
  onOpenChange,
}: DropdownProps) {
  const index = options.findIndex((option) => option.value === value);
  const shown = options[index]?.label ?? value;
  return (
    <Primitive.Root
      value={index < 0 ? "" : String(index)}
      onValueChange={(chosen) => {
        const option = options[Number(chosen)];
        if (option !== undefined && option.value !== value) onChange(option.value);
      }}
      disabled={disabled}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <Primitive.Trigger
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        title={title}
        data-testid={testId}
        data-value={value}
        className={cn(
          VARIANT_CLASS[variant],
          TONE_CLASS[tone],
          "flex items-center gap-1 text-left whitespace-nowrap",
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <Primitive.Value>{shown}</Primitive.Value>
        </span>
        <Primitive.Icon asChild>
          <DropdownIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          position="popper"
          side="bottom"
          align="start"
          sideOffset={SIDE_OFFSET_PX}
          collisionPadding={SIDE_OFFSET_PX}
          className={cn(
            "z-50 max-h-popover-height max-w-popover min-w-(--radix-select-trigger-width) overflow-hidden rounded border border-line bg-raised text-ui text-ink shadow-lg outline-none",
            SURFACE_MOTION,
          )}
        >
          <Primitive.Viewport className="p-1">
            {sectionsOf(options).map((section) =>
              section.group === undefined ? (
                <Fragment key={section.items[0]?.at}>{section.items.map(item)}</Fragment>
              ) : (
                <Primitive.Group key={section.group}>
                  <Primitive.Label className="flex h-row items-center px-cell text-ink-muted">
                    {section.group}
                  </Primitive.Label>
                  {section.items.map(item)}
                </Primitive.Group>
              ),
            )}
          </Primitive.Viewport>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
