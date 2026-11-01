import { getSearchQuery, type SearchQuery } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { EDITOR_FIND_ACTION_IDS } from "@table-craft/desktop/renderer/actions/editorFindActions.js";
import { setFindText } from "@table-craft/desktop/renderer/console/find/commands.js";
import { useFindHistory, type FindHistoryKind } from "@table-craft/desktop/renderer/console/find/findHistory.js";
import { onFindFocus, type FindHost } from "@table-craft/desktop/renderer/console/find/findPanel.js";
import { findScope, type FindScope } from "@table-craft/desktop/renderer/console/find/findState.js";
import {
  countFailed,
  countOf,
  counterSpoken,
  counterText,
  findMatches,
  type FoundMatches,
} from "@table-craft/desktop/renderer/console/find/matchCount.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import { OptionToggle } from "@table-craft/desktop/renderer/ui/OptionToggle.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

/** A larger document is counted this long after the last keystroke, as the grid's find bar does (`grid/FindBar.tsx`). */
const TYPING_SETTLE_MS = 120;
/** Up to this many characters a count takes well under a frame, so it answers on every keystroke. */
const COUNT_AT_ONCE_LIMIT = 200_000;
const ROW = "flex min-h-row flex-wrap items-center gap-1";
const FIELD = "flex h-row w-72 min-w-40 shrink items-center rounded border bg-canvas";
const FIELD_BORDER = "border-line focus-within:border-accent";
const INPUT =
  "h-full min-w-0 flex-1 bg-transparent px-1 font-grid text-grid text-ink outline-none placeholder:text-ink-muted";
/** A toggle inside a field keeps a sliver of the field around its fill, as DataGrip's do. */
const FIELD_TOGGLE = "my-0.5 self-stretch";
const HISTORY_KEY = "ArrowDown";
const PRESERVE_CASE_REASON = "Preserve Case does not apply while Regex is on";
const HistoryIcon = ACTION_ICONS.history;

