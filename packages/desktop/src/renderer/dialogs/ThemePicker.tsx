import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { BUILT_IN_THEMES, BUNDLED_THEMES, type ColorTokens } from "@table-craft/desktop/appearance/themes.js";
import { TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  chosenOption,
  themePickerGroups,
  type ThemePickerOption,
} from "@table-craft/desktop/renderer/model/themePicker.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { CurrentIcon, DropdownIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { steppedIndex } from "@table-craft/desktop/renderer/ui/ListPicker.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import type { ThemeChoice } from "@table-craft/desktop/settings/settings.js";

const BUNDLED = Object.values(BUNDLED_THEMES);
const ROW_CLASS = "flex h-row cursor-default items-center gap-cell px-cell whitespace-nowrap";
const SWATCH_TOKENS: readonly (keyof Pick<ColorTokens, "canvas" | "panel" | "ink" | "accent">)[] = [
  "canvas",
  "panel",
  "ink",
  "accent",
];
const SCHEME_LABEL = { dark: "Dark", light: "Light" } as const;
const FOLLOW_SYSTEM: ThemeChoice = "system";

/** Follow system's swatch: Light's canvas beside Dark's, the two it switches between (plan 130 decision 20). */
const FOLLOW_SYSTEM_HALVES = [BUILT_IN_THEMES.light.colors.canvas, BUILT_IN_THEMES.dark.colors.canvas] as const;

