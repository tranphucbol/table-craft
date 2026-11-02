import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Namespace } from "@table-craft/desktop/engine/protocol.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { NAMESPACE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/namespaceActions.js";
import { TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { namespaceLabel } from "@table-craft/desktop/renderer/model/format.js";
import {
  switchBlocked,
  switcherGroups,
  type SwitcherRow,
} from "@table-craft/desktop/renderer/model/namespaceSwitcher.js";
import type { ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import { useNamespaceSwitcher } from "@table-craft/desktop/renderer/state/namespaceSwitcher.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { CurrentIcon, DropdownIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { steppedIndex } from "@table-craft/desktop/renderer/ui/ListPicker.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

const UNKNOWN_NAMESPACE = "—";
const SWITCH_TOOLTIP = "Switch database or schema";
const ROW_CLASS = "flex h-row cursor-default items-center gap-cell rounded px-gap whitespace-nowrap";

function pick(namespace: Namespace): void {
  void invoke(NAMESPACE_ACTION_IDS.switchNamespace, { path: namespace.path });
}

function Row({ row, selected, onHover }: { row: SwitcherRow; selected: boolean; onHover: () => void }) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-current={row.current}
      data-testid="namespace-switcher-option"
      className={cn(
        ROW_CLASS,
        selected ? "bg-selection" : "hover:bg-selection",
        row.namespace.system && "text-ink-muted",
      )}
      onMouseEnter={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => pick(row.namespace)}
    >
      <span className="flex size-icon shrink-0 items-center">
        {row.current ? <CurrentIcon aria-label="current" className="size-icon text-accent" /> : null}
      </span>
      <span title={row.namespace.path.join(".")}>{row.namespace.name}</span>
    </div>
  );
}

function SwitcherList({ session, anchor }: { readonly session: ConsoleSession; readonly anchor: PopoverAnchor }) {
  const { targets, loading, error, hide, load } = useNamespaceSwitcher();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const groups = switcherGroups(targets, session.namespace, query);
  const rows = [...groups.regular, ...groups.system];
  const chosen = Math.min(selected, Math.max(rows.length - 1, 0));

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const next = steppedIndex(rows.length, chosen, event.key);
    if (next !== null) {
      event.preventDefault();
      setSelected(next);
      return;
    }
    const row = rows[chosen];
    if (event.key === "Enter" && row !== undefined) {
      event.preventDefault();
      pick(row.namespace);
    }
  }

  const rowOf = (row: SwitcherRow, index: number) => (
    <Row key={row.namespace.path.join(".")} row={row} selected={index === chosen} onHover={() => setSelected(index)} />
  );
  return (
    <Popover anchor={anchor} label="Switch database or schema" testId="namespace-switcher" onClose={hide}>
      <div className="p-gap">
        <TextInput
          autoFocus
          aria-label="Filter"
          placeholder="Filter"
          data-testid="namespace-switcher-filter"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div role="listbox" aria-label="Databases and schemas" className="min-h-0 flex-1 overflow-y-auto p-1">
        {groups.regular.map((row, index) => rowOf(row, index))}
        {groups.system.length > 0 && groups.regular.length > 0 ? (
          <div role="separator" className="my-1 border-t border-line" />
        ) : null}
        {groups.system.map((row, index) => rowOf(row, groups.regular.length + index))}
        {loading ? <div className={cn(ROW_CLASS, "text-ink-muted")}>Loading…</div> : null}
        {!loading && error === null && rows.length === 0 ? (
          <div className={cn(ROW_CLASS, "text-ink-muted")}>Nothing matches</div>
        ) : null}
        {error === null ? null : (
          <div role="alert" className="max-w-popover px-cell py-1 whitespace-normal text-danger">
            {error.message} <span className="text-ink-muted">{error.hint}</span>
          </div>
        )}
      </div>
      <div className="border-t border-line p-1">
        <button
          type="button"
          data-testid="namespace-switcher-refresh"
          className={cn(ROW_CLASS, "w-full text-accent hover:bg-selection")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void load(true)}
        >
          Refresh
        </button>
      </div>
    </Popover>
  );
}

/**
 * The toolbar's namespace label as a dropdown (decision 060): it lists what the console's session
 * can switch to and runs the plugin's switch statement for the one picked.
 */
export function NamespaceSwitcher({ consoleId, session }: { consoleId: string; session: ConsoleSession }) {
  const open = useNamespaceSwitcher((state) => state.consoleId === consoleId);
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const namespace = namespaceLabel(session.namespace);
  const blocked = switchBlocked(session);

  useLayoutEffect(() => {
    if (!open || button.current === null) {
      setAnchor(null);
      return;
    }
    const { left, top, right, bottom } = button.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  }, [open]);

  return (
    <>
      <Tooltip
        label={blocked === null ? `${SWITCH_TOOLTIP} (${namespace?.title ?? "unknown"})` : blocked}
        side="bottom"
      >
        <button
          ref={button}
          type="button"
          data-testid="console-namespace-switcher"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-disabled={blocked !== null}
          className={cn(
            "flex min-w-0 items-center gap-1 rounded px-1 text-ink",
            blocked === null ? "hover:bg-hover" : "cursor-default opacity-50",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (blocked === null) void invoke(NAMESPACE_ACTION_IDS.switchNamespace);
          }}
        >
          {namespace === null ? (
            <span className="text-ink-muted">{UNKNOWN_NAMESPACE}</span>
          ) : (
            <span data-testid="console-namespace" className="min-w-0 truncate" title={namespace.title}>
              {namespace.text}
            </span>
          )}
          <DropdownIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
        </button>
      </Tooltip>
      {open && anchor !== null ? <SwitcherList session={session} anchor={anchor} /> : null}
    </>
  );
}
