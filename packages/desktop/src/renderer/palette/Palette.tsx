import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { invoke, registry } from "@table-craft/desktop/renderer/actions/index.js";
import type { OpenTableArgs } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { TABLE_ACTION_IDS } from "@table-craft/desktop/renderer/actions/tableActions.js";
import {
  paletteResults,
  paletteTabs,
  type PaletteMode,
  type SearchItem,
  type SearchProvider,
} from "@table-craft/desktop/renderer/model/palette.js";
import { ACTIONS_PROVIDER_ID, actionsProvider } from "@table-craft/desktop/renderer/palette/providers.js";
import { keysProvider } from "@table-craft/desktop/renderer/palette/keysProvider.js";
import { tablesProvider } from "@table-craft/desktop/renderer/palette/tablesProvider.js";
import { KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { focusRegion } from "@table-craft/desktop/renderer/shell/focus.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";
import { usePalette } from "@table-craft/desktop/renderer/state/palette.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { OVERLAY_MOTION, SURFACE_MOTION } from "@table-craft/desktop/renderer/ui/motion.js";

const PROVIDERS: readonly SearchProvider[] = [
  actionsProvider(registry),
  tablesProvider({
    catalogs: () => useCatalog.getState().catalogs,
    datasources: () => useDatasources.getState().datasources,
    open: (args) => {
      const open: OpenTableArgs = { datasourceId: args.datasourceId, path: args.path, relation: args.name };
      invoke(TABLE_ACTION_IDS.openTable, open);
    },
  }),
  keysProvider({
    keyspaces: () => useKeys.getState().keyspaces,
    datasources: () => useDatasources.getState().datasources,
    browsesKeys: () => {
      const { datasources, plugins } = useDatasources.getState();
      return datasources.some((datasource) => capabilitiesOf(plugins, datasource.pluginId).includes("keyValue"));
    },
    open: (args) => invoke(KEY_ACTION_IDS.open, args),
  }),
];
const MODE_TITLE: Readonly<Record<PaletteMode, string>> = {
  findAction: "Find Action",
  searchEverywhere: "Search Everywhere",
};
const MODE_PLACEHOLDER: Readonly<Record<PaletteMode, string>> = {
  findAction: "Type an action name",
  searchEverywhere: "Type to search everything",
};

function Row({ item, selected, onRun }: { item: SearchItem; selected: boolean; onRun: (item: SearchItem) => void }) {
  return (
    <li
      role="option"
      aria-selected={selected}
      aria-disabled={!item.enabled}
      data-enabled={item.enabled}
      className={cn(
        "flex h-row cursor-default items-center gap-gap rounded px-gap",
        selected && "bg-selection",
        !item.enabled && "text-ink-muted",
      )}
      // Keeps focus in the input, so typing continues after a click on a row.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onRun(item)}
    >
      <span className="truncate">{item.title}</span>
      {item.detail === undefined ? null : <span className="truncate text-ink-muted">{item.detail}</span>}
      {item.shortcut === undefined ? null : (
        <kbd className="ml-auto shrink-0 font-ui text-ink-muted">{formatChord(item.shortcut, currentPlatform())}</kbd>
      )}
    </li>
  );
}

function Body({ mode, onRun }: { mode: PaletteMode; onRun: (item: SearchItem) => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const tab = usePalette((state) => (mode === "searchEverywhere" ? state.tab : ACTIONS_PROVIDER_ID));
  const selectTab = usePalette((state) => state.selectTab);
  const recent = usePalette((state) => state.recent);
  const tabs = useMemo(() => paletteTabs(PROVIDERS), []);
  const results = useMemo(() => paletteResults(PROVIDERS, query, recent, tab), [query, recent, tab]);
  const current = Math.min(selected, Math.max(results.length - 1, 0));

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((current + step + results.length) % Math.max(results.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = results[current];
      if (item !== undefined) onRun(item);
    } else if (event.key === "Tab" && mode === "searchEverywhere") {
      event.preventDefault();
      const index = tabs.findIndex((entry) => entry.id === tab);
      const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (next !== undefined) selectTab(next.id);
      setSelected(0);
    }
  }

  return (
    <>
      <input
        autoFocus
        aria-label={MODE_TITLE[mode]}
        placeholder={MODE_PLACEHOLDER[mode]}
        className="h-tab w-full border-b border-line bg-transparent px-gap text-ink outline-none"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
      />
      {mode === "searchEverywhere" ? (
        <div role="tablist" aria-label="Search scope" className="flex gap-1 border-b border-line px-1">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === tab}
              tabIndex={-1}
              className={cn(
                "h-row border-b-2 px-gap",
                entry.id === tab ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink",
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                selectTab(entry.id);
                setSelected(0);
              }}
            >
              {entry.title}
            </button>
          ))}
        </div>
      ) : null}
      {results.length === 0 ? (
        <p className="p-gap text-ink-muted">Nothing found.</p>
      ) : (
        <ul role="listbox" aria-label="Results" className="max-h-96 overflow-y-auto p-1">
          {results.map((item, index) => (
            <Row key={item.key} item={item} selected={index === current} onRun={onRun} />
          ))}
        </ul>
      )}
    </>
  );
}

/** Find Action and Search Everywhere: one dialog, two modes (plan 003, decision 6). */
export function Palette() {
  const mode = usePalette((state) => state.mode);
  const ran = useRef(false);
  const opener = useRef<HTMLElement | null>(null);

  function run(item: SearchItem): void {
    if (!item.enabled) return;
    ran.current = true;
    const palette = usePalette.getState();
    palette.hide();
    if (item.recentId !== undefined) palette.remember(item.recentId);
    item.run();
  }

  function returnFocus(): void {
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected === true) target.focus();
    else if (document.activeElement === document.body) focusRegion("editor");
  }

  return (
    <Dialog.Root
      open={mode !== null}
      onOpenChange={(open) => {
        if (open) return;
        // Radix returns focus a task after unmount; a key typed right after Escape must not land on the body.
        flushSync(() => usePalette.getState().hide());
        returnFocus();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={cn("fixed inset-0 z-40 bg-canvas/50", OVERLAY_MOTION)} />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed top-24 left-1/2 z-50 w-palette max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-panel text-ui text-ink shadow-2xl",
            SURFACE_MOTION,
          )}
          onOpenAutoFocus={() => {
            ran.current = false;
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            // Radix would focus the dialog's trigger, and the palette has none.
            event.preventDefault();
            // An action that ran decides where focus goes, e.g. a new console's editor.
            if (ran.current) opener.current = null;
            returnFocus();
          }}
        >
          <Dialog.Title className="sr-only">{mode === null ? "" : MODE_TITLE[mode]}</Dialog.Title>
          {mode === null ? null : <Body key={mode} mode={mode} onRun={run} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
