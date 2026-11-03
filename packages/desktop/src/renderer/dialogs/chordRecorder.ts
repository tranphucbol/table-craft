import {
  type Chord,
  chordKey,
  formatChord,
  parseChord,
  keyOf,
  type KeyLike,
  type Platform,
  sameChord,
} from "@table-craft/desktop/renderer/actions/chords.js";
import { findClashes, shortcutWorksIn } from "@table-craft/desktop/renderer/actions/keymap.js";
import {
  chordsOf,
  effectiveShortcuts,
  withChord,
  withoutChord,
} from "@table-craft/desktop/renderer/actions/keymapOverrides.js";
import type { AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { EDITOR_COMMANDS } from "@table-craft/desktop/renderer/console/editorKeys.js";
import { reservedOwner, type KeymapOverrides } from "@table-craft/desktop/settings/chords.js";

/** Why a key without Mod, Ctrl or Alt cannot be a shortcut (decision 153). */
export const NEEDS_MODIFIER = "Use a modifier, or a function key.";
export const NO_SUPER_KEY = "The Windows or Super key cannot be part of a shortcut.";
export const UNNAMED_KEY = "This key cannot be part of a shortcut.";

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;
const CANCEL_KEY = "Escape";
/** Keys a chord cannot spell, since `+` and a space separate its parts. */
const SEPARATORS = /[+ ]/;
const EDITOR_REGION = "editor";

/**
 * The chord a key event presses, spelled the way actions declare theirs: the platform's command
 * key as `Mod`. Null while only modifiers are down, and for the Super key off macOS, which no
 * chord can name.
 */
export function chordOfKey(event: KeyLike, platform: Platform): Chord | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = keyOf(event);
  if (key === "" || SEPARATORS.test(key)) return null;
  if (platform === "other" && event.metaKey) return null;
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  const ctrl = platform === "mac" && event.ctrlKey;
  return [mod && "Mod", ctrl && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", key]
    .filter((part) => part !== false)
    .join("+");
}

export interface RecordTarget {
  readonly actions: readonly AnyAction[];
  readonly overrides: KeymapOverrides;
  readonly platform: Platform;
  /** The action the chord is for. */
  readonly action: AnyAction;
}

export type Recorded =
  /** Only modifiers so far; keep listening. */
  | { readonly kind: "waiting" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "accepted";
      readonly chord: Chord;
      /** Actions holding the chord where `action` would fire too; Reassign takes it from them. */
      readonly clashes: readonly AnyAction[];
      readonly editorNote: string | null;
    };

/**
 * What the SQL editor does with `chord` instead, when `action` could fire there: the editor keeps
 * its own chords while it has focus, so the shortcut works everywhere else (decision 153).
 */
export function editorNote(chord: Chord, action: AnyAction, platform: Platform): string | null {
  if (!shortcutWorksIn(action, EDITOR_REGION)) return null;
  const command = EDITOR_COMMANDS.find((held) => sameChord(held.chord, chord, platform));
  if (command === undefined) return null;
  return `Not in the SQL editor, which uses ${formatChord(command.chord, platform)} for ${command.name}`;
}

/** Actions other than `target.action` that hold `chord` where it could fire too. */
function clashesOver(target: RecordTarget, chord: Chord): readonly AnyAction[] {
  const { actions, overrides, platform, action } = target;
  const next = effectiveShortcuts(actions, withChord(overrides, action, chord));
  const key = chordKey(parseChord(chord, platform));
  return actions.filter(
    (other) =>
      other.id !== action.id &&
      findClashes([action, other], next).some((clash) => clash.platform === platform && clash.chord === key),
  );
}

/**
 * Reads one key press as a shortcut for `target.action` (decision 153): Escape cancels, a key
 * without Mod, Ctrl or Alt other than an F key is refused, so is a chord the menu's roles or the
 * system take, and an accepted chord names the actions it would clash with.
 */
export function recordChord(event: KeyLike, target: RecordTarget): Recorded {
  if (MODIFIER_KEYS.has(event.key)) return { kind: "waiting" };
  const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (bare && !event.shiftKey && keyOf(event) === CANCEL_KEY) return { kind: "cancelled" };
  const chord = chordOfKey(event, target.platform);
  if (chord === null) {
    return { kind: "refused", reason: target.platform === "other" && event.metaKey ? NO_SUPER_KEY : UNNAMED_KEY };
  }
  if (bare && !FUNCTION_KEY.test(keyOf(event))) return { kind: "refused", reason: NEEDS_MODIFIER };
  const shown = formatChord(chord, target.platform);
  const owner = reservedOwner(chord, target.platform);
  if (owner !== null) return { kind: "refused", reason: `${shown} belongs to ${owner}.` };
  const { action, overrides, platform } = target;
  if (chordsOf(overrides, action).some((held) => sameChord(held, chord, platform))) {
    return { kind: "refused", reason: `${shown} is already ${action.title}'s shortcut.` };
  }
  return {
    kind: "accepted",
    chord,
    clashes: clashesOver(target, chord),
    editorNote: editorNote(chord, action, platform),
  };
}

/** `overrides` with `chord` added to `target.action`, taken first from each of `clashes`. */
export function withReassigned(target: RecordTarget, chord: Chord, clashes: readonly AnyAction[]): KeymapOverrides {
  const { platform } = target;
  const freed = clashes.reduce(
    (overrides, other) =>
      chordsOf(overrides, other)
        .filter((held) => sameChord(held, chord, platform))
        .reduce((next, held) => withoutChord(next, other, held), overrides),
    target.overrides,
  );
  return withChord(freed, target.action, chord);
}
