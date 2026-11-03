import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { type Chord, currentPlatform, formatChord, sameChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { registry } from "@table-craft/desktop/renderer/actions/index.js";
import {
  chordsOf,
  isModified,
  withAllDefaults,
  withChord,
  withDefault,
  withoutChord,
} from "@table-craft/desktop/renderer/actions/keymapOverrides.js";
import type { AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  chordOfKey,
  editorNote,
  recordChord,
  withReassigned,
  type RecordTarget,
} from "@table-craft/desktop/renderer/dialogs/chordRecorder.js";
import { Button, INPUT_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { update } from "@table-craft/desktop/renderer/dialogs/settingsParts.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ICON_BUTTON } from "@table-craft/desktop/renderer/ui/iconButtonClasses.js";
import {
  AddShortcutIcon,
  CloseIcon,
  FindByShortcutIcon,
  ResetShortcutIcon,
} from "@table-craft/desktop/renderer/ui/icons.js";
import type { KeymapOverrides } from "@table-craft/desktop/settings/chords.js";
import type { Settings } from "@table-craft/desktop/settings/settings.js";

/**
 * Marks what owns Escape while it has focus (the recorder, Find by Shortcut, the clash prompt), so
 * Escape cancels there rather than closing Settings.
 */
const RECORDER_ATTRIBUTE = "data-chord-recorder";
const ROW_ATTRIBUTE = "data-keymap-row";
const CANCEL_KEY = "Escape";
const RECORD_KEY = "Enter";
const REMOVE_KEYS: ReadonlySet<string> = new Set(["Delete", "Backspace"]);
/** Where arrow keys, Home and End move focus among `count` rows from row `at`. */
const ROW_MOVES: Readonly<Record<string, (at: number, count: number) => number>> = {
  ArrowDown: (at, count) => Math.min(at + 1, count - 1),
  ArrowUp: (at) => Math.max(at - 1, 0),
  Home: () => 0,
  End: (_at, count) => count - 1,
};
const CHIP_CLASS = "flex h-row shrink-0 items-center rounded border border-line bg-canvas";
/** Clears the sticky search bar and category heading when a focused row scrolls into view. */
const ROW_SCROLL_MARGIN = "scroll-mt-[calc(var(--spacing-row)*2+var(--spacing-gap))]";

/** Whether something that owns Escape has focus; Settings then leaves Escape to it. */
export function recordingChord(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest(`[${RECORDER_ATTRIBUTE}]`) !== null;
}

/** Every action a chord can run: those Find Action lists, and those that declare a shortcut. */
function keymapActions(): readonly AnyAction[] {
  return registry
    .all()
    .filter((action) => action.inPalette !== false || action.shortcut !== undefined)
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

function byCategory(actions: readonly AnyAction[]): readonly (readonly [string, readonly AnyAction[]])[] {
  const groups = new Map<string, AnyAction[]>();
  for (const action of actions) groups.set(action.category, [...(groups.get(action.category) ?? []), action]);
  return [...groups];
}

function updateKeymap(next: (overrides: KeymapOverrides) => KeymapOverrides): void {
  update((current) => ({ ...current, keymap: next(current.keymap) }));
}

/** The Keymap page's Restore Defaults: every action's own chord back (decision 153). */
export function restoreKeymap(current: Settings): Settings {
  return { ...current, keymap: withAllDefaults(current.keymap, registry.all()) };
}

type Recording =
  | { readonly actionId: string; readonly phase: "listening"; readonly refusal: string | null }
  | {
      readonly actionId: string;
      readonly phase: "clash";
      readonly chord: Chord;
      readonly clashes: readonly AnyAction[];
    };

function targetFor(action: AnyAction): RecordTarget {
  return {
    actions: registry.all(),
    overrides: useSettings.getState().settings.keymap,
    platform: currentPlatform(),
    action,
  };
}

function stopKey(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function isBareKey(event: KeyboardEvent, key: string): boolean {
  return event.key === key && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
}

function ChordChip({
  action,
  chord,
  tabbable,
}: {
  readonly action: AnyAction;
  readonly chord: Chord;
  readonly tabbable: boolean;
}) {
  const shown = formatChord(chord, currentPlatform());
  return (
    <span data-keymap-chord={chord} className={cn(CHIP_CLASS, "pl-cell")}>
      <kbd className="font-ui">{shown}</kbd>
      <button
        type="button"
        tabIndex={tabbable ? 0 : -1}
        aria-label={`Remove ${shown} from ${action.title}`}
        title={`Remove ${shown}`}
        className={ICON_BUTTON}
        onClick={() => updateKeymap((overrides) => withoutChord(overrides, action, chord))}
      >
        <CloseIcon aria-hidden className="size-icon" />
      </button>
    </span>
  );
}

function Recorder({
  action,
  onRecording,
}: {
  readonly action: AnyAction;
  readonly onRecording: Dispatch<SetStateAction<Recording | null>>;
}) {
  const hint = useId();
  const onKeyDown = (event: KeyboardEvent) => {
    stopKey(event);
    const recorded = recordChord(event, targetFor(action));
    if (recorded.kind === "waiting") return;
    if (recorded.kind === "cancelled") return onRecording(null);
    if (recorded.kind === "refused") {
      return onRecording({ actionId: action.id, phase: "listening", refusal: recorded.reason });
    }
    if (recorded.clashes.length > 0) {
      return onRecording({ actionId: action.id, phase: "clash", chord: recorded.chord, clashes: recorded.clashes });
    }
    updateKeymap((overrides) => withChord(overrides, action, recorded.chord));
    onRecording(null);
  };
  return (
    <button
      type="button"
      autoFocus
      {...{ [RECORDER_ATTRIBUTE]: "" }}
      aria-label={`Press a shortcut for ${action.title}`}
      aria-describedby={hint}
      className={cn(CHIP_CLASS, "gap-cell border-accent px-cell outline-none")}
      onKeyDown={onKeyDown}
      onBlur={() => onRecording((current) => (current?.phase === "listening" ? null : current))}
    >
      Press a shortcut…
      <span id={hint} className="text-ink-muted">
        Esc cancels
      </span>
    </button>
  );
}

function ClashPrompt({
  action,
  chord,
  clashes,
  onDone,
}: {
  readonly action: AnyAction;
  readonly chord: Chord;
  readonly clashes: readonly AnyAction[];
  readonly onDone: () => void;
}) {
  const owners = clashes.map((other) => `${other.title} (${other.category})`).join(", ");
  return (
    <span
      role="alert"
      {...{ [RECORDER_ATTRIBUTE]: "" }}
      className="col-span-3 flex min-w-0 flex-wrap items-center gap-cell text-ink-muted"
      onKeyDown={(event) => {
        if (!isBareKey(event, CANCEL_KEY)) return;
        stopKey(event);
        onDone();
      }}
    >
      <span className="min-w-0 flex-1">
        <kbd className="font-ui text-ink">{formatChord(chord, currentPlatform())}</kbd> is already the shortcut of{" "}
        {owners}.
      </span>
      <Button
        autoFocus
        onClick={() => {
          updateKeymap((overrides) => withReassigned({ ...targetFor(action), overrides }, chord, clashes));
          onDone();
        }}
      >
        Reassign
      </Button>
      <Button onClick={onDone}>Cancel</Button>
    </span>
  );
}

function KeymapRow({
  action,
  overrides,
  recording,
  tabbable,
  onRecording,
  onActive,
}: {
  readonly action: AnyAction;
  readonly overrides: KeymapOverrides;
  readonly recording: Recording | null;
  /** The list's one Tab stop: this row and its buttons take Tab, the other rows only arrow keys. */
  readonly tabbable: boolean;
  readonly onRecording: Dispatch<SetStateAction<Recording | null>>;
  readonly onActive: (actionId: string) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const chords = chordsOf(overrides, action);
  const modified = isModified(overrides, action);
  const notes = chords.flatMap((chord) => editorNote(chord, action, currentPlatform()) ?? []);
  const listening = recording?.phase === "listening";
  const tabIndex = tabbable ? 0 : -1;
  const startRecording = () => onRecording({ actionId: action.id, phase: "listening", refusal: null });

  // Recording, Reassign, a removed chord or Reset unmount or disable the focused control; focus
  // then falls to the page body, and this row takes it back so the keyboard keeps its place.
  useLayoutEffect(() => {
    if (tabbable && document.activeElement === document.body) row.current?.focus();
  });

  const onRowKey = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.target !== event.currentTarget) return;
    if (isBareKey(event, RECORD_KEY)) {
      event.preventDefault();
      startRecording();
      return;
    }
    const last = chords.at(-1);
    if (REMOVE_KEYS.has(event.key) && last !== undefined) {
      event.preventDefault();
      updateKeymap((next) => withoutChord(next, action, last));
    }
  };

  return (
    <li
      ref={row}
      {...{ [ROW_ATTRIBUTE]: action.id }}
      tabIndex={tabIndex}
      className={cn(
        "group grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-cell rounded px-cell py-0.5 outline-none",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        ROW_SCROLL_MARGIN,
        recording === null ? "hover:bg-hover" : "bg-selection",
      )}
      onFocus={() => onActive(action.id)}
      onKeyDown={onRowKey}
    >
      <span className="flex min-w-0 items-center gap-cell">
        <span className="min-w-0 truncate">{action.title}</span>
        {modified ? (
          <>
            <span className="shrink-0 text-ink-muted">Modified</span>
            <button
              type="button"
              tabIndex={tabIndex}
              aria-label={`Reset ${action.title}`}
              title="Reset to Default"
              className={ICON_BUTTON}
              onClick={() => updateKeymap((next) => withDefault(next, action.id))}
            >
              <ResetShortcutIcon aria-hidden className="size-icon" />
            </button>
          </>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-wrap justify-end gap-1">
        {chords.map((chord) => (
          <ChordChip key={chord} action={action} chord={chord} tabbable={tabbable} />
        ))}
        {listening ? <Recorder action={action} onRecording={onRecording} /> : null}
      </span>
      <button
        type="button"
        tabIndex={tabIndex}
        aria-label={`Add shortcut to ${action.title}`}
        title="Add Shortcut"
        className={cn(
          ICON_BUTTON,
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          recording !== null && "invisible",
        )}
        onClick={startRecording}
      >
        <AddShortcutIcon aria-hidden className="size-icon" />
      </button>
      {listening && recording.refusal !== null ? (
        <span role="alert" className="col-span-3 min-w-0 text-danger">
          {recording.refusal}
        </span>
      ) : null}
      {recording?.phase === "clash" ? (
        <ClashPrompt
          action={action}
          chord={recording.chord}
          clashes={recording.clashes}
          onDone={() => onRecording(null)}
        />
      ) : null}
      {notes.map((note) => (
        <span key={note} className="col-span-3 min-w-0 text-ink-muted">
          {note}
        </span>
      ))}
    </li>
  );
}

function matchesQuery(action: AnyAction, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (
    needle === "" ||
    action.title.toLocaleLowerCase().includes(needle) ||
    action.category.toLocaleLowerCase().includes(needle)
  );
}

function moveAmongRows(event: KeyboardEvent<HTMLElement>): void {
  const move = ROW_MOVES[event.key];
  const target = event.target;
  if (move === undefined || !(target instanceof HTMLElement) || !target.hasAttribute(ROW_ATTRIBUTE)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`)];
  event.preventDefault();
  rows[move(rows.indexOf(target), rows.length)]?.focus();
}

/** Settings → Keymap (decision 153): every action's shortcuts, searchable by name or by the chord itself. */
export function KeymapPage() {
  const overrides = useSettings((state) => state.settings.keymap);
  const actions = useMemo(() => keymapActions(), []);
  const [query, setQuery] = useState("");
  const [byShortcut, setByShortcut] = useState(false);
  const [chordFilter, setChordFilter] = useState<Chord | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const platform = currentPlatform();
  const shown = actions.filter((action) =>
    byShortcut
      ? chordFilter === null || chordsOf(overrides, action).some((chord) => sameChord(chord, chordFilter, platform))
      : matchesQuery(action, query),
  );
  const tabbableId = shown.some((action) => action.id === activeId) ? activeId : (shown[0]?.id ?? null);
  const searchText = byShortcut ? (chordFilter === null ? "" : formatChord(chordFilter, platform)) : query;

  const toggleByShortcut = () => {
    setByShortcut(!byShortcut);
    setChordFilter(null);
    search.current?.focus();
  };
  const clearSearch = () => {
    setQuery("");
    setChordFilter(null);
    search.current?.focus();
  };
  const onSearchKey = (event: KeyboardEvent) => {
    if (!byShortcut) return;
    if (event.key === "Tab") return;
    stopKey(event);
    if (isBareKey(event, CANCEL_KEY)) {
      setByShortcut(false);
      setChordFilter(null);
      return;
    }
    const chord = chordOfKey(event, platform);
    if (chord !== null) setChordFilter(chord);
  };

  return (
    <div className="col-span-2 flex min-w-0 flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-cell bg-panel px-cell">
        <span className="relative flex min-w-0 flex-1">
          <input
            ref={search}
            spellCheck={false}
            type="search"
            aria-label={byShortcut ? "Find by shortcut" : "Search actions"}
            placeholder={byShortcut ? "Press a shortcut" : "Search by name or category"}
            className={cn(INPUT_CLASS, "min-w-0 flex-1 pr-row [&::-webkit-search-cancel-button]:appearance-none")}
            readOnly={byShortcut}
            {...(byShortcut ? { [RECORDER_ATTRIBUTE]: "" } : {})}
            value={searchText}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKey}
          />
          {searchText === "" ? null : (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear"
              className={cn(ICON_BUTTON, "absolute inset-y-0 right-0")}
              onClick={clearSearch}
            >
              <CloseIcon aria-hidden className="size-icon" />
            </button>
          )}
        </span>
        <button
          type="button"
          aria-pressed={byShortcut}
          aria-label="Find by Shortcut"
          title="Find by Shortcut"
          className={cn(ICON_BUTTON, byShortcut && "bg-selection text-ink")}
          onClick={toggleByShortcut}
        >
          <FindByShortcutIcon aria-hidden className="size-icon" />
        </button>
      </div>
      <div className="flex flex-col" onKeyDown={moveAmongRows}>
        {byCategory(shown).map(([category, members]) => (
          <section key={category} aria-label={category}>
            <h3 className="sticky top-row z-10 border-b border-line bg-panel px-cell pt-gap pb-1 font-semibold text-ink-muted">
              {category}
            </h3>
            <ul className="flex flex-col">
              {members.map((action) => (
                <KeymapRow
                  key={action.id}
                  action={action}
                  overrides={overrides}
                  recording={recording?.actionId === action.id ? recording : null}
                  tabbable={action.id === tabbableId}
                  onRecording={setRecording}
                  onActive={setActiveId}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="px-cell pt-gap text-ink-muted">
          {byShortcut && chordFilter !== null
            ? `No action uses ${formatChord(chordFilter, platform)}.`
            : `No action matches “${query.trim()}”.`}
        </p>
      ) : null}
    </div>
  );
}
