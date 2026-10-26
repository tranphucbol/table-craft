import { describe, expect, it, vi } from "vitest";
import type { InvokeResult } from "@table-craft/desktop/preload/bridge.js";
import { createSnippetsStore, installSnippetsSync } from "@table-craft/desktop/renderer/state/snippets.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

const SNIPPET: TextSnippet = { id: "one", name: "One", prefix: "one", body: "GET ${key}", scope: { kind: "all" } };
type Answer = InvokeResult<readonly TextSnippet[]>;
const success = (snippets: readonly TextSnippet[]): Answer => ({ ok: true, value: snippets });
const failure: Answer = { ok: false, error: { message: "Disk full.", hint: "Free space and retry." } };

function deferredAnswer() {
  let resolve: (answer: Answer) => void = () => undefined;
  const promise = new Promise<Answer>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  let changed: (snippets: readonly TextSnippet[]) => void = () => undefined;
  const unsubscribe = vi.fn();
  const bridge = {
    readSnippets: vi.fn((): Promise<Answer> => Promise.resolve(success([SNIPPET]))),
    saveSnippet: vi.fn((snippet: TextSnippet): Promise<Answer> => Promise.resolve(success([snippet]))),
    deleteSnippet: vi.fn((_id: string): Promise<Answer> => Promise.resolve(success([]))),
    onSnippetsChanged: vi.fn((listener: typeof changed) => {
      changed = listener;
      return unsubscribe;
    }),
  };
  const store = createSnippetsStore({ bridge: () => bridge });
  return { store, bridge, changed: (snippets: readonly TextSnippet[]) => changed(snippets), unsubscribe };
}

describe("snippets store", () => {
  it("givenInitialization_whenLoadedTwice_thenReadOnceAndSavedAndRemoved", async () => {
    const { store, bridge } = setup();
    await Promise.all([store.getState().load(), store.getState().load()]);
    expect(bridge.readSnippets).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ loaded: true, busy: false, error: null, snippets: [SNIPPET] });
    const updated = { ...SNIPPET, body: "SELECT 2" };
    expect(await store.getState().save(updated)).toBe(true);
    expect(store.getState().snippets).toEqual([updated]);
    expect(await store.getState().remove(SNIPPET.id)).toBe(true);
    expect(store.getState().snippets).toEqual([]);
  });

  it("givenReadFailure_whenRetried_thenErrorSurfacesWithoutRejectingAndRetryLoads", async () => {
    const { store, bridge } = setup();
    bridge.readSnippets.mockResolvedValueOnce(failure);
    await store.getState().load();
    expect(store.getState()).toMatchObject({
      loaded: false,
      busy: false,
      snippets: [],
      error: "Disk full. Free space and retry.",
    });
    expect(await store.getState().save(SNIPPET)).toBe(false);
    expect(await store.getState().remove(SNIPPET.id)).toBe(false);
    expect(bridge.saveSnippet).not.toHaveBeenCalled();
    expect(bridge.deleteSnippet).not.toHaveBeenCalled();
    expect(store.getState().error).toBe("Disk full. Free space and retry.");
    await store.getState().load();
    expect(store.getState().snippets).toEqual([SNIPPET]);
  });

  it("givenMutationFailures_whenSavedOrRemoved_thenDataRemainsAndErrorsCanBeDismissed", async () => {
    const { store, bridge } = setup();
    await store.getState().load();
    bridge.saveSnippet.mockResolvedValueOnce(failure);
    expect(await store.getState().save({ ...SNIPPET, name: "Changed" })).toBe(false);
    expect(store.getState().snippets).toEqual([SNIPPET]);
    bridge.deleteSnippet.mockRejectedValueOnce(new Error("bridge unavailable"));
    expect(await store.getState().remove(SNIPPET.id)).toBe(false);
    expect(store.getState().error).toContain("bridge unavailable");
    expect(store.getState().snippets).toEqual([SNIPPET]);
    store.getState().dismissError();
    expect(store.getState().error).toBeNull();
  });

  it("givenNewerBroadcastDuringRead_whenOldReplyArrives_thenBroadcastWins", async () => {
    const { store, bridge, changed, unsubscribe } = setup();
    const stop = installSnippetsSync(store, bridge);
    const reply = deferredAnswer();
    bridge.readSnippets.mockReturnValueOnce(reply.promise);
    const loading = store.getState().load();
    await Promise.resolve();
    const newer = { ...SNIPPET, name: "Newest" };
    changed([newer]);
    reply.resolve(success([SNIPPET]));
    await loading;
    expect(store.getState().snippets).toEqual([newer]);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("givenConcurrentMutations_whenQueued_thenBusyUntilAllRepliesAndNewestBroadcastWins", async () => {
    const { store, bridge, changed } = setup();
    await store.getState().load();
    installSnippetsSync(store, bridge);
    const reply = deferredAnswer();
    bridge.saveSnippet.mockReturnValueOnce(reply.promise);
    const saving = store.getState().save(SNIPPET);
    const removing = store.getState().remove(SNIPPET.id);
    await Promise.resolve();
    expect(store.getState().busy).toBe(true);
    expect(bridge.deleteSnippet).not.toHaveBeenCalled();
    changed([{ ...SNIPPET, name: "Another window" }]);
    reply.resolve(success([SNIPPET]));
    await saving;
    expect(store.getState().snippets[0]?.name).toBe("Another window");
    await removing;
    expect(store.getState()).toMatchObject({ busy: false, snippets: [] });
  });
});
