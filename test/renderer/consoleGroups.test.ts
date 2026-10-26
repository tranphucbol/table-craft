import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentContext } from "@table-craft/desktop/renderer/actions/context.js";
import { createActionRegistry } from "@table-craft/desktop/renderer/actions/registry.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import {
  activeTab,
  createTabsStore,
  EDITOR_GROUPS,
  groupOf,
  groupStrip,
  useTabs,
  type EditorGroupId,
  type Tab,
} from "@table-craft/desktop/renderer/state/tabs.js";
import {
  createLayoutStore,
  DEFAULT_EDITOR_GROUP_WIDTH,
  DEFAULT_LAYOUT,
  LAYOUT_STORAGE_KEY,
  loadLayout,
  memoryStorage,
  MIN_EDITOR_GROUP_PERCENT,
} from "@table-craft/desktop/renderer/state/layout.js";

function consoleTab(id: string): Tab {
  return { id, kind: "console", title: id };
}

function splitTabs() {
  const store = createTabsStore();
  for (const id of ["a", "b", "c"]) store.getState().open(consoleTab(id));
  store.getState().moveToGroup("c", "right");
  store.getState().open(consoleTab("d"));
  return store;
}

function ids(store: ReturnType<typeof createTabsStore>, group: EditorGroupId): string[] {
  return groupStrip(store.getState(), group).tabs.map((tab) => tab.id);
}

