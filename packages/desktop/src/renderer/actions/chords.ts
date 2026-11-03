/** Matching key events against chords; the spelling itself is shared with main in `settings/chords.ts`. */
import {
  chordKey,
  type DoubleTap,
  type ParsedChord,
  type Platform,
  type Stroke,
} from "@table-craft/desktop/settings/chords.js";

export {
  chordKey,
  formatChord,
  isChord,
  parseChord,
  sameChord,
  type Chord,
  type DoubleTap,
  type Modifier,
  type ParsedChord,
  type Platform,
  type Stroke,
} from "@table-craft/desktop/settings/chords.js";

/** The fields of a `KeyboardEvent` that chord matching reads. */
export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** `KeyboardEvent.code` names whose key is the character they print unshifted on a US layout. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  NumpadEnter: "Enter",
};
const LETTER_CODE_PREFIX = "Key";
const DIGIT_CODE_PREFIX = "Digit";

/** The physical key an event is for, in a chord's spelling. Physical, so `Shift+]` stays `]`. */
export function keyOf(event: Pick<KeyLike, "key" | "code">): string {
  const named = CODE_KEYS[event.code];
  if (named !== undefined) return named;
  if (event.code.startsWith(LETTER_CODE_PREFIX)) return event.code.slice(LETTER_CODE_PREFIX.length);
  if (event.code.startsWith(DIGIT_CODE_PREFIX)) return event.code.slice(DIGIT_CODE_PREFIX.length);
  if (event.code !== "") return event.code;
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

export function strokeOf(event: KeyLike): Stroke {
  return {
    kind: "stroke",
    key: keyOf(event),
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
}

export function matches(chord: ParsedChord, event: KeyLike): boolean {
  return chord.kind === "stroke" && chordKey(chord) === chordKey(strokeOf(event));
}

/** DataGrip's double-Shift window; slower presses read as two separate Shifts. */
export const DOUBLE_TAP_WINDOW_MS = 300;

const TAP_MODIFIERS: Readonly<Record<string, DoubleTap["modifier"]>> = {
  Shift: "Shift",
  Control: "Ctrl",
  Alt: "Alt",
};

export interface TimedKey extends KeyLike {
  readonly repeat: boolean;
  /** Milliseconds, as `KeyboardEvent.timeStamp`. */
  readonly timeStamp: number;
}

export interface DoubleTapDetector {
  /** Feeds every keydown; answers the modifier when this one completes a double-tap. */
  feed(event: TimedKey): DoubleTap["modifier"] | null;
  reset(): void;
}

export function createDoubleTapDetector(windowMs: number = DOUBLE_TAP_WINDOW_MS): DoubleTapDetector {
  let last: { readonly modifier: DoubleTap["modifier"]; readonly at: number } | null = null;
  return {
    feed(event) {
      const modifier = TAP_MODIFIERS[event.key];
      const heldModifiers = [event.shiftKey, event.ctrlKey, event.altKey, event.metaKey].filter(Boolean).length;
      if (modifier === undefined || heldModifiers > 1) {
        last = null;
        return null;
      }
      if (event.repeat) return null;
      if (last !== null && last.modifier === modifier && event.timeStamp - last.at <= windowMs) {
        last = null;
        return modifier;
      }
      last = { modifier, at: event.timeStamp };
      return null;
    },
    reset() {
      last = null;
    },
  };
}

/** The platform this renderer runs on; a function so tests never depend on the machine. */
export function currentPlatform(): Platform {
  return /Mac/i.test(navigator.platform) ? "mac" : "other";
}
