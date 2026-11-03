import {
  type Chord,
  chordKey,
  createDoubleTapDetector,
  DOUBLE_TAP_WINDOW_MS,
  matches,
  parseChord,
  type ParsedChord,
  type Platform,
  type TimedKey,
} from "@table-craft/desktop/renderer/actions/chords.js";
import type { FocusRegion } from "@table-craft/desktop/renderer/actions/context.js";
import { effectiveShortcuts, type Shortcuts } from "@table-craft/desktop/renderer/actions/keymapOverrides.js";
import type { ActionRegistry, AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";

/** The parts of a `KeyboardEvent` the keymap reads and acts on. */
export interface KeyEventLike extends TimedKey {
  readonly isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface KeymapOptions {
  readonly registry: ActionRegistry;
  readonly platform: Platform;
  /** While the palette or a dialog is open, it owns the keyboard. */
  readonly paletteOpen: () => boolean;
  /** Where focus is, for shortcuts scoped to a region; absent, every scoped shortcut works. */
  readonly focusedRegion?: () => FocusRegion;
  /** Chords the focused control keeps for itself, such as the SQL editor's undo; the registry lets them pass. */
  readonly reservedChords?: () => readonly Chord[];
  /** The keymap in effect, read on every key; absent, each action's declared chord (decision 153). */
  readonly shortcuts?: () => Shortcuts;
  readonly doubleTapWindowMs?: number;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** Whether `action`'s shortcut may fire while focus is in `region`. */
export function shortcutWorksIn(action: Pick<AnyAction, "shortcutRegion">, region: FocusRegion): boolean {
  const scope = action.shortcutRegion;
  if (scope === undefined) return true;
  return typeof scope === "string" ? scope === region : scope.includes(region);
}

/** The keydown handler: runs the action whose chord this is, if it is enabled, exactly once. */
export function createKeyDispatcher(options: KeymapOptions): (event: KeyEventLike) => void {
  const { registry, platform, paletteOpen } = options;
  const doubleTaps = createDoubleTapDetector(options.doubleTapWindowMs ?? DOUBLE_TAP_WINDOW_MS);
  const parsed = new Map<Chord, ParsedChord>();
  const shortcuts = options.shortcuts ?? (() => effectiveShortcuts(registry.all()));

  function parsedChord(chord: Chord): ParsedChord {
    let parsedOne = parsed.get(chord);
    if (parsedOne === undefined) {
      parsedOne = parseChord(chord, platform);
      parsed.set(chord, parsedOne);
    }
    return parsedOne;
  }

  function holding(keymap: Shortcuts, action: AnyAction, test: (chord: ParsedChord) => boolean): boolean {
    return (keymap.get(action.id) ?? []).some((chord) => test(parsedChord(chord)));
  }

  function inRegion(action: AnyAction): boolean {
    return options.focusedRegion === undefined || shortcutWorksIn(action, options.focusedRegion());
  }

  function reserved(event: KeyEventLike): boolean {
    return (options.reservedChords?.() ?? []).some((chord) => matches(parseChord(chord, platform), event));
  }

  function dispatch(event: KeyEventLike, candidates: readonly AnyAction[]): void {
    for (const action of preemptingFirst(candidates)) {
      if (!inRegion(action)) continue;
      if (registry.invoke(action.id) !== "ran") continue;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  return (event) => {
    if (event.isComposing === true) return;
    if (paletteOpen()) {
      doubleTaps.reset();
      return;
    }
    const actions = registry.all();
    const keymap = shortcuts();
    const tapped = doubleTaps.feed(event);
    if (tapped !== null) {
      dispatch(
        event,
        actions.filter((action) =>
          holding(keymap, action, (chord) => chord.kind === "doubleTap" && chord.modifier === tapped),
        ),
      );
      return;
    }
    if (MODIFIER_KEYS.has(event.key) || reserved(event)) return;
    dispatch(
      event,
      actions.filter((action) => holding(keymap, action, (chord) => matches(chord, event))),
    );
  };
}

/** Listens in the capture phase, so a chord reaches the registry before any focused control. */
export function installKeymap(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  options: KeymapOptions,
) {
  const dispatcher = createKeyDispatcher(options);
  const listener = (event: KeyboardEvent) => dispatcher(event);
  target.addEventListener("keydown", listener, { capture: true });
  return () => target.removeEventListener("keydown", listener, { capture: true });
}

export interface Clash {
  readonly platform: Platform;
  readonly chord: string;
  readonly ids: readonly string[];
}

function regionsOf(action: AnyAction): readonly FocusRegion[] | null {
  const scope = action.shortcutRegion;
  if (scope === undefined) return null;
  return typeof scope === "string" ? [scope] : scope;
}

/** `candidates` with each action that preempts another ahead of the ones it preempts. */
function preemptingFirst(candidates: readonly AnyAction[]): readonly AnyAction[] {
  const preempted = new Set(candidates.flatMap((action) => action.preempts ?? []));
  return [
    ...candidates.filter((action) => !preempted.has(action.id)),
    ...candidates.filter((action) => preempted.has(action.id)),
  ];
}

function preempts(a: AnyAction, b: AnyAction): boolean {
  return a.preempts?.includes(b.id) === true || b.preempts?.includes(a.id) === true;
}

/**
 * Whether two actions' shortcuts can both be live at once: their regions and tab kinds overlap,
 * and neither declares it goes first.
 */
function overlap(a: AnyAction, b: AnyAction): boolean {
  if (preempts(a, b)) return false;
  if (a.tabKind !== undefined && b.tabKind !== undefined && a.tabKind !== b.tabKind) return false;
  const regionsA = regionsOf(a);
  const regionsB = regionsOf(b);
  return regionsA === null || regionsB === null || regionsA.some((region) => regionsB.includes(region));
}

/**
 * Chords two or more actions hold where both could fire: in a shared region on a shared tab kind.
 * `shortcuts` is the keymap to check, each action's declared chord when absent. The keymap test
 * fails on any; the Keymap page offers Reassign on one (decision 153).
 */
export function findClashes(
  actions: readonly AnyAction[],
  shortcuts: Shortcuts = effectiveShortcuts(actions),
): readonly Clash[] {
  const clashes: Clash[] = [];
  for (const platform of ["mac", "other"] as const) {
    const byChord = new Map<string, AnyAction[]>();
    for (const action of actions) {
      const keys = new Set((shortcuts.get(action.id) ?? []).map((chord) => chordKey(parseChord(chord, platform))));
      for (const key of keys) byChord.set(key, [...(byChord.get(key) ?? []), action]);
    }
    for (const [chord, sharing] of byChord) {
      const clashing = sharing.filter((action) => sharing.some((other) => other !== action && overlap(action, other)));
      if (clashing.length > 1) clashes.push({ platform, chord, ids: clashing.map((action) => action.id) });
    }
  }
  return clashes;
}

/** Actions whose shortcut would fire in `region` on a chord that region's control keeps (`reserved`). */
export function findReservedClashes(
  actions: readonly AnyAction[],
  reserved: readonly Chord[],
  region: FocusRegion,
): readonly Clash[] {
  const clashes: Clash[] = [];
  for (const platform of ["mac", "other"] as const) {
    for (const chord of reserved) {
      const key = chordKey(parseChord(chord, platform));
      const ids = actions
        .filter((action) => action.shortcut !== undefined && shortcutWorksIn(action, region))
        .filter((action) => chordKey(parseChord(action.shortcut ?? "", platform)) === key)
        .map((action) => action.id);
      if (ids.length > 0) clashes.push({ platform, chord: key, ids });
    }
  }
  return clashes;
}