function Swatch({ option }: { readonly option: ThemePickerOption }) {
  const { colors } = option;
  if (option.choice === FOLLOW_SYSTEM) {
    return (
      <span aria-hidden className="flex shrink-0 overflow-hidden rounded-sm border border-line">
        {FOLLOW_SYSTEM_HALVES.map((color) => (
          <span key={color} className="h-2.5 w-5" style={{ backgroundColor: color }} />
        ))}
      </span>
    );
  }
  if (colors === null) return <span aria-hidden className="w-10 shrink-0" />;
  return (
    <span aria-hidden className="flex shrink-0 overflow-hidden rounded-sm border border-line">
      {SWATCH_TOKENS.map((token) => (
        <span key={token} className="size-2.5" style={{ backgroundColor: colors[token] }} />
      ))}
    </span>
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function ErrorList({ option }: { readonly option: ThemePickerOption }) {
  if (option.errors === null) return null;
  return (
    <ul aria-label={`Errors in ${option.name}`} className="flex flex-col px-cell py-1 whitespace-normal text-danger">
      {option.errors.map((error) => (
        <li key={error} className="break-words">
          {error}
        </li>
      ))}
    </ul>
  );
}

function Row({
  option,
  highlighted,
  chosen,
  onHover,
  onPick,
}: {
  readonly option: ThemePickerOption;
  readonly highlighted: boolean;
  readonly chosen: boolean;
  readonly onHover: () => void;
  readonly onPick: () => void;
}) {
  const broken = option.errors !== null;
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (highlighted) row.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  return (
    <div
      ref={row}
      role="option"
      aria-label={option.name}
      aria-selected={highlighted}
      aria-checked={chosen}
      aria-disabled={broken}
      data-theme={option.choice}
      title={option.licence === null ? undefined : `${option.source ?? ""} (${option.licence})`}
      className={cn(ROW_CLASS, highlighted ? "bg-selection" : !broken && "hover:bg-panel", broken && "text-ink-muted")}
      onMouseEnter={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
    >
      <span className="flex size-icon shrink-0 items-center">
        {chosen ? <CurrentIcon aria-label="chosen" className="size-icon text-accent" /> : null}
      </span>
      <Swatch option={option} />
      <span className="min-w-0 flex-1 truncate">{option.name}</span>
      {broken ? (
        <span className="shrink-0 text-danger">{plural(option.errors?.length ?? 0, "error")}</span>
      ) : option.source === null ? null : (
        <span className="min-w-0 shrink truncate text-ink-muted">{option.source}</span>
      )}
    </div>
  );
}

function ThemeList({
  anchor,
  chosen,
  onClose,
}: {
  readonly anchor: PopoverAnchor;
  readonly chosen: ThemeChoice;
  readonly onClose: () => void;
}) {
  const userThemes = useSettings((state) => state.themes);
  const [filter, setFilter] = useState("");
  const groups = themePickerGroups(BUNDLED, userThemes, filter);
  const options = groups.flatMap((group) => group.options);
  const [highlight, setHighlight] = useState(() =>
    Math.max(
      options.findIndex((option) => option.choice === chosen),
      0,
    ),
  );
  const index = Math.min(highlight, Math.max(options.length - 1, 0));
  const highlighted = options[index];
  const previewed = highlighted === undefined || highlighted.errors !== null ? null : highlighted.choice;

  useEffect(() => {
    useSettings.getState().preview(previewed);
  }, [previewed]);
  useEffect(() => () => useSettings.getState().preview(null), []);

  function pick(option: ThemePickerOption | undefined) {
    if (option === undefined || option.errors !== null) return;
    useSettings.getState().preview(null);
    void useSettings
      .getState()
      .update((current) => ({ ...current, appearance: { ...current.appearance, theme: option.choice } }));
    onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const next = steppedIndex(options.length, index, event.key);
    if (next !== null) {
      event.preventDefault();
      setHighlight(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick(highlighted);
    }
  }

  const starts = groups.map((_, position) =>
    groups.slice(0, position).reduce((sum, group) => sum + group.options.length, 0),
  );
  return (
    <Popover anchor={anchor} label="Themes" testId="theme-picker" onClose={onClose}>
      <div className="flex min-h-0 flex-col" style={{ width: anchor.right - anchor.left }}>
        <div className="p-gap">
          <TextInput
            autoFocus
            className="w-full"
            aria-label="Filter themes"
            placeholder="Filter by name or source"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div role="listbox" aria-label="Themes" className="min-h-0 flex-1 overflow-y-auto">
          {groups.map((group, groupIndex) => {
            const start = starts[groupIndex] ?? 0;
            return (
              <div key={group.label} role="group" aria-label={group.label}>
                <div role="presentation" className="px-cell pt-1 font-semibold text-ink-muted">
                  {group.label}
                </div>
                {group.options.map((option, position) => (
                  <Row
                    key={option.choice}
                    option={option}
                    highlighted={start + position === index}
                    chosen={option.choice === chosen}
                    onHover={() => setHighlight(start + position)}
                    onPick={() => pick(option)}
                  />
                ))}
              </div>
            );
          })}
          {options.length === 0 ? <div className={cn(ROW_CLASS, "text-ink-muted")}>No theme matches</div> : null}
        </div>
        {highlighted === undefined || highlighted.errors === null ? null : (
          <div className="border-t border-line">
            <ErrorList option={highlighted} />
          </div>
        )}
      </div>
    </Popover>
  );
}

/**
 * Settings → Appearance's theme control (decision 065): the chosen theme as a button that opens a
 * filterable list of every theme. The highlighted theme is drawn at once and kept only when picked;
 * Escape, a click outside or closing Settings puts the chosen one back.
 */
export function ThemePicker() {
  const choice = useSettings((state) => state.settings.appearance.theme);
  const userThemes = useSettings((state) => state.themes);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const chosen = chosenOption(choice, BUNDLED, userThemes);

  useLayoutEffect(() => {
    if (!open || button.current === null) {
      setAnchor(null);
      return;
    }
    const { left, top, right, bottom } = button.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  }, [open]);

  return (
    <div className="flex flex-col gap-1">
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Theme: ${chosen.name}`}
        data-testid="theme-picker-trigger"
        data-theme={chosen.choice}
        className="flex h-row w-full max-w-popover items-center gap-cell rounded border border-line bg-canvas px-cell text-left hover:bg-raised"
        onClick={() => setOpen((value) => !value)}
      >
        <Swatch option={chosen} />
        <span className="min-w-0 flex-1 truncate">{chosen.name}</span>
        {chosen.colorScheme === null ? null : (
          <span className="shrink-0 border border-line px-1 text-ink-muted">{SCHEME_LABEL[chosen.colorScheme]}</span>
        )}
        <DropdownIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
      </button>
      {chosen.errors === null ? null : <ErrorList option={chosen} />}
      {open && anchor !== null ? <ThemeList anchor={anchor} chosen={choice} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
