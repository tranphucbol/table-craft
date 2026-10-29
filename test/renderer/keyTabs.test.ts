import { describe, expect, it, vi } from "vitest";
import type { ExecutedStatement, KeyDetails, OpenedKey, OpenedSession } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { keyInfoParts, ttlLabel } from "@table-craft/desktop/renderer/model/keyHeader.js";
import {
  createKeyTabsStore,
  EMPTY_RANGE,
  keyMissing,
  keyRangeOf,
  remainingTtl,
} from "@table-craft/desktop/renderer/state/keyTabs.js";

const KEY = { text: "user:42:profile", hex: null };
const TARGET = { datasourceId: "cache", database: 0, key: KEY };

const HASH: KeyDetails = {
  key: KEY,
  type: "hash",
  typeName: "hash",
  ttlMs: 60_000,
  length: 5,
  memoryBytes: 312,
  encoding: "listpack",
  idleSeconds: 120,
};

function keyEngine(details: KeyDetails) {
  const call = vi.fn((type: string): Promise<unknown> => {
    if (type === "session.open") {
      const opened: OpenedSession = {
        sessionId: "s1",
        pluginName: "Redis",
        capabilities: ["commands", "keyValue"],
        serverVersion: "7.4.1",
        serverBrand: null,
        namespace: null,
      };
      return Promise.resolve(opened);
    }
    if (type === "keyspace.open") {
      const statement: ExecutedStatement = {
        handle: "h1",
        columns: [
          { name: "field", type: "string" },
          { name: "value", type: "string" },
        ],
        typeClasses: ["text", "text"],
        rowCount: 1,
        complete: true,
        cursorOpen: false,
        rowsAffected: null,
        firstWindow: { offset: 0, rows: [["name", "Ann"]] },
        transactionOpen: false,
      };
      const opened: OpenedKey = {
        details,
        statement: details.type === null ? null : statement,
        value: null,
        readOnly: null,
      };
      return Promise.resolve(opened);
    }
    return Promise.resolve(null);
  });
  return { client: { call } as unknown as EngineClient, call };
}

describe("key tabs", () => {
  it("givenHashKey_whenOpened_thenRowsDetailsAndTtlClock", async () => {
    const engine = keyEngine(HASH);
    const store = createKeyTabsStore({ connect: () => Promise.resolve(engine.client), clock: () => 1_000 });
    await store.getState().open("key-0", TARGET);
    const tab = store.getState().tabs["key-0"];
    expect(tab).toMatchObject({ status: "ready", details: HASH, readAt: 1_000, value: null });
    expect(tab?.result?.windows[0]).toEqual([["name", "Ann"]]);
    expect(engine.call).toHaveBeenCalledWith(
      "keyspace.open",
      expect.objectContaining({ sessionId: "s1", database: 0, key: KEY, range: {} }),
    );
  });

  it("givenMatchTyped_whenReloaded_thenRangeSentAndApplied", async () => {
    const engine = keyEngine(HASH);
    const store = createKeyTabsStore({ connect: () => Promise.resolve(engine.client) });
    await store.getState().open("key-0", TARGET);
    store.getState().setDraft("key-0", { match: "na*" });
    await store.getState().reload("key-0");
    expect(engine.call).toHaveBeenCalledWith("keyspace.open", expect.objectContaining({ range: { match: "na*" } }));
    expect(store.getState().tabs["key-0"]?.applied.match).toBe("na*");
  });

  it("givenGoneKey_whenOpened_thenMissing", async () => {
    const engine = keyEngine({ ...HASH, type: null, typeName: null, ttlMs: null, length: null });
    const store = createKeyTabsStore({ connect: () => Promise.resolve(engine.client) });
    await store.getState().open("key-0", TARGET);
    const tab = store.getState().tabs["key-0"];
    expect(tab !== undefined && keyMissing(tab)).toBe(true);
    expect(tab?.result).toBeNull();
  });

  it("givenDetach_whenClosed_thenStaleAndDisconnected", async () => {
    const engine = keyEngine(HASH);
    const store = createKeyTabsStore({ connect: () => Promise.resolve(engine.client) });
    await store.getState().open("key-0", TARGET);
    store.getState().detach("cache", null);
    expect(store.getState().tabs["key-0"]).toMatchObject({ status: "disconnected", sessionId: null });
    expect(store.getState().tabs["key-0"]?.result?.stale).toBe(true);
  });

  it("givenTypes_whenRange_thenOnlyTheirFields", () => {
    const draft = { match: " na* ", from: "1-0", to: "" };
    expect(keyRangeOf("hash", draft)).toEqual({ match: "na*" });
    expect(keyRangeOf("stream", draft)).toEqual({ from: "1-0" });
    expect(keyRangeOf("list", draft)).toEqual({});
    expect(keyRangeOf("set", EMPTY_RANGE)).toEqual({});
  });

  it("givenTtl_whenTimePasses_thenCountsDown", () => {
    expect(remainingTtl(HASH, 1_000, 31_000)).toBe(30_000);
    expect(remainingTtl(HASH, 1_000, 999_999)).toBe(0);
    expect(remainingTtl({ ...HASH, ttlMs: null }, 1_000, 2_000)).toBeNull();
    expect(ttlLabel(30_000)).toBe("TTL 30 s");
    expect(ttlLabel(null)).toBe("no TTL");
  });

  it("givenDetails_whenInfoLine_thenKnownPartsOnly", () => {
    expect(keyInfoParts(HASH)).toEqual(["5 fields", "312 bytes", "listpack", "idle 2 m"]);
    expect(keyInfoParts({ ...HASH, type: "stream", length: 1, memoryBytes: null, encoding: null })).toEqual([
      "1 entry",
      "idle 2 m",
    ]);
  });
});