describe("console groups", () => {
  it.each(EDITOR_GROUPS)("givenSeveralTabs_whenSplitTo%s_thenOnlyTwoGroupsExist", (side) => {
    const store = createTabsStore();
    for (const id of ["a", "b", "c"]) store.getState().open(consoleTab(id));

    store.getState().moveToGroup("b", side);

    expect(ids(store, side)).toEqual(["b"]);
    expect(ids(store, side === "left" ? "right" : "left")).toEqual(["a", "c"]);
    expect(store.getState().activeId).toBe("b");
    store.getState().moveToGroup("c", side);
    expect(new Set(ids(store, side))).toEqual(new Set(["b", "c"]));
    expect(new Set(store.getState().tabs.map(groupOf))).toEqual(new Set(EDITOR_GROUPS));
  });

  it.each(EDITOR_GROUPS)("givenSingleTab_whenSplitTo%s_thenItStaysInTheOnlyGroup", (side) => {
    const store = createTabsStore();
    store.getState().open(consoleTab("a"));

    store.getState().moveToGroup("a", side);

    expect(ids(store, "left")).toEqual(["a"]);
    expect(ids(store, "right")).toEqual([]);
    expect(store.getState().activeId).toBe("a");
  });

  it("givenIndependentSelections_whenGroupsFocused_thenActiveTabRoutesToTheirRememberedSelection", () => {
    const store = splitTabs();
    store.getState().activate("a");
    store.getState().activate("c");

    expect(store.getState().groupActiveIds).toEqual({ left: "a", right: "c" });
    store.getState().focusGroup("left");
    expect(store.getState().activeId).toBe("a");
    expect(activeTab(store.getState())).toMatchObject({ id: "a", kind: "console" });
    expect(groupStrip(store.getState(), "right").activeId).toBe("c");
    store.getState().focusGroup("right");
    expect(store.getState().activeId).toBe("c");
    expect(activeTab(store.getState())?.id).toBe("c");
    expect(groupStrip(store.getState(), "left").activeId).toBe("a");
  });

  it("givenSplitTabs_whenOpened_thenTheyJoinTheFocusedGroup", () => {
    const store = splitTabs();
    store.getState().focusGroup("left");
    store.getState().open(consoleTab("left-new"));
    store.getState().focusGroup("right");
    store.getState().open(consoleTab("right-new"));

    expect(ids(store, "left")).toEqual(["a", "b", "left-new"]);
    expect(ids(store, "right")).toEqual(["c", "d", "right-new"]);
    expect(store.getState().groupActiveIds).toEqual({ left: "left-new", right: "right-new" });
  });

  it.each(EDITOR_GROUPS)("givenOtherGroupFocused_whenOpenedAfter%sAnchor_thenAnchorGroupIsUsed", (side) => {
    const store = splitTabs();
    const anchor = side === "left" ? "a" : "c";
    store.getState().focusGroup(side === "left" ? "right" : "left");

    store.getState().openAfter(anchor, consoleTab("copy"));

    expect(ids(store, side)).toEqual([anchor, "copy", side === "left" ? "b" : "d"]);
    expect(groupOf(activeTab(store.getState()))).toBe(side);
    expect(store.getState().activeId).toBe("copy");
  });

  it.each(EDITOR_GROUPS)("givenTwoGroups_whenLastTabOf%sCloses_thenRemainingGroupCollapsesLeft", (side) => {
    const store = createTabsStore();
    store.getState().open(consoleTab("a"));
    store.getState().open(consoleTab("b"));
    store.getState().moveToGroup("b", "right");

    const removed = store.getState().close(side === "left" ? "a" : "b");

    expect(removed.map((tab) => tab.id)).toEqual([side === "left" ? "a" : "b"]);
    expect(ids(store, "left")).toEqual([side === "left" ? "b" : "a"]);
    expect(ids(store, "right")).toEqual([]);
    expect(store.getState().groupActiveIds).toEqual({ left: store.getState().activeId, right: null });
  });

  it("givenGroupWithActiveTab_whenClosed_thenItsOwnNeighbourBecomesActive", () => {
    const store = splitTabs();
    store.getState().activate("b");

    store.getState().close("b");

    expect(store.getState().activeId).toBe("a");
    expect(store.getState().groupActiveIds).toEqual({ left: "a", right: "d" });
  });

  it("givenPinnedTabsInBothGroups_whenCloseOthers_thenOnlyAnchorGroupUnpinnedOthersClose", () => {
    const store = splitTabs();
    store.getState().togglePin("a");
    store.getState().togglePin("c");
    store.getState().focusGroup("left");
    store.getState().open(consoleTab("extra"));

    const removed = store.getState().closeOthers("b");

    expect(removed.map((tab) => tab.id)).toEqual(["extra"]);
    expect(ids(store, "left")).toEqual(["a", "b"]);
    expect(ids(store, "right")).toEqual(["c", "d"]);
    expect(store.getState().activeId).toBe("b");
  });

  it("givenPinnedTabsInBothGroups_whenCloseAll_thenOnlyFocusedGroupUnpinnedTabsClose", () => {
    const store = splitTabs();
    store.getState().togglePin("a");
    store.getState().togglePin("c");
    store.getState().focusGroup("right");

    const removed = store.getState().closeAll();

    expect(removed.map((tab) => tab.id)).toEqual(["d"]);
    expect(ids(store, "left")).toEqual(["a", "b"]);
    expect(ids(store, "right")).toEqual(["c"]);
    expect(store.getState().activeId).toBe("c");
  });

  it("givenPinnedAnchorAndSplitTabs_whenCloseRight_thenOnlyAnchorGroupUnpinnedTabsToRightClose", () => {
    const store = splitTabs();
    store.getState().togglePin("a");
    store.getState().togglePin("b");
    store.getState().focusGroup("left");
    store.getState().open(consoleTab("extra"));
    store.getState().focusGroup("right");

    const removed = store.getState().closeRight("a");

    expect(removed.map((tab) => tab.id)).toEqual(["extra"]);
    expect(ids(store, "left")).toEqual(["a", "b"]);
    expect(ids(store, "right")).toEqual(["c", "d"]);
  });

  it("givenSplitTabs_whenCycledPastEnds_thenOnlyFocusedGroupWraps", () => {
    const store = splitTabs();

    store.getState().cycle(1);
    expect(store.getState().activeId).toBe("c");
    store.getState().cycle(-1);
    expect(store.getState().activeId).toBe("d");
    store.getState().focusGroup("left");
    store.getState().cycle(1);
    expect(store.getState().activeId).toBe("a");
    expect(store.getState().groupActiveIds.right).toBe("d");
  });

  it("givenRestoredDescriptors_whenGroupsRestored_thenEachGroupKeepsItsSelectedTab", () => {
    const store = createTabsStore();
    const entries = [
      ["a", "left", true],
      ["b", "left", false],
      ["c", "right", true],
      ["d", "right", false],
    ] as const;
    for (const [id] of entries) {
      store.getState().open(consoleTab(id));
    }
    store.getState().restoreGroups(entries.map(([id, groupId, selected]) => ({ id, groupId, selected })));

    expect(store.getState().groupActiveIds).toEqual({ left: "a", right: "c" });
    store.getState().focusGroup("left");
    expect(store.getState().activeId).toBe("a");
    store.getState().focusGroup("right");
    expect(store.getState().activeId).toBe("c");
  });

  it("givenSplitTabs_whenUnsplit_thenAllTabsAndFocusedSelectionArePreserved", () => {
    const store = splitTabs();
    store.getState().togglePin("c");
    store.getState().activate("a");
    const before = store.getState().tabs.map((tab) => tab.id);

    store.getState().unsplit();

    expect(new Set(ids(store, "left"))).toEqual(new Set(before));
    expect(ids(store, "left")[0]).toBe("c");
    expect(ids(store, "right")).toEqual([]);
    expect(store.getState().groupActiveIds).toEqual({ left: "a", right: null });
    expect(store.getState().tabs.find((tab) => tab.id === "c")?.pinned).toBe(true);
    expect(store.getState().activeId).toBe("a");
  });
});

