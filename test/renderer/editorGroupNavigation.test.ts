import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEditorJump } from "@table-craft/desktop/renderer/console/editorJump.js";
import { focusActivatedEditor } from "@table-craft/desktop/renderer/shell/focus.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { createTabsStore } from "@table-craft/desktop/renderer/state/tabs.js";

describe("editor group navigation", () => {
  const original = useConsoles.getState();

  beforeEach(async () => {
    useConsoles.setState({ consoles: {} });
    await useConsoles.getState().open("a", "db", { connect: false, sql: "SELECT 1; SELECT 2" });
    await useConsoles.getState().open("b", "db", { connect: false, sql: "SELECT 3" });
  });

  afterEach(() => {
    useConsoles.setState(original, true);
    vi.unstubAllGlobals();
  });

  function target() {
    return {
      length: 18,
      select: vi.fn((anchor: number) => useConsoles.getState().setSelection("a", { from: anchor, to: anchor })),
      focus: vi.fn(),
    };
  }

  it("givenAppliedJumpAndMovedCaret_whenEditorRemountsForSplitAndUnsplit_thenJumpDoesNotReplayOrStealFocus", () => {
    const tabs = createTabsStore();
    tabs.getState().open({ id: "a", kind: "console", title: "A" });
    useConsoles.getState().jumpTo("a", { from: 2, to: 4 });
    const firstMount = target();
    applyEditorJump(firstMount, "a", useConsoles.getState(), true);
    expect(firstMount.select).toHaveBeenCalledWith(2);
    expect(firstMount.focus).toHaveBeenCalledOnce();
    expect(useConsoles.getState().consoles.a?.jump).toBeNull();

    useConsoles.getState().setSelection("a", { from: 12, to: 12 });
    tabs.getState().open({ id: "b", kind: "console", title: "B" });
    tabs.getState().moveToGroup("b", "left");
    const splitMount = target();
    applyEditorJump(splitMount, "a", useConsoles.getState(), tabs.getState().activeId === "a");
    tabs.getState().unsplit();
    const unsplitMount = target();
    applyEditorJump(unsplitMount, "a", useConsoles.getState(), tabs.getState().activeId === "a");

    expect(splitMount.select).not.toHaveBeenCalled();
    expect(splitMount.focus).not.toHaveBeenCalled();
    expect(unsplitMount.select).not.toHaveBeenCalled();
    expect(unsplitMount.focus).not.toHaveBeenCalled();
    expect(useConsoles.getState().consoles.a?.selection).toEqual({ from: 12, to: 12 });
    expect(tabs.getState().activeId).toBe("b");
  });

  it("givenJumpRequestedWhileUnmounted_whenInactiveEditorMounts_thenPendingJumpAppliesOnceWithoutFocus", () => {
    useConsoles.getState().jumpTo("a", { from: 50, to: 55 });
    expect(useConsoles.getState().consoles.a?.jump).not.toBeNull();
    const mounted = target();
    applyEditorJump(mounted, "a", useConsoles.getState(), false);

    expect(mounted.select).toHaveBeenCalledWith(mounted.length);
    expect(mounted.focus).not.toHaveBeenCalled();
    expect(useConsoles.getState().consoles.a?.jump).toBeNull();
    applyEditorJump(mounted, "a", useConsoles.getState(), true);
    expect(mounted.select).toHaveBeenCalledOnce();
    expect(mounted.focus).not.toHaveBeenCalled();
  });

  it("givenNewerJump_whenOlderJumpAcknowledged_thenNewerRequestRemainsPending", () => {
    useConsoles.getState().jumpTo("a", { from: 2, to: 4 });
    const older = useConsoles.getState().consoles.a?.jump;
    useConsoles.getState().jumpTo("a", { from: 8, to: 10 });
    useConsoles.getState().jumped("a", older?.seq ?? -1);

    expect(useConsoles.getState().consoles.a?.jump).toMatchObject({ from: 8, to: 10 });
    expect(useConsoles.getState().consoles.a?.jump?.seq).not.toBe(older?.seq);
    useConsoles.getState().jumped("closed", older?.seq ?? -1);
    expect(useConsoles.getState().consoles.closed).toBeUndefined();
  });

  it("givenAlreadyVisibleOppositeGroup_whenProgrammaticallyActivated_thenKeyboardFocusFollowsActiveTab", () => {
    const tabs = createTabsStore();
    tabs.getState().open({ id: "a", kind: "console", title: "A" });
    tabs.getState().open({ id: "b", kind: "console", title: "B" });
    tabs.getState().moveToGroup("b", "right");
    let keyboardTab = "b";
    const focus = vi.fn(() => {
      keyboardTab = "a";
    });
    vi.stubGlobal("document", { activeElement: {} });
    const container = { contains: () => false, querySelector: () => ({ focus }) } as unknown as HTMLElement;

    tabs.getState().activate("a");
    focusActivatedEditor(container, tabs.getState().activeId, tabs.getState().groupActiveIds.left);

    expect(focus).toHaveBeenCalledOnce();
    expect(keyboardTab).toBe(tabs.getState().activeId);
  });

  it.each(["results", "toolbar"])(
    "givenFocusInsideActiveGroup%s_whenSelectionReconciled_thenExistingFocusIsKept",
    () => {
      const focus = vi.fn();
      vi.stubGlobal("document", { activeElement: {} });
      const container = { contains: () => true, querySelector: () => ({ focus }) } as unknown as HTMLElement;

      focusActivatedEditor(container, "a", "a");

      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("givenInactiveGroup_whenOtherTabActivated_thenItDoesNotTakeKeyboardFocus", () => {
    const focus = vi.fn();
    vi.stubGlobal("document", { activeElement: {} });
    const container = { contains: () => false, querySelector: () => ({ focus }) } as unknown as HTMLElement;

    focusActivatedEditor(container, "b", "a");
    focusActivatedEditor(container, null, null);

    expect(focus).not.toHaveBeenCalled();
  });
});