/** The match count: at once in an ordinary console, settled after typing in a large one. */
function useMatchCount(view: EditorView, state: EditorState, query: SearchQuery, scope: FindScope) {
  const atOnce = state.doc.length <= COUNT_AT_ONCE_LIMIT;
  const immediate = useMemo(() => (atOnce ? findMatches(state, query) : undefined), [atOnce, state, query]);
  const [settled, setSettled] = useState<FoundMatches | "invalid" | null>(null);
  useEffect(() => {
    if (atOnce) return;
    const timer = setTimeout(() => setSettled(findMatches(view.state, query)), TYPING_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [atOnce, view, state.doc, query, scope]);
  const found = immediate ?? settled;
  if (query.search === "") return null;
  if (!query.valid) return "invalid";
  if (found === null || found === "invalid") return null;
  return countOf(found, state.selection.main);
}

interface HistoryMenu {
  readonly kind: FindHistoryKind;
  readonly anchor: PopoverAnchor;
}

function HistoryList({
  items,
  onChoose,
}: {
  readonly items: readonly string[];
  readonly onChoose: (text: string) => void;
}) {
  function step(event: KeyboardEvent<HTMLButtonElement>) {
    const sibling =
      event.key === "ArrowDown"
        ? event.currentTarget.nextElementSibling
        : event.key === "ArrowUp"
          ? event.currentTarget.previousElementSibling
          : null;
    if (sibling instanceof HTMLElement) {
      event.preventDefault();
      sibling.focus();
    }
  }
  return (
    <div role="listbox" className="flex min-w-72 flex-col overflow-y-auto p-1">
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="option"
          aria-selected={false}
          className="flex h-row shrink-0 items-center rounded-sm px-cell text-left font-grid text-grid whitespace-pre outline-none hover:bg-selection focus:bg-selection focus:outline-1 focus:-outline-offset-1 focus:outline-accent"
          onKeyDown={step}
          onClick={() => onChoose(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

/** A find bar field: the history button, the text, and the toggles DataGrip draws inside it. */
function FindField({
  inputRef,
  label,
  testId,
  value,
  failed,
  history,
  onText,
  onHistory,
  mainField,
  children,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly failed: boolean;
  readonly history: readonly string[];
  readonly onText: (text: string) => void;
  readonly onHistory: (anchor: PopoverAnchor) => void;
  readonly mainField?: boolean;
  readonly children?: ReactNode;
}) {
  const historyButton = useRef<HTMLButtonElement>(null);
  function openHistory() {
    const rect = historyButton.current?.getBoundingClientRect();
    if (rect === undefined || history.length === 0) return;
    onHistory({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return (
    <div className={cn(FIELD, failed ? "border-danger" : FIELD_BORDER)}>
      <Tooltip label={history.length === 0 ? "No recent entries" : "Recent entries"} side="bottom">
        <button
          ref={historyButton}
          type="button"
          aria-label={`Recent ${label.toLowerCase()} entries`}
          aria-haspopup="listbox"
          disabled={history.length === 0}
          className="flex shrink-0 items-center self-stretch px-1 text-ink-muted hover:text-ink disabled:opacity-50"
          onMouseDown={(event) => event.preventDefault()}
          onClick={openHistory}
        >
          <HistoryIcon aria-hidden className="size-icon" />
        </button>
      </Tooltip>
      <input
        ref={inputRef}
        type="text"
        aria-label={label}
        aria-invalid={failed}
        data-testid={testId}
        {...(mainField === true ? { "main-field": "true" } : {})}
        spellCheck={false}
        autoComplete="off"
        placeholder={label}
        className={INPUT}
        value={value}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.altKey && event.key === HISTORY_KEY) {
            event.preventDefault();
            openHistory();
          }
        }}
      />
      {children}
    </div>
  );
}

/**
 * The console's find and replace bar (plan 139), DataGrip's editor find bar drawn in CodeMirror's
 * top panel. CodeMirror's search state is the engine; every button is an action, and Enter,
 * ⇧Enter and ⌥⌘Enter are actions of the `editorFind` and `editorReplace` regions.
 */
export function EditorFindBar({ host }: { readonly host: FindHost }) {
  const { view } = host;
  const state = useSyncExternalStore(host.subscribe, () => view.state);
  const query = getSearchQuery(state);
  const scope = findScope(state);
  const count = useMatchCount(view, state, query, scope);
  const failed = countFailed(count);
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const queries = useFindHistory((history) => history.queries);
  const replacements = useFindHistory((history) => history.replacements);
  const [menu, setMenu] = useState<HistoryMenu | null>(null);

  useEffect(
    () =>
      onFindFocus(view, () => {
        findInput.current?.focus();
        findInput.current?.select();
      }),
    [view],
  );

  function choose(kind: FindHistoryKind, text: string) {
    setMenu(null);
    setFindText(view, kind === "queries" ? "search" : "replace", text);
  }

  return (
    <div role="search" aria-label="Find in console" className="flex flex-col gap-1 p-1 font-ui text-ui text-ink">
      <div {...{ [REGION_ATTRIBUTE]: "editorFind" }} className={ROW}>
        <FindField
          inputRef={findInput}
          label="Find"
          testId="editor-find-input"
          value={query.search}
          failed={failed}
          history={queries}
          mainField
          onText={(text) => setFindText(view, "search", text)}
          onHistory={(anchor) => setMenu({ kind: "queries", anchor })}
        >
          <OptionToggle
            actionId={EDITOR_FIND_ACTION_IDS.matchCase}
            label="Cc"
            pressed={query.caseSensitive}
            className={FIELD_TOGGLE}
          />
          <OptionToggle
            actionId={EDITOR_FIND_ACTION_IDS.words}
            label="W"
            pressed={query.wholeWord}
            className={FIELD_TOGGLE}
          />
          <OptionToggle
            actionId={EDITOR_FIND_ACTION_IDS.regex}
            label=".*"
            pressed={query.regexp}
            className={FIELD_TOGGLE}
          />
        </FindField>
        <span
          aria-hidden
          data-testid="editor-find-status"
          className={cn("ml-1 min-w-14 whitespace-nowrap tabular-nums", failed ? "text-danger" : "text-ink-muted")}
        >
          {counterText(count)}
        </span>
        <span role="status" className="sr-only">
          {counterSpoken(count)}
        </span>
        <ActionButton actionId={EDITOR_FIND_ACTION_IDS.findPrevious} compact />
        <ActionButton actionId={EDITOR_FIND_ACTION_IDS.findNext} compact />
        <ActionButton actionId={EDITOR_FIND_ACTION_IDS.selectAll} compact />
        <ActionButton
          actionId={EDITOR_FIND_ACTION_IDS.inSelection}
          compact
          pressed={scope.inSelection !== null}
          reason="Select the text to search in first"
        />
        <div className="flex-1" />
        <ActionButton actionId={EDITOR_FIND_ACTION_IDS.close} compact />
      </div>
      {scope.replaceOpen ? (
        <div {...{ [REGION_ATTRIBUTE]: "editorReplace" }} className={ROW}>
          <FindField
            inputRef={replaceInput}
            label="Replace"
            testId="editor-replace-input"
            value={query.replace}
            failed={false}
            history={replacements}
            onText={(text) => setFindText(view, "replace", text)}
            onHistory={(anchor) => setMenu({ kind: "replacements", anchor })}
          >
            <OptionToggle
              actionId={EDITOR_FIND_ACTION_IDS.preserveCase}
              label="Aa"
              pressed={scope.preserveCase}
              reason={PRESERVE_CASE_REASON}
              className={FIELD_TOGGLE}
            />
          </FindField>
          <ActionButton actionId={EDITOR_FIND_ACTION_IDS.replaceOne} />
          <ActionButton actionId={EDITOR_FIND_ACTION_IDS.replaceAll} />
          <ActionButton actionId={EDITOR_FIND_ACTION_IDS.exclude} />
        </div>
      ) : null}
      {menu === null ? null : (
        <Popover
          anchor={menu.anchor}
          label={menu.kind === "queries" ? "Recent searches" : "Recent replacements"}
          testId="editor-find-history"
          onClose={() => setMenu(null)}
        >
          <HistoryList
            items={menu.kind === "queries" ? queries : replacements}
            onChoose={(text) => choose(menu.kind, text)}
          />
        </Popover>
      )}
    </div>
  );
}