describe("console group action context", () => {
  const initialTabs = useTabs.getState();
  const initialConsoles = useConsoles.getState();
  const initialDatasources = useDatasources.getState();

  beforeEach(async () => {
    vi.stubGlobal("document", { activeElement: null });
    useTabs.setState({ ...initialTabs, tabs: [], activeId: null, groupActiveIds: { left: null, right: null } }, true);
    useConsoles.setState({ consoles: {} });
    useDatasources.setState({
      selection: { kind: "datasource", id: "tree-db" },
      datasources: ["left-db", "right-db", "tree-db"].map((id) => ({
        id,
        name: id,
        pluginId: "sqlite",
        folder: null,
        color: null,
        readOnly: false,
        comment: "",
        config: {},
        secretModes: {},
        storedSecrets: [],
        ephemeral: false,
      })),
    });
    await useConsoles.getState().open("left", "left-db", { connect: false });
    await useConsoles.getState().open("right", "right-db", { connect: false });
    useTabs.getState().open(consoleTab("left"));
    useTabs.getState().open(consoleTab("right"));
    useTabs.getState().moveToGroup("right", "right");
  });

  afterEach(() => {
    useTabs.setState(initialTabs, true);
    useConsoles.setState(initialConsoles, true);
    useDatasources.setState(initialDatasources, true);
    vi.unstubAllGlobals();
  });

  it("givenOtherGroupFocused_whenExplicitContextRequested_thenVisibleTabAndDatasourceAreTargetedWithoutChangingFocus", () => {
    const context = currentContext("left");

    expect(context.activeTab?.id).toBe("left");
    expect(context.console?.datasourceId).toBe("left-db");
    expect(context.datasource?.view.id).toBe("left-db");
    expect(currentContext().activeTab?.id).toBe("right");
    expect(useTabs.getState().activeId).toBe("right");
    useTabs.getState().focusGroup("left");
    expect(currentContext().console?.datasourceId).toBe("left-db");
  });

  it("givenDatabasePaneFocused_whenExplicitTabContextRequested_thenTabDatasourceOverridesTreeSelection", () => {
    vi.stubGlobal("document", {
      activeElement: { closest: () => ({ getAttribute: () => "database" }) },
    });

    expect(currentContext().datasource?.view.id).toBe("tree-db");
    expect(currentContext().inDatabasePane).toBe(true);
    expect(currentContext("left").datasource?.view.id).toBe("left-db");
    expect(currentContext("left").inDatabasePane).toBe(false);
    expect(useTabs.getState().activeId).toBe("right");
  });

  it("givenScopedActionPredicates_whenOtherGroupFocused_thenEnabledAndAvailableUseExplicitContext", () => {
    const registry = createActionRegistry(currentContext);
    registry.register([
      {
        id: "left-only",
        title: "Left only",
        category: "Console",
        tabKind: "console",
        available: (context) => context.console?.datasourceId === "left-db",
        when: (context) => context.activeTab?.id === "left",
        run: () => undefined,
      },
    ]);

    expect(registry.isEnabled("left-only")).toBe(false);
    expect(registry.isAvailable("left-only")).toBe(false);
    expect(registry.isEnabled("left-only", currentContext("left"))).toBe(true);
    expect(registry.isAvailable("left-only", currentContext("left"))).toBe(true);
    expect(useTabs.getState().activeId).toBe("right");
  });

  it("givenMissingExplicitTab_whenContextRequested_thenItDoesNotFallBackToFocusedTab", () => {
    const context = currentContext("closed");

    expect(context.activeTab).toBeNull();
    expect(context.console).toBeNull();
    expect(context.result).toBeNull();
    expect(useTabs.getState().activeId).toBe("right");
  });
});

