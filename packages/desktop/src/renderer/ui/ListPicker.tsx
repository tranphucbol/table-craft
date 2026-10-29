import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/** A footer button; it acts on the selected item, and is disabled while there is none unless `always`. */
export interface PickerButton<T> {
  readonly label: string;
  readonly variant?: "primary" | "secondary" | "danger";
  readonly always?: boolean;
  readonly onClick: (item: T | null) => void;
}

/** Where ↑ and ↓ move the selection, clamped to the list. */
export function steppedIndex(length: number, index: number, key: string): number | null {
  if (length === 0) return null;
  if (key === "ArrowDown") return Math.min(index + 1, length - 1);
  if (key === "ArrowUp") return Math.max(index - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

/**
 * A dialog body over a searchable list (plan 011 decision 15): focus stays in the search field,
 * ↑ and ↓ move the selection, Enter chooses it, and the preview shows the selected item whole.
 * Query History and Open Closed Console share it.
 */
export function ListPicker<T>({
  title,
  searchLabel,
  query,
  onQuery,
  items,
  keyOf,
  labelOf,
  renderItem,
  preview,
  empty,
  onChoose,
  buttons,
  onClose,
  filters,
}: {
  readonly title: string;
  readonly searchLabel: string;
  /** Drawn beside the search field, such as a segmented filter. */
  readonly filters?: ReactNode;
  /** Absent, the picker has no search field and the list takes the keyboard. */
  readonly query?: string;
  readonly onQuery?: (query: string) => void;
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
  readonly labelOf: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  readonly preview: (item: T | null) => ReactNode;
  readonly empty: string;
  readonly onChoose: (item: T) => void;
  readonly buttons: readonly PickerButton<T>[];
  readonly onClose: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const found = items.findIndex((item) => keyOf(item) === selectedKey);
  const index = found === -1 ? 0 : found;
  const selected = items[index] ?? null;
  const optionId = (at: number) => `${listId}-${String(at)}`;

  useEffect(() => {
    list.current?.querySelector(`[data-index="${String(index)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, items]);

  function onKeyDown(event: KeyboardEvent): void {
    const next = steppedIndex(items.length, index, event.key);
    if (next !== null) {
      event.preventDefault();
      const item = items[next];
      if (item !== undefined) setSelectedKey(keyOf(item));
    } else if (event.key === "Enter" && selected !== null) {
      event.preventDefault();
      onChoose(selected);
    }
  }

  return (
    <div className="flex flex-col gap-gap p-gap">
      <Dialog.Title className="font-semibold">{title}</Dialog.Title>
      {onQuery === undefined ? null : (
        <div className="flex items-center gap-gap">
          <TextInput
            autoFocus
            role="combobox"
            aria-label={searchLabel}
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={selected === null ? undefined : optionId(index)}
            placeholder="Search"
            className="flex-1"
            value={query ?? ""}
            onKeyDown={onKeyDown}
            onChange={(event) => onQuery(event.target.value)}
          />
          {filters}
        </div>
      )}
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label={title}
        tabIndex={onQuery === undefined ? 0 : -1}
        onKeyDown={onKeyDown}
        autoFocus={onQuery === undefined}
        aria-activedescendant={onQuery === undefined && selected !== null ? optionId(index) : undefined}
        className="h-picker-list overflow-auto rounded border border-line bg-canvas py-1 outline-none focus:border-accent"
      >
        {items.length === 0 ? (
          <li className="px-cell text-ink-muted">{empty}</li>
        ) : (
          items.map((item, at) => (
            <li
              key={keyOf(item)}
              id={optionId(at)}
              data-index={at}
              role="option"
              aria-label={labelOf(item)}
              aria-selected={at === index}
              className={cn(
                "flex h-row cursor-default items-center gap-cell px-cell",
                at === index ? "bg-selection" : "hover:bg-raised",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSelectedKey(keyOf(item))}
              onDoubleClick={() => onChoose(item)}
            >
              {renderItem(item)}
            </li>
          ))
        )}
      </ul>
      {preview(selected)}
      <div className="flex justify-end gap-gap">
        {buttons.map((button) => (
          <Button
            key={button.label}
            variant={button.variant ?? "secondary"}
            disabled={button.always !== true && selected === null}
            onClick={() => button.onClick(selected)}
          >
            {button.label}
          </Button>
        ))}
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}
