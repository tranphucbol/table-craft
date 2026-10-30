import { describe, expect, it } from "vitest";
import {
  EXPORT_EVENT_TYPES,
  IMPORT_EVENT_TYPES,
  type EngineEvent,
  type EngineError,
  type KeyConflictSnapshot,
} from "@table-craft/desktop/engine/protocol.js";
import { clientFor } from "@table-craft/desktop/renderer/engine/client.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

const DELIVERY_WAIT_MS = 1_000;

describe("engine client", () => {
  const key = { text: "\\xff", hex: "ff" };
  const revision = { createRevision: "1", modRevision: "9007199254740993", version: "2", lease: "0" };
  const snapshots: (KeyConflictSnapshot | undefined)[] = [
    { database: 0, key, value: { text: "\\xff\\x00", hex: "ff00" }, revision, snapshotRevision: "9007199254740994" },
    { database: 0, key, value: { text: "", hex: null }, revision, snapshotRevision: "9007199254740994" },
    { database: 0, key, value: null, revision: null, snapshotRevision: "9007199254740994" },
    undefined,
  ];

  it.each(snapshots)(
    "givenEngineConflict_whenBridgedThenMapped_thenPreserveExactOptionalSnapshot %#",
    async (keyConflict) => {
      const channel = new MessageChannel();
      const client = clientFor(channel.port1);
      const error: EngineError = {
        code: "conflict",
        message: "changed",
        hint: "Reload",
        position: 0,
        ...(keyConflict === undefined ? {} : { keyConflict }),
      };
      channel.port2.addEventListener("message", (event: MessageEvent<{ id: number }>) => {
        channel.port2.postMessage({ id: event.data.id, type: "engine.error", error });
      });
      channel.port2.start();
      try {
        const mapped = await client.call("session.open", {}).catch((cause: unknown) => toError(cause));
        expect(mapped).toEqual(error);
      } finally {
        channel.port1.close();
        channel.port2.close();
      }
    },
  );

  it("givenArbitraryErrorWithSnapshotProperty_whenMapped_thenDoNotTrustIt", () => {
    const cause = Object.assign(new Error("unexpected"), { keyConflict: snapshots[0] });
    expect(toError(cause).keyConflict).toBeUndefined();
    expect(toError(cause).code).toBe("internal");
  });

  it("givenEveryTaskEventType_whenPosted_thenListenersReceiveIt", async () => {
    const channel = new MessageChannel();
    const client = clientFor(channel.port1);
    const types = [...EXPORT_EVENT_TYPES, ...IMPORT_EVENT_TYPES];
    const received: string[] = [];
    const all = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`received only ${received.join(", ")}`));
      }, DELIVERY_WAIT_MS);
      client.onEvent((event: EngineEvent) => {
        received.push(event.type);
        if (received.length === types.length) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    for (const type of types) channel.port2.postMessage({ id: null, type, task: {} });
    await all;
    expect(received).toEqual(types);
    channel.port1.close();
  });
});