describe("console group layout", () => {
  const console = { datasourceId: "db", name: "Console", active: true };
  const table = { datasourceId: "db", path: ["main"], relation: "users", active: false };

  it("givenLegacyLayout_whenLoaded_thenDescriptorsStayCompatibleAndWidthDefaults", () => {
    const storage = memoryStorage();
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        visible: DEFAULT_LAYOUT.visible,
        sizes: DEFAULT_LAYOUT.sizes,
        openConsoles: [console],
        openTables: [table],
      }),
    );

    const layout = loadLayout(storage);

    expect(layout.editorGroupWidth).toBe(DEFAULT_EDITOR_GROUP_WIDTH);
    expect(layout.openConsoles).toEqual([console]);
    expect(layout.openTables).toEqual([table]);
    expect(groupOf(undefined)).toBe("left");
  });

  it("givenGroupDescriptors_whenSavedAndLoaded_thenGroupAndSelectionArePreserved", () => {
    const storage = memoryStorage();
    const store = createLayoutStore(storage);
    const consoles = [{ ...console, groupId: "right" as const, groupActive: true }];
    const tables = [{ ...table, groupId: "left" as const, groupActive: false }];

    store.getState().setOpenConsoles(consoles);
    store.getState().setOpenTables(tables);

    expect(loadLayout(storage).openConsoles).toEqual(consoles);
    expect(loadLayout(storage).openTables).toEqual(tables);
  });

  it.each([{ groupId: "middle" }, { groupId: null }, { groupId: 1 }, { groupActive: "yes" }, { groupActive: null }])(
    "givenInvalidGroupDescriptor%j_whenLoaded_thenOnlyInvalidEntriesAreDiscarded",
    (invalid) => {
      const storage = memoryStorage();
      storage.setItem(
        LAYOUT_STORAGE_KEY,
        JSON.stringify({
          ...DEFAULT_LAYOUT,
          openConsoles: [console, { ...console, ...invalid }],
          openTables: [table, { ...table, ...invalid }],
        }),
      );

      expect(loadLayout(storage).openConsoles).toEqual([console]);
      expect(loadLayout(storage).openTables).toEqual([table]);
    },
  );

  it("givenGroupBoundaryResize_whenOutsideLimits_thenClampedAndPersisted", () => {
    const storage = memoryStorage();
    const store = createLayoutStore(storage);

    store.getState().resizeEditorGroups(-10);
    expect(store.getState().layout.editorGroupWidth).toBe(MIN_EDITOR_GROUP_PERCENT);
    expect(loadLayout(storage).editorGroupWidth).toBe(MIN_EDITOR_GROUP_PERCENT);
    store.getState().resizeEditorGroups(110);
    expect(store.getState().layout.editorGroupWidth).toBe(100 - MIN_EDITOR_GROUP_PERCENT);
    expect(loadLayout(storage).editorGroupWidth).toBe(100 - MIN_EDITOR_GROUP_PERCENT);
    store.getState().resizeEditorGroups(43);
    expect(createLayoutStore(storage).getState().layout.editorGroupWidth).toBe(43);
  });

  it("givenUnchangedOrNaNWidth_whenResized_thenLayoutAndStorageAreUnchanged", () => {
    const storage = memoryStorage();
    const store = createLayoutStore(storage);
    const before = store.getState().layout;

    store.getState().resizeEditorGroups(DEFAULT_EDITOR_GROUP_WIDTH);
    store.getState().resizeEditorGroups(Number.NaN);

    expect(store.getState().layout).toBe(before);
    expect(storage.getItem(LAYOUT_STORAGE_KEY)).toBeNull();
  });

  it.each([0, 100, "50", null])("givenInvalidSavedWidth%s_whenLoaded_thenDefaultWidthIsUsed", (editorGroupWidth) => {
    const storage = memoryStorage();
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ ...DEFAULT_LAYOUT, editorGroupWidth }));

    expect(loadLayout(storage).editorGroupWidth).toBe(DEFAULT_EDITOR_GROUP_WIDTH);
  });
});
