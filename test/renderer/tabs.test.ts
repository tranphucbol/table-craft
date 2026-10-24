import { describe, expect, it } from "vitest";
import {
  CLOSED_TABS_LIMIT,
  createTabsStore,
  rightTabIds,
  type ClosedConsole,
  type Tab,
} from "@table-craft/desktop/renderer/state/tabs.js";

function console(id: string): Tab {
  return { id, kind: "console", title: id };
}

function threeTabs() {
  const store = createTabsStore();
  for (const id of ["a", "b", "c"]) store.getState().open(console(id));
  return store;
}

describe("tabs", () => {
  it("givenThreeTabs_whenMiddleClosed_thenRightNeighbourBecomesActive", () => {
    const store = threeTabs();
    store.getState().activate("b");

    const removed = store.getState().close("b");

    expect(removed.map((tab) => tab.id)).toEqual(["b"]);
    expect(store.getState().activeId).toBe("c");
  });

  it("givenLastTabActive_whenClosed_thenLeftNeighbourBecomesActive", () => {
    const store = threeTabs();

    store.getState().close("c");

    expect(store.getState().activeId).toBe("b");
  });

  it("givenLastTabClosed_whenRendered_thenNoActiveTab", () => {
    const store = createTabsStore();
    store.getState().open(console("a"));

    store.getState().close("a");

    expect(store.getState()).toMatchObject({ tabs: [], activeId: null });
  });

  it("givenInactiveTabClosed_whenClosed_thenActiveTabStays", () => {
    const store = threeTabs();

    store.getState().close("a");

    expect(store.getState().activeId).toBe("c");
  });

  it("givenThreeTabs_whenOthersClosed_thenOnlyThatTabRemainsActive", () => {
    const store = threeTabs();

    const removed = store.getState().closeOthers("b");

    expect(removed.map((tab) => tab.id)).toEqual(["a", "c"]);
    expect(store.getState()).toMatchObject({ tabs: [console("b")], activeId: "b" });
  });

  it("givenThreeTabs_whenCycledPastEitherEnd_thenWraps", () => {
    const store = threeTabs();

    store.getState().cycle(1);
    expect(store.getState().activeId).toBe("a");
    store.getState().cycle(-1);
    expect(store.getState().activeId).toBe("c");
  });

  it("givenTabs_whenAllClosed_thenEveryTabIsReturned", () => {
    const store = threeTabs();

    expect(
      store
        .getState()
        .closeAll()
        .map((tab) => tab.id),
    ).toEqual(["a", "b", "c"]);
    expect(store.getState().activeId).toBeNull();
  });

  it("givenThreeTabs_whenLastPinned_thenItMovesLeftOfTheUnpinnedOnes", () => {
    const store = threeTabs();

    store.getState().togglePin("c");

    expect(ids(store)).toEqual(["c", "a", "b"]);
    expect(store.getState().tabs[0]).toEqual({ ...console("c"), pinned: true });
    expect(store.getState().activeId).toBe("c");
  });

  it("givenTwoPinnedTabs_whenFirstUnpinned_thenItLeadsTheUnpinnedOnesWithoutThePinFlag", () => {
    const store = threeTabs();
    store.getState().togglePin("b");
    store.getState().togglePin("c");

    store.getState().togglePin("b");

    expect(ids(store)).toEqual(["c", "b", "a"]);
    expect(store.getState().tabs[1]).toEqual(console("b"));
  });

  it("givenPinnedTab_whenOthersClosed_thenPinnedTabStays", () => {
    const store = threeTabs();
    store.getState().togglePin("a");

    const removed = store.getState().closeOthers("b");

    expect(removed.map((tab) => tab.id)).toEqual(["c"]);
    expect(ids(store)).toEqual(["a", "b"]);
    expect(store.getState().activeId).toBe("b");
  });

  it("givenPinnedActiveTab_whenAllClosed_thenOnlyPinnedTabsRemainAndItStaysActive", () => {
    const store = threeTabs();
    store.getState().togglePin("b");

    const removed = store.getState().closeAll();

    expect(removed.map((tab) => tab.id)).toEqual(["a", "c"]);
    expect(store.getState()).toMatchObject({ tabs: [{ id: "b" }], activeId: "b" });
  });

  it("givenFourTabs_whenClosedToTheRightOfSecond_thenOnlyTheRightOnesClose", () => {
    const store = threeTabs();
    store.getState().open(console("d"));

    const removed = store.getState().closeRight("b");

    expect(removed.map((tab) => tab.id)).toEqual(["c", "d"]);
    expect(ids(store)).toEqual(["a", "b"]);
    expect(store.getState().activeId).toBe("b");
  });

  it("givenPinnedTabsRightOfTarget_whenRightIdsAsked_thenPinnedOnesAreSkipped", () => {
    const store = threeTabs();
    store.getState().togglePin("a");
    store.getState().togglePin("c");

    expect(ids(store)).toEqual(["a", "c", "b"]);
    expect(rightTabIds(store.getState(), "a")).toEqual(["b"]);
    store.getState().closeRight("a");
    expect(ids(store)).toEqual(["a", "c"]);
  });

  it("givenActiveTabRightOfTarget_whenClosedToTheRight_thenTargetBecomesActive", () => {
    const store = threeTabs();

    store.getState().closeRight("a");

    expect(store.getState()).toMatchObject({ tabs: [{ id: "a" }], activeId: "a" });
  });

  it("givenThreeTabs_whenOpenedAfterFirst_thenNewTabSitsSecondAndIsActive", () => {
    const store = threeTabs();

    store.getState().openAfter("a", console("copy"));

    expect(ids(store)).toEqual(["a", "copy", "b", "c"]);
    expect(store.getState().activeId).toBe("copy");
  });

  it("givenPinnedAnchor_whenOpenedAfterIt_thenNewTabGoesAfterThePinnedGroup", () => {
    const store = threeTabs();
    store.getState().togglePin("a");
    store.getState().togglePin("b");

    store.getState().openAfter("a", console("copy"));

    expect(ids(store)).toEqual(["a", "b", "copy", "c"]);
  });

  it("givenMissingAnchor_whenOpenedAfterIt_thenNewTabIsAppended", () => {
    const store = threeTabs();

    store.getState().openAfter("gone", console("copy"));

    expect(ids(store)).toEqual(["a", "b", "c", "copy"]);
  });

  it("givenTwoClosedConsoles_whenTaken_thenNewestComesFirstUntilEmpty", () => {
    const store = createTabsStore();
    store.getState().rememberClosed(closedConsole("first"));
    store.getState().rememberClosed(closedConsole("second"));

    expect(store.getState().takeClosed()?.name).toBe("second");
    expect(store.getState().takeClosed()?.name).toBe("first");
    expect(store.getState().takeClosed()).toBeUndefined();
  });

  it("givenMoreClosedConsolesThanTheLimit_whenRemembered_thenOldestDropOff", () => {
    const store = createTabsStore();

    for (let index = 0; index <= CLOSED_TABS_LIMIT; index++)
      store.getState().rememberClosed(closedConsole(`c${String(index)}`));

    expect(store.getState().closedConsoles).toHaveLength(CLOSED_TABS_LIMIT);
    expect(store.getState().closedConsoles[0]?.name).toBe("c1");
  });
});

function ids(store: ReturnType<typeof createTabsStore>): string[] {
  return store.getState().tabs.map((tab) => tab.id);
}

function closedConsole(name: string): ClosedConsole {
  return { datasourceId: "pg", name, sql: "select 1" };
}
