import { currentPlatform, formatChord, type Chord } from "@table-craft/desktop/renderer/actions/chords.js";
import { registry } from "@table-craft/desktop/renderer/actions/index.js";
import { effectiveShortcuts, type Shortcuts } from "@table-craft/desktop/renderer/actions/keymapOverrides.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import type { KeymapOverrides } from "@table-craft/desktop/settings/chords.js";

let cached: { readonly overrides: KeymapOverrides; readonly actions: number; readonly shortcuts: Shortcuts } | null =
  null;

function shortcutsFor(overrides: KeymapOverrides): Shortcuts {
  const actions = registry.all();
  if (cached?.overrides !== overrides || cached.actions !== actions.length) {
    cached = { overrides, actions: actions.length, shortcuts: effectiveShortcuts(actions, overrides) };
  }
  return cached.shortcuts;
}

/** The keymap in effect now: the registry's chords with `settings.json`'s overrides (decision 154). */
export function currentShortcuts(): Shortcuts {
  return shortcutsFor(useSettings.getState().settings.keymap);
}

/** The chord labels show for `actionId`: its first, or undefined when it has none. */
export function shortcutOf(actionId: string): Chord | undefined {
  return currentShortcuts().get(actionId)?.[0];
}

/** `actionId`'s chord as this platform writes it, or `""` when it has none. */
export function shortcutText(actionId: string): string {
  const chord = shortcutOf(actionId);
  return chord === undefined ? "" : formatChord(chord, currentPlatform());
}

/**
 * `actionId`'s chord as this platform writes it, or undefined when it has none, redrawn when the
 * keymap changes; every label of a chord reads it (decision 154).
 */
export function useShortcut(actionId: string): string | undefined {
  return useSettings((state) => {
    const chord = shortcutsFor(state.settings.keymap).get(actionId)?.[0];
    return chord === undefined ? undefined : formatChord(chord, currentPlatform());
  });
}
