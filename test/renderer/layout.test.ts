import { describe, expect, it } from "vitest";
import {
  createLayoutStore,
  DEFAULT_CONSOLE_EDITOR_PERCENT,
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  loadLayout,
  memoryStorage,
  MIN_CONSOLE_PANE_PERCENT,
} from "@table-craft/desktop/renderer/state/layout.js";

describe("layout", () => {
  it("givenSavedLayout_whenLoaded_thenToolWindowsRestored", () => {
    const storage = memoryStorage();
    const first = createLayoutStore(storage);
    first.getState().toggle("services");
    first.getState().resize("database", 35);

    const restored = createLayoutStore(storage).getState().layout;

    expect(restored.visible).toEqual({ database: true, services: false, log: false });
    expect(restored.sizes.database).toBe(35);
  });

  it("givenCorruptLayoutJson_whenLoaded_thenDefaultsUsed", () => {
    const storage = memoryStorage();
    storage.setItem(LAYOUT_STORAGE_KEY, "{not json");

    expect(loadLayout(storage)).toBe(DEFAULT_LAYOUT);
  });

  it("givenWellFormedJsonOfTheWrongShape_whenLoaded_thenDefaultsUsed", () => {
    const storage = memoryStorage();
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ visible: { database: "yes" }, sizes: {} }));

    expect(loadLayout(storage)).toBe(DEFAULT_LAYOUT);
  });

  it("givenOpenToolWindows_whenHideAllPressedTwice_thenTheyComeBack", () => {
    const store = createLayoutStore(memoryStorage());
    store.getState().toggle("services");

    store.getState().hideAll();
    expect(store.getState().layout.visible).toEqual({ database: false, services: false, log: false });
    store.getState().hideAll();
    expect(store.getState().layout.visible).toEqual({ database: true, services: false, log: false });
  });

  it("givenProductionWarningClosed_whenRelaunched_thenStillClosedUntilShown", () => {
    const storage = memoryStorage();
    expect(createLayoutStore(storage).getState().layout.productionNote).toBe(true);
    createLayoutStore(storage).getState().setProductionNote(false);

    const relaunched = createLayoutStore(storage);
    expect(relaunched.getState().layout.productionNote).toBe(false);
    relaunched.getState().setProductionNote(true);
    expect(createLayoutStore(storage).getState().layout.productionNote).toBe(true);
  });

  it("givenExtremeSize_whenResized_thenClamped", () => {
    const store = createLayoutStore(memoryStorage());

    store.getState().resize("database", 99);

    expect(store.getState().layout.sizes.database).toBe(80);
  });

  it("givenSystemSchemasShown_whenRelaunched_thenStillShown", () => {
    const storage = memoryStorage();
    expect(createLayoutStore(storage).getState().layout.showSystemSchemas).toBe(false);
    createLayoutStore(storage).getState().toggleSystemSchemas();

    expect(createLayoutStore(storage).getState().layout.showSystemSchemas).toBe(true);
  });

  it("givenLayoutSavedBeforePlan005_whenLoaded_thenSystemSchemasHidden", () => {
    const storage = memoryStorage();
    const { showSystemSchemas: _dropped, ...old } = DEFAULT_LAYOUT;
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(old));

    expect(loadLayout(storage).showSystemSchemas).toBe(false);
  });

  it("givenSavedLayoutWithoutLog_whenLoaded_thenKeptWithLogHidden", () => {
    const storage = memoryStorage();
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_LAYOUT,
        visible: { database: false, services: true },
        sizes: { database: 30, services: 20 },
      }),
    );

    const layout = loadLayout(storage);

    expect(layout.visible).toEqual({ database: false, services: true, log: false });
    expect(layout.sizes).toEqual({ database: 30, services: 20, log: DEFAULT_LAYOUT.sizes.log });
  });

  it("givenHiddenLog_whenShown_thenVisibleAndShownAgainIsANoOp", () => {
    const store = createLayoutStore(memoryStorage());

    store.getState().show("log");
    const once = store.getState().layout;
    store.getState().show("log");

    expect(once.visible.log).toBe(true);
    expect(store.getState().layout).toBe(once);
  });

  it("givenNoSavedConsoleSplit_whenLoaded_thenEditorTakesHalf", () => {
    const storage = memoryStorage();
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ visible: DEFAULT_LAYOUT.visible, sizes: DEFAULT_LAYOUT.sizes }),
    );

    expect(loadLayout(storage).consoleEditor).toBe(DEFAULT_CONSOLE_EDITOR_PERCENT);
  });

  it("givenConsoleSplitResized_whenRelaunched_thenRemembered", () => {
    const storage = memoryStorage();
    createLayoutStore(storage).getState().resizeConsoleEditor(72.5);

    expect(createLayoutStore(storage).getState().layout.consoleEditor).toBe(72.5);
  });

  it("givenExtremeConsoleSplit_whenResized_thenClamped", () => {
    const store = createLayoutStore(memoryStorage());

    store.getState().resizeConsoleEditor(99);
    expect(store.getState().layout.consoleEditor).toBe(100 - MIN_CONSOLE_PANE_PERCENT);
    store.getState().resizeConsoleEditor(1);
    expect(store.getState().layout.consoleEditor).toBe(MIN_CONSOLE_PANE_PERCENT);
  });

  it("givenSavedConsoleSplitOutOfRange_whenLoaded_thenHalfAndTheRestKept", () => {
    const storage = memoryStorage();
    const sizes = { ...DEFAULT_LAYOUT.sizes, database: 35 };
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ visible: DEFAULT_LAYOUT.visible, sizes, consoleEditor: 97 }));

    const loaded = loadLayout(storage);

    expect(loaded.consoleEditor).toBe(DEFAULT_CONSOLE_EDITOR_PERCENT);
    expect(loaded.sizes.database).toBe(35);
  });

  it("givenUnchangedConsoleSplit_whenResized_thenLayoutKept", () => {
    const store = createLayoutStore(memoryStorage());
    const before = store.getState().layout;

    store.getState().resizeConsoleEditor(DEFAULT_CONSOLE_EDITOR_PERCENT);

    expect(store.getState().layout).toBe(before);
  });
});
