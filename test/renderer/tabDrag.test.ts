import { describe, expect, it, vi } from "vitest";
import { deferTabDrag } from "@table-craft/desktop/renderer/model/tabDrag.js";

function frame() {
  let callback: FrameRequestCallback | undefined;
  const schedule = vi.fn((next: FrameRequestCallback) => {
    callback = next;
    return 1;
  });
  const cancel = vi.fn();
  return { schedule, cancel, flush: () => callback?.(0) };
}

describe("native tab drag", () => {
  it("givenNativeDragstart_whenOverlayRequested_thenSourceIsNotCoveredUntilNextFrame", () => {
    const animation = frame();
    const onDrag = vi.fn();

    deferTabDrag("console", onDrag, animation.schedule, animation.cancel);

    expect(onDrag).not.toHaveBeenCalled();
    animation.flush();
    expect(onDrag).toHaveBeenCalledExactlyOnceWith("console");
  });

  it("givenDragEndedBeforeNextFrame_whenPendingFrameRuns_thenOverlayDoesNotReappear", () => {
    const animation = frame();
    const onDrag = vi.fn();
    const stop = deferTabDrag("console", onDrag, animation.schedule, animation.cancel);

    stop();
    animation.flush();

    expect(animation.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(onDrag).not.toHaveBeenCalled();
  });

  it("givenUnmountAfterOverlayAppears_whenPendingDragDisposed_thenItDoesNotStartAnotherDrag", () => {
    const animation = frame();
    const onDrag = vi.fn();
    const dispose = deferTabDrag("console", onDrag, animation.schedule, animation.cancel);
    animation.flush();

    dispose();
    animation.flush();

    expect(onDrag).toHaveBeenCalledExactlyOnceWith("console");
  });
});
