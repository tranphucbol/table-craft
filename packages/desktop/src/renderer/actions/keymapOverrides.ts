import { PLATFORMS, sameChord, type Chord, type KeymapOverrides } from "@table-craft/desktop/settings/chords.js";
import type { AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";

/** What the keymap reads: an action's id and the chord it declares. */
export type ShortcutSource = Pick<AnyAction, "id" | "shortcut">;

/** Every action's chords, its first the one labels show. */
export type Shortcuts = ReadonlyMap<string, readonly Chord[]>;

const NO_OVERRIDES: KeymapOverrides = {};

function defaultsOf(action: ShortcutSource): readonly Chord[] {
  return action.shortcut === undefined ? [] : [action.shortcut];
}

/**
 * The keymap in effect: an override replaces the action's declared chord, `[]` leaves it none, and
 * an override for an id no action has is ignored (decision 154).
 */
export function effectiveShortcuts(
  actions: readonly ShortcutSource[],
  overrides: KeymapOverrides = NO_OVERRIDES,
): Shortcuts {
  return new Map(
    actions.map((action) => [
      action.id,
      Object.hasOwn(overrides, action.id) ? (overrides[action.id] ?? []) : defaultsOf(action),
    ]),
  );
}

function samePress(a: Chord, b: Chord): boolean {
  return PLATFORMS.every((platform) => sameChord(a, b, platform));
}

function sameChords(a: readonly Chord[], b: readonly Chord[]): boolean {
  return a.length === b.length && a.every((chord, index) => samePress(chord, b[index] ?? ""));
}

/** `overrides` with `action` holding `chords`; an entry equal to the default is dropped, so the file holds changes only. */
function withChords(overrides: KeymapOverrides, action: ShortcutSource, chords: readonly Chord[]): KeymapOverrides {
  const { [action.id]: _replaced, ...others } = overrides;
  return sameChords(chords, defaultsOf(action)) ? others : { ...others, [action.id]: chords };
}

export function chordsOf(overrides: KeymapOverrides, action: ShortcutSource): readonly Chord[] {
  return Object.hasOwn(overrides, action.id) ? (overrides[action.id] ?? []) : defaultsOf(action);
}

/** Whether `action`'s chords differ from the ones it declares. */
export function isModified(overrides: KeymapOverrides, action: ShortcutSource): boolean {
  return !sameChords(chordsOf(overrides, action), defaultsOf(action));
}

/** `action` with `chord` added after the chords it has now. */
export function withChord(overrides: KeymapOverrides, action: ShortcutSource, chord: Chord): KeymapOverrides {
  const current = chordsOf(overrides, action);
  if (current.some((held) => samePress(held, chord))) return overrides;
  return withChords(overrides, action, [...current, chord]);
}

/** `action` without `chord`; without its last one it has no shortcut. */
export function withoutChord(overrides: KeymapOverrides, action: ShortcutSource, chord: Chord): KeymapOverrides {
  const current = chordsOf(overrides, action);
  return withChords(
    overrides,
    action,
    current.filter((held) => !samePress(held, chord)),
  );
}

/** `action` back to the chord it declares. */
export function withDefault(overrides: KeymapOverrides, actionId: string): KeymapOverrides {
  if (!Object.hasOwn(overrides, actionId)) return overrides;
  const { [actionId]: _reset, ...others } = overrides;
  return others;
}

/**
 * Every action back to its default. Overrides for ids this build has no action for stay, as
 * reading the file keeps them (decision 154).
 */
export function withAllDefaults(overrides: KeymapOverrides, actions: readonly ShortcutSource[]): KeymapOverrides {
  const known = new Set(actions.map((action) => action.id));
  return Object.fromEntries(Object.entries(overrides).filter(([id]) => !known.has(id)));
}
