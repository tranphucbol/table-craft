import { useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
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
import { CloseIcon, FindByShortcutIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import type { KeymapOverrides } from "@table-craft/desktop/settings/chords.js";
import type { Settings } from "@table-craft/desktop/settings/settings.js";

/** Marks the control that is listening for a chord, so Escape cancels it rather than closing Settings. */
const RECORDER_ATTRIBUTE = "data-chord-recorder";
const CANCEL_KEY = "Escape";

/** Whether a chord recorder has focus; Settings then leaves Escape to it. */
export function recordingChord(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.hasAttribute(RECORDER_ATTRIBUTE);
}

/** Every action a chord can run: those Find Action lists, and those that declare a shortcut. */
function keymapActions(): readonly AnyAction[] {
  return registry
    .all()
    .filter((action) => action.inPalette !== false || action.shortcut !== undefined)
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

function updateKeymap(next: (overrides: KeymapOverrides) => KeymapOverrides): void {
  update((current) => ({ ...current, keymap: next(current.keymap) }));
}

/** The Keymap page's Restore Defaults and Reset All: every action's own chord back (decision 153). */
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

function ChordChip({ action, chord }: { readonly action: AnyAction; readonly chord: Chord }) {
  const shown = formatChord(chord, currentPlatform());
  return (
    <span data-keymap-chord={chord} className="flex shrink-0 items-center rounded bg-raised pl-cell">
      <kbd className="font-ui">{shown}</kbd>
      <button
        type="button"
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
      className="h-row shrink-0 rounded border border-accent px-cell text-ink-muted outline-none"
      onKeyDown={onKeyDown}
      onBlur={() => onRecording((current) => (current?.phase === "listening" ? null : current))}
    >
      Press a shortcut…
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
    <span role="alert" className="flex min-w-0 basis-full items-center gap-cell">
      <span className="min-w-0 flex-1">
        {formatChord(chord, currentPlatform())} is already the shortcut of {owners}.
      </span>
      <Button
        autoFocus
        variant="primary"
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
  onRecording,
}: {
  readonly action: AnyAction;
  readonly overrides: KeymapOverrides;
  readonly recording: Recording | null;
  readonly onRecording: Dispatch<SetStateAction<Recording | null>>;
}) {
  const chords = chordsOf(overrides, action);
  const modified = isModified(overrides, action);
  const notes = chords.flatMap((chord) => editorNote(chord, action, currentPlatform()) ?? []);
  return (
    <li
      data-keymap-row={action.id}
      aria-label={action.title}
      className="flex min-h-row flex-wrap items-center gap-x-cell rounded px-cell hover:bg-hover"
    >
      <span className="flex min-w-0 flex-1 items-center gap-cell">
        <span className="min-w-0 truncate">{action.title}</span>
        {modified ? <span className="shrink-0 text-accent">Modified</span> : null}
      </span>
      <span className="w-dialog-label shrink-0 truncate text-ink-muted">{action.category}</span>
      <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-1">
        {chords.map((chord) => (
          <ChordChip key={chord} action={action} chord={chord} />
        ))}
      </span>
      {recording?.phase === "listening" ? (
        <Recorder action={action} onRecording={onRecording} />
      ) : (
        <Button onClick={() => onRecording({ actionId: action.id, phase: "listening", refusal: null })}>
          Add Shortcut
        </Button>
      )}
      <Button disabled={!modified} onClick={() => updateKeymap((next) => withDefault(next, action.id))}>
        Reset
      </Button>
      {recording?.phase === "listening" && recording.refusal !== null ? (
        <span role="alert" className="min-w-0 basis-full text-danger">
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
        <span key={note} className="min-w-0 basis-full text-ink-muted">
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

/** Settings → Keymap (decision 153): every action's shortcuts, searchable by name or by the chord itself. */
export function KeymapPage() {
  const overrides = useSettings((state) => state.settings.keymap);
  const actions = useMemo(() => keymapActions(), []);
  const [query, setQuery] = useState("");
  const [byShortcut, setByShortcut] = useState(false);
  const [chordFilter, setChordFilter] = useState<Chord | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const platform = currentPlatform();
  const shown = actions.filter((action) =>
    byShortcut
      ? chordFilter === null || chordsOf(overrides, action).some((chord) => sameChord(chord, chordFilter, platform))
      : matchesQuery(action, query),
  );
  const anyModified = actions.some((action) => isModified(overrides, action));

  const toggleByShortcut = () => {
    setByShortcut(!byShortcut);
    setChordFilter(null);
    search.current?.focus();
  };
  const onSearchKey = (event: KeyboardEvent) => {
    if (!byShortcut) return;
    if (event.key === "Tab") return;
    stopKey(event);
    if (event.key === CANCEL_KEY && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      setByShortcut(false);
      setChordFilter(null);
      return;
    }
    const chord = chordOfKey(event, platform);
    if (chord !== null) setChordFilter(chord);
  };

  return (
    <div className="col-span-2 flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-cell">
        <input
          ref={search}
          spellCheck={false}
          type="search"
          aria-label={byShortcut ? "Find by shortcut" : "Search actions"}
          placeholder={byShortcut ? "Press a shortcut" : "Search by name or category"}
          className={cn(INPUT_CLASS, "min-w-0 flex-1")}
          readOnly={byShortcut}
          {...(byShortcut ? { [RECORDER_ATTRIBUTE]: "" } : {})}
          value={byShortcut ? (chordFilter === null ? "" : formatChord(chordFilter, platform)) : query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKey}
        />
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
        <Button disabled={!anyModified} onClick={() => update(restoreKeymap)}>
          Reset All
        </Button>
      </div>
      <ul aria-label="Shortcuts" className="flex flex-col">
        {shown.map((action) => (
          <KeymapRow
            key={action.id}
            action={action}
            overrides={overrides}
            recording={recording?.actionId === action.id ? recording : null}
            onRecording={setRecording}
          />
        ))}
      </ul>
      {shown.length === 0 ? <p className="text-ink-muted">No action matches.</p> : null}
    </div>
  );
}
