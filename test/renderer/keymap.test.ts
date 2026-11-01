import { describe, expect, it, vi } from "vitest";
import { ALL_ACTIONS } from "@table-craft/desktop/renderer/actions/allActions.js";
import type { FocusRegion } from "@table-craft/desktop/renderer/actions/context.js";
import { createKeyDispatcher, findClashes, findReservedClashes } from "@table-craft/desktop/renderer/actions/keymap.js";
import { GRID_ACTION_IDS } from "@table-craft/desktop/renderer/actions/gridActions.js";
import { NAVIGATION_ACTION_IDS } from "@table-craft/desktop/renderer/actions/navigationActions.js";
import { createActionRegistry, defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { WINDOW_ACTION_IDS } from "@table-craft/desktop/renderer/actions/windowActions.js";
import { EDITOR_FIND_ACTION_IDS } from "@table-craft/desktop/renderer/actions/editorFindActions.js";
import { EDITOR_CHORDS, FIELD_CHORDS, FIND_FIELD_CHORDS } from "@table-craft/desktop/renderer/console/editorKeys.js";
import { IDLE_CONTEXT, keydown } from "./support.js";

function dispatcherWith(enabled: boolean, paletteOpen = false) {
  const searched = vi.fn();
  const ran = vi.fn();
  const registry = createActionRegistry(() => IDLE_CONTEXT);
  registry.register([
    defineAction({ id: "search", title: "Search", category: "Navigation", shortcut: "Shift Shift", run: searched }),
    defineAction({
      id: "run",
      title: "Run",
      category: "Console",
      shortcut: "Mod+Enter",
      when: () => enabled,
      run: ran,
    }),
  ]);
  const dispatch = createKeyDispatcher({ registry, platform: "mac", paletteOpen: () => paletteOpen });
  return { dispatch, searched, ran };
}

describe("keymap", () => {
  it("givenRegisteredActions_whenShortcutsCompared_thenNoTwoShareAChord", () => {
    expect(findClashes(ALL_ACTIONS)).toEqual([]);
  });

  it("givenWindowActions_whenRegistered_thenEachHasNoChord", () => {
    const ids: readonly string[] = Object.values(WINDOW_ACTION_IDS);
    const registered = ALL_ACTIONS.filter((action) => ids.includes(action.id));

    expect(registered.map((action) => action.id).sort()).toEqual([...ids].sort());
    expect(registered.filter((action) => action.shortcut !== undefined)).toEqual([]);
  });

  it("givenEditorChords_whenComparedWithKeymap_thenNoClash", () => {
    expect(findReservedClashes(ALL_ACTIONS, EDITOR_CHORDS, "editor")).toEqual([]);
  });

  it("givenActionOnEditorChordOutsideEditorOnly_whenCompared_thenNoClashButUnscopedOneClashes", () => {
    const run = () => undefined;
    const scoped = defineAction({
      id: "scoped",
      title: "Scoped",
      category: "Database",
      shortcut: "Mod+D",
      shortcutRegion: ["database", "services"],
      run,
    });
    const unscoped = defineAction({ id: "unscoped", title: "Unscoped", category: "Console", shortcut: "Mod+/", run });

    const clashes = findReservedClashes([scoped, unscoped], EDITOR_CHORDS, "editor");

    expect(clashes.map((clash) => clash.ids)).toEqual([["unscoped"], ["unscoped"]]);
  });

  it("givenReservedChord_whenPressedInEditor_thenRegistryLetsItPass", () => {
    const ran = vi.fn();
    const registry = createActionRegistry(() => IDLE_CONTEXT);
    registry.register([defineAction({ id: "undo", title: "Undo", category: "Console", shortcut: "Mod+Z", run: ran })]);
    let reserved: readonly string[] = EDITOR_CHORDS;
    const dispatch = createKeyDispatcher({
      registry,
      platform: "mac",
      paletteOpen: () => false,
      reservedChords: () => reserved,
    });

    const inEditor = keydown({ key: "z", metaKey: true });
    dispatch(inEditor);
    reserved = [];
    const elsewhere = keydown({ key: "z", metaKey: true });
    dispatch(elsewhere);

    expect(inEditor.prevented()).toBe(false);
    expect(elsewhere.prevented()).toBe(true);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("givenActionScopedToSeveralRegions_whenFocusMoves_thenFiresOnlyInThem", () => {
    const ran = vi.fn();
    const registry = createActionRegistry(() => IDLE_CONTEXT);
    registry.register([
      defineAction({
        id: "back",
        title: "Back",
        category: "Navigation",
        shortcut: "Escape",
        shortcutRegion: ["database", "services"],
        run: ran,
      }),
    ]);
    let region: FocusRegion = "services";
    const dispatch = createKeyDispatcher({
      registry,
      platform: "mac",
      paletteOpen: () => false,
      focusedRegion: () => region,
    });

    dispatch(keydown({ key: "Escape" }));
    region = "editor";
    dispatch(keydown({ key: "Escape" }));

    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("givenTwoActionsOnOneChord_whenCompared_thenClashNamesBoth", () => {
    const run = () => undefined;
    const clashes = findClashes([
      defineAction({ id: "a", title: "A", category: "Console", shortcut: "Mod+Shift+A", run }),
      defineAction({ id: "b", title: "B", category: "Console", shortcut: "Mod+Shift+A", run }),
    ]);

    expect(clashes.map((clash) => clash.ids)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  it("givenShiftTwiceWithin300ms_whenDispatched_thenSearchEverywhereRuns", () => {
    const { dispatch, searched } = dispatcherWith(true);

    dispatch(keydown({ key: "Shift", timeStamp: 1000 }));
    dispatch(keydown({ key: "Shift", timeStamp: 1250 }));

    expect(searched).toHaveBeenCalledOnce();
  });

  it("givenShiftTwiceTooSlowly_whenDispatched_thenNoDoubleTap", () => {
    const { dispatch, searched } = dispatcherWith(true);

    dispatch(keydown({ key: "Shift", timeStamp: 1000 }));
    dispatch(keydown({ key: "Shift", timeStamp: 1400 }));

    expect(searched).not.toHaveBeenCalled();
  });

  it("givenShiftAThenShift_whenDispatched_thenNoDoubleTap", () => {
    const { dispatch, searched } = dispatcherWith(true);

    dispatch(keydown({ key: "Shift", timeStamp: 1000 }));
    dispatch(keydown({ key: "A", shiftKey: true, timeStamp: 1050 }));
    dispatch(keydown({ key: "Shift", timeStamp: 1100 }));

    expect(searched).not.toHaveBeenCalled();
  });

  it("givenChordForEnabledAction_whenPressed_thenRunsOnceAndEventPrevented", () => {
    const { dispatch, ran } = dispatcherWith(true);
    const event = keydown({ key: "Enter", metaKey: true });

    dispatch(event);

    expect(ran).toHaveBeenCalledOnce();
    expect(event.prevented()).toBe(true);
  });

  it("givenChordForDisabledAction_whenPressed_thenEventNotPrevented", () => {
    const { dispatch, ran } = dispatcherWith(false);
    const event = keydown({ key: "Enter", metaKey: true });

    dispatch(event);

    expect(ran).not.toHaveBeenCalled();
    expect(event.prevented()).toBe(false);
  });

  it("givenPaletteOpen_whenChordPressed_thenItPassesToThePalette", () => {
    const { dispatch, ran } = dispatcherWith(true, true);
    const event = keydown({ key: "Enter", metaKey: true });

    dispatch(event);

    expect(ran).not.toHaveBeenCalled();
    expect(event.prevented()).toBe(false);
  });

  it("givenShortcutScopedToDatabasePane_whenPressedInEditor_thenPassesThroughAndRunsInPane", () => {
    const created = vi.fn();
    const registry = createActionRegistry(() => IDLE_CONTEXT);
    registry.register([
      defineAction({
        id: "new",
        title: "New Data Source",
        category: "Database",
        shortcut: "Mod+N",
        shortcutRegion: "database",
        run: created,
      }),
    ]);
    let region: "editor" | "database" = "editor";
    const dispatch = createKeyDispatcher({
      registry,
      platform: "mac",
      paletteOpen: () => false,
      focusedRegion: () => region,
    });

    const inEditor = keydown({ key: "n", metaKey: true });
    dispatch(inEditor);
    region = "database";
    const inPane = keydown({ key: "n", metaKey: true });
    dispatch(inPane);

    expect(inEditor.prevented()).toBe(false);
    expect(inPane.prevented()).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
  });
});

describe("grid keymap", () => {
  function dispatcherIn(region: () => FocusRegion) {
    const ran: string[] = [];
    const registry = createActionRegistry(() => IDLE_CONTEXT);
    registry.register(
      ALL_ACTIONS.map((action) => ({ ...action, when: undefined, run: () => void ran.push(action.id) })),
    );
    const dispatch = createKeyDispatcher({
      registry,
      platform: "mac",
      paletteOpen: () => false,
      focusedRegion: region,
    });
    return { dispatch, ran };
  }

  it("givenGridFocused_whenModC_thenGridCopyNotEditorCopy", () => {
    let region: FocusRegion = "grid";
    const { dispatch, ran } = dispatcherIn(() => region);

    const inGrid = keydown({ key: "c", metaKey: true });
    dispatch(inGrid);
    region = "editor";
    const inEditor = keydown({ key: "c", metaKey: true });
    dispatch(inEditor);

    expect(ran).toEqual(["grid.copy"]);
    expect(inGrid.prevented()).toBe(true);
    expect(inEditor.prevented()).toBe(false);
  });

  it("givenGridFocused_whenGridChordsPressed_thenGridActionsRun", () => {
    const { dispatch, ran } = dispatcherIn(() => "grid");

    dispatch(keydown({ key: "a", metaKey: true }));
    dispatch(keydown({ key: "Enter", code: "Enter", shiftKey: true }));
    dispatch(keydown({ key: "r", metaKey: true }));

    expect(ran).toEqual(["grid.selectAll", "grid.toggleValuePanel", "grid.rerun"]);
  });

  it("givenModP_whenPressedInEachRegion_thenParameterInfoOnlyInSqlFields", () => {
    let region: FocusRegion = "editor";
    const { dispatch, ran } = dispatcherIn(() => region);

    for (const where of ["editor", "tableEditor", "grid", "database"] as const) {
      region = where;
      dispatch(keydown({ key: "p", metaKey: true }));
    }

    expect(ran).toEqual([NAVIGATION_ACTION_IDS.parameterInfo, NAVIGATION_ACTION_IDS.parameterInfo]);
    expect(EDITOR_CHORDS).not.toContain("Mod+P");
  });

  it("givenModMinus_whenPressedInEditorThenDatabasePane_thenZoomOutThenCollapseAll", () => {
    let region: FocusRegion = "editor";
    const { dispatch, ran } = dispatcherIn(() => region);

    dispatch(keydown({ key: "=", code: "Equal", metaKey: true }));
    dispatch(keydown({ key: "-", code: "Minus", metaKey: true }));
    dispatch(keydown({ key: "0", code: "Digit0", metaKey: true }));
    region = "database";
    dispatch(keydown({ key: "-", code: "Minus", metaKey: true }));

    expect(ran).toEqual(["editor.zoomIn", "editor.zoomOut", "editor.zoomReset", "explorer.collapseAll"]);
  });

  it("givenGridChords_whenListed_thenAllScopedToTheGridItsFindBarOrValuePanel", () => {
    const gridChords = ALL_ACTIONS.filter(
      (action) => action.category === "Result Grid" && action.shortcut !== undefined,
    );
    const scoped = (action: AnyAction) => {
      const regions = typeof action.shortcutRegion === "string" ? [action.shortcutRegion] : action.shortcutRegion;
      return (
        regions !== undefined &&
        regions.every((region) => region === "grid" || region === "gridFind" || region === "valuePanel")
      );
    };
    expect(gridChords.every(scoped)).toBe(true);
    expect(gridChords.map((action) => [action.shortcut, action.shortcutRegion])).toEqual([
      ["Mod+R", "grid"],
      ["Mod+C", "grid"],
      ["Mod+A", "grid"],
      ["Shift+Enter", "grid"],
      ["Mod+Alt+J", ["grid", "valuePanel"]],
      ["Mod+F", ["grid", "gridFind"]],
      ["Enter", "gridFind"],
      ["Shift+Enter", "gridFind"],
      ["Escape", "gridFind"],
      ["Mod+Alt+T", "grid"],
      ["Mod+B", "grid"],
    ]);
  });

  it("givenModAltJ_whenKeymapBuilt_thenToggleJsonViewHasItAlone", () => {
    const holders = ALL_ACTIONS.filter((action) => action.shortcut === "Mod+Alt+J").map((action) => action.id);

    expect(holders).toEqual([GRID_ACTION_IDS.toggleJsonView]);
  });

  it("givenFindInResult_whenFocusInEditorOrGrid_thenOnlyTheGridOpensIt", () => {
    let region: FocusRegion = "editor";
    const ran: string[] = [];
    const find = ALL_ACTIONS.find((action) => action.id === GRID_ACTION_IDS.find);
    expect(find).toBeDefined();
    const registry = createActionRegistry(() => IDLE_CONTEXT);
    registry.register([{ ...(find as AnyAction), when: () => true, run: () => void ran.push("find") }]);
    const dispatch = createKeyDispatcher({
      registry,
      platform: "mac",
      paletteOpen: () => false,
      focusedRegion: () => region,
      reservedChords: () => (region === "editor" ? EDITOR_CHORDS : region === "gridFind" ? FIELD_CHORDS : []),
    });

    dispatch(keydown({ key: "f", code: "KeyF", metaKey: true }));
    region = "grid";
    dispatch(keydown({ key: "f", code: "KeyF", metaKey: true }));
    region = "gridFind";
    dispatch(keydown({ key: "f", code: "KeyF", metaKey: true }));

    expect(ran).toEqual(["find", "find"]);
    expect(findReservedClashes(ALL_ACTIONS, FIELD_CHORDS, "gridFind")).toEqual([]);
  });
});

describe("console find keymap", () => {
  const findIds: readonly string[] = Object.values(EDITOR_FIND_ACTION_IDS);

  function dispatcherIn(region: () => FocusRegion) {
    const ran: string[] = [];
    const registry = createActionRegistry(() => ({
      ...IDLE_CONTEXT,
      activeTab: { id: "console-0", kind: "console", title: "console" },
    }));
    registry.register(
      ALL_ACTIONS.map((action) => ({ ...action, when: undefined, run: () => void ran.push(action.id) })),
    );
    const dispatch = createKeyDispatcher({
      registry,
      platform: "mac",
      paletteOpen: () => false,
      focusedRegion: region,
    });
    return { dispatch, ran };
  }

  it("givenEditorChords_whenModFRemoved_thenConsoleFindOwnsIt", () => {
    expect(EDITOR_CHORDS).not.toContain("Mod+F");
    expect(EDITOR_CHORDS).toEqual(expect.arrayContaining(["F3", "Shift+F3", "Escape"]));
    expect(ALL_ACTIONS.filter((action) => action.shortcut === "Mod+F").map((action) => action.id)).toEqual(
      expect.arrayContaining([EDITOR_FIND_ACTION_IDS.find, GRID_ACTION_IDS.find]),
    );
  });

  it("givenFindChords_whenListed_thenAllScopedToTheEditorOrItsFindBar", () => {
    const chords = ALL_ACTIONS.filter((action) => findIds.includes(action.id) && action.shortcut !== undefined);

    expect(chords.map((action) => [action.shortcut, action.shortcutRegion])).toEqual([
      ["Mod+F", ["editor", "editorFind", "editorReplace"]],
      ["Mod+R", ["editor", "editorFind", "editorReplace"]],
      ["Mod+G", ["editor", "editorFind", "editorReplace"]],
      ["Shift+Mod+G", ["editor", "editorFind", "editorReplace"]],
      ["Enter", "editorFind"],
      ["Shift+Enter", "editorFind"],
      ["Enter", "editorReplace"],
      ["Mod+Alt+Enter", ["editorFind", "editorReplace"]],
      ["Mod+Alt+Shift+J", ["editor", "editorFind", "editorReplace"]],
      ["Alt+C", ["editorFind", "editorReplace"]],
      ["Alt+W", ["editorFind", "editorReplace"]],
      ["Alt+X", ["editorFind", "editorReplace"]],
      ["Alt+P", ["editorFind", "editorReplace"]],
    ]);
  });

  it("givenFindBarFields_whenComparedWithKeymap_thenNoClash", () => {
    expect(findReservedClashes(ALL_ACTIONS, FIND_FIELD_CHORDS, "editorFind")).toEqual([]);
    expect(findReservedClashes(ALL_ACTIONS, FIND_FIELD_CHORDS, "editorReplace")).toEqual([]);
  });

  it("givenModFAndModR_whenPressedInEditorThenGrid_thenConsoleFindThenGridActions", () => {
    let region: FocusRegion = "editor";
    const { dispatch, ran } = dispatcherIn(() => region);

    dispatch(keydown({ key: "f", code: "KeyF", metaKey: true }));
    dispatch(keydown({ key: "r", code: "KeyR", metaKey: true }));
    region = "grid";
    dispatch(keydown({ key: "f", code: "KeyF", metaKey: true }));
    dispatch(keydown({ key: "r", code: "KeyR", metaKey: true }));

    expect(ran).toEqual([
      EDITOR_FIND_ACTION_IDS.find,
      EDITOR_FIND_ACTION_IDS.replace,
      GRID_ACTION_IDS.find,
      GRID_ACTION_IDS.rerun,
    ]);
  });

  it("givenEnter_whenPressedInFindThenReplaceRow_thenFindNextThenReplace", () => {
    let region: FocusRegion = "editorFind";
    const { dispatch, ran } = dispatcherIn(() => region);

    dispatch(keydown({ key: "Enter", code: "Enter" }));
    dispatch(keydown({ key: "Enter", code: "Enter", shiftKey: true }));
    region = "editorReplace";
    dispatch(keydown({ key: "Enter", code: "Enter" }));

    expect(ran).toEqual([
      EDITOR_FIND_ACTION_IDS.findNextInField,
      EDITOR_FIND_ACTION_IDS.findPreviousInField,
      EDITOR_FIND_ACTION_IDS.replaceOne,
    ]);
  });
});

describe("table editor keymap", () => {
  const tableActions = ALL_ACTIONS.filter((action) => action.category === "Table Editor");

  it("givenTableActions_whenKeymapBuilt_thenNoChordClash", () => {
    expect(findClashes(tableActions)).toEqual([]);
    expect(findClashes(ALL_ACTIONS)).toEqual([]);
    // The WHERE and ORDER BY bars are SQL editors in the table editor's region.
    expect(findReservedClashes(ALL_ACTIONS, EDITOR_CHORDS, "tableEditor")).toEqual([]);
  });

  it("givenTableTabActive_whenModEnterInGrid_thenSubmitRunsNotConsoleRun", () => {
    const ran: string[] = [];
    const registry = createActionRegistry(() => ({
      ...IDLE_CONTEXT,
      activeTab: { id: "table-0", kind: "table", title: "orders" },
    }));
    registry.register(
      ALL_ACTIONS.filter((action) => action.shortcut === "Mod+Enter").map((action) =>
        defineAction({ ...action, when: undefined, run: () => void ran.push(action.id) }),
      ),
    );
    const dispatch = createKeyDispatcher({
      registry,
      platform: "mac",
      paletteOpen: () => false,
      focusedRegion: () => "grid",
    });

    dispatch(keydown({ key: "Enter", code: "Enter", metaKey: true }));

    expect(ran).toEqual(["table.submit"]);
  });

  it("givenTableShortcuts_whenListed_thenEachScopedToARegion", () => {
    const bound = tableActions.filter((action) => action.shortcut !== undefined);
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every((action) => action.shortcutRegion !== undefined)).toBe(true);
  });

  it("givenModEnter_whenListed_thenRunInConsolesAndSubmitAheadOfIt", () => {
    const owners = ALL_ACTIONS.filter((action) => action.shortcut === "Mod+Enter").map((action) => [
      action.id,
      action.tabKind,
      action.preempts,
    ]);
    expect(owners).toEqual([
      ["console.run", "console", undefined],
      ["table.submit", undefined, ["console.run"]],
      ["table.applyValue", undefined, ["console.run"]],
    ]);
  });

  it.each([
    [true, ["table.submit"]],
    [false, ["console.run"]],
  ])("givenConsoleGridWithPendingEdits_%s_whenModEnter_thenSubmitElseRun", (pending, expected) => {
    const ran: string[] = [];
    const registry = createActionRegistry(() => ({
      ...IDLE_CONTEXT,
      activeTab: { id: "console-0", kind: "console", title: "console" },
    }));
    registry.register(
      ALL_ACTIONS.filter((action) => action.shortcut === "Mod+Enter").map((action) =>
        defineAction({
          ...action,
          when: () => action.id === "console.run" || (pending && action.id === "table.submit"),
          run: () => void ran.push(action.id),
        }),
      ),
    );
    const dispatch = createKeyDispatcher({
      registry,
      platform: "mac",
      paletteOpen: () => false,
      focusedRegion: () => "grid",
    });

    dispatch(keydown({ key: "Enter", code: "Enter", metaKey: true }));

    expect(ran).toEqual(expected);
  });
});
