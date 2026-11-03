/**
 * Keyboard chords in one platform-neutral spelling: `"Mod+Shift+A"`, `"Mod+Enter"`, `"Escape"`, and
 * `"Shift Shift"` for a double-tap. `Mod` is `⌘` on macOS and `Ctrl` elsewhere (decision 015).
 * Pure, so main (the native menu) and the settings reader share it with the renderer.
 */

export type Platform = "mac" | "other";

export const PLATFORMS: readonly Platform[] = ["mac", "other"];

/** A chord as declared on an action, e.g. `"Mod+Shift+A"`. */
export type Chord = string;

/** `settings.json`'s `keymap`: an action id's chords in place of its default; `[]` is none (decision 153). */
export type KeymapOverrides = Readonly<Record<string, readonly Chord[]>>;

export type Modifier = "Mod" | "Ctrl" | "Alt" | "Shift";

/** One key with the modifiers held, resolved for a platform. */
export interface Stroke {
  readonly kind: "stroke";
  readonly key: string;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** The same modifier pressed and released twice, with nothing between. */
export interface DoubleTap {
  readonly kind: "doubleTap";
  readonly modifier: Exclude<Modifier, "Mod">;
}

export type ParsedChord = Stroke | DoubleTap;

const MODIFIERS: readonly Modifier[] = ["Mod", "Ctrl", "Alt", "Shift"];
const DOUBLE_TAP_SEPARATOR = " ";
const STROKE_SEPARATOR = "+";

const MAC_GLYPHS: Readonly<Record<string, string>> = {
  Enter: "↩",
  Escape: "⎋",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
const MAC_MODIFIER_GLYPHS = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" } as const;
const MAC_DOUBLE_TAP_GLYPHS: Readonly<Record<DoubleTap["modifier"], string>> = {
  Ctrl: "⌃⌃",
  Alt: "⌥⌥",
  Shift: "⇧⇧",
};
const OTHER_KEY_NAMES: Readonly<Record<string, string>> = { Escape: "Esc" };

/** Electron's accelerator names where they differ from a chord's key (electronjs.org/docs/latest/api/accelerator). */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};
const ACCELERATOR_MOD = "CmdOrCtrl";

function isModifier(part: string): part is Modifier {
  return (MODIFIERS as readonly string[]).includes(part);
}

/** Parses a declared chord for `platform`; throws on a spelling no action should ship with. */
export function parseChord(chord: Chord, platform: Platform): ParsedChord {
  const taps = chord.split(DOUBLE_TAP_SEPARATOR);
  if (taps.length === 2) {
    const [first, second] = taps;
    if (first !== second || first === undefined || !isModifier(first) || first === "Mod") {
      throw new Error(`Chord "${chord}" is not a double-tap of Ctrl, Alt or Shift.`);
    }
    return { kind: "doubleTap", modifier: first };
  }
  const parts = chord.split(STROKE_SEPARATOR);
  const key = parts.pop();
  if (key === undefined || key === "" || isModifier(key) || !parts.every(isModifier)) {
    throw new Error(`Chord "${chord}" must be modifiers joined by "+" and then one key, like "Mod+Shift+A".`);
  }
  const has = (modifier: Modifier) => parts.includes(modifier);
  const mod = has("Mod");
  return {
    kind: "stroke",
    key: key.length === 1 ? key.toUpperCase() : key,
    meta: mod && platform === "mac",
    ctrl: has("Ctrl") || (mod && platform === "other"),
    alt: has("Alt"),
    shift: has("Shift"),
  };
}

/** Whether `chord` parses on every platform, as a chord read from `settings.json` must. */
export function isChord(chord: unknown): chord is Chord {
  if (typeof chord !== "string") return false;
  try {
    for (const platform of PLATFORMS) parseChord(chord, platform);
    return true;
  } catch {
    return false;
  }
}

/** A stable string for a parsed chord, so two declarations of the same keys compare equal. */
export function chordKey(chord: ParsedChord): string {
  if (chord.kind === "doubleTap") return `${chord.modifier}${DOUBLE_TAP_SEPARATOR}${chord.modifier}`;
  const held = [chord.ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", chord.meta && "meta"].filter(Boolean);
  return [...held, chord.key].join(STROKE_SEPARATOR);
}

/** Whether two chords press the same keys on `platform`, however each is spelled. */
export function sameChord(a: Chord, b: Chord, platform: Platform): boolean {
  return chordKey(parseChord(a, platform)) === chordKey(parseChord(b, platform));
}

/** How a chord reads in menus and the palette: `⇧⌘A` on macOS, `Ctrl+Shift+A` elsewhere. */
export function formatChord(chord: Chord, platform: Platform): string {
  const parsed = parseChord(chord, platform);
  if (platform === "mac") {
    if (parsed.kind === "doubleTap") return MAC_DOUBLE_TAP_GLYPHS[parsed.modifier];
    const held = (["ctrl", "alt", "shift", "meta"] as const).filter((name) => parsed[name]);
    return held.map((name) => MAC_MODIFIER_GLYPHS[name]).join("") + (MAC_GLYPHS[parsed.key] ?? parsed.key);
  }
  if (parsed.kind === "doubleTap") return `Double ${parsed.modifier}`;
  const held = [parsed.ctrl && "Ctrl", parsed.alt && "Alt", parsed.shift && "Shift"].filter(Boolean);
  return [...held, OTHER_KEY_NAMES[parsed.key] ?? parsed.key].join(STROKE_SEPARATOR);
}

/** Electron's spelling of `chord` for a menu item, `Mod+Shift+F` as `CmdOrCtrl+Shift+F`; null for a double-tap, which Electron cannot express. */
export function menuAccelerator(chord: Chord): string | null {
  if (!isChord(chord) || chord.split(DOUBLE_TAP_SEPARATOR).length === 2) return null;
  const parts = chord.split(STROKE_SEPARATOR);
  const key = parts.pop() ?? "";
  const held = (["Mod", "Ctrl", "Alt", "Shift"] as const)
    .filter((modifier) => parts.includes(modifier))
    .map((modifier) => (modifier === "Mod" ? ACCELERATOR_MOD : modifier));
  const name = ACCELERATOR_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...held, name].join(STROKE_SEPARATOR);
}

/** A chord the app menu's roles or the operating system take before TableCraft sees it, and who does. */
export interface ReservedChord {
  readonly chord: Chord;
  readonly owner: string;
}

/** Chords the Keymap page refuses to record (decision 153): macOS's app menu roles and window keys, Windows' and Linux's window keys. */
export const RESERVED_CHORDS: Readonly<Record<Platform, readonly ReservedChord[]>> = {
  mac: [
    { chord: "Mod+Q", owner: "Quit TableCraft" },
    { chord: "Mod+H", owner: "Hide TableCraft" },
    { chord: "Mod+Alt+H", owner: "Hide Others" },
    { chord: "Mod+M", owner: "Minimize" },
    { chord: "Mod+Tab", owner: "macOS's app switcher" },
    { chord: "Mod+Space", owner: "Spotlight" },
    { chord: "Mod+`", owner: "macOS's window switcher" },
  ],
  other: [
    { chord: "Alt+F4", owner: "Close Window" },
    { chord: "Alt+Tab", owner: "the window switcher" },
  ],
};

/** Who takes `chord` on `platform` before TableCraft does, or null when nobody does. */
export function reservedOwner(chord: Chord, platform: Platform): string | null {
  return RESERVED_CHORDS[platform].find((reserved) => sameChord(reserved.chord, chord, platform))?.owner ?? null;
}
