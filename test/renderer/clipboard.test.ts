import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToCopies, writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
}

describe("clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("givenSubscriber_whenWriteSucceeds_thenNotified", async () => {
    const written: string[] = [];
    stubClipboard((text) => {
      written.push(text);
      return Promise.resolve();
    });
    const listener = vi.fn();
    const stop = subscribeToCopies(listener);

    await writeClipboard("select 1");
    stop();
    await writeClipboard("select 2");

    expect(written).toEqual(["select 1", "select 2"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("givenSubscriber_whenWriteFails_thenNotNotified", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    const listener = vi.fn();
    const stop = subscribeToCopies(listener);

    await expect(writeClipboard("select 1")).rejects.toThrow("denied");
    stop();

    expect(listener).not.toHaveBeenCalled();
  });
});
