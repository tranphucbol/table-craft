import { describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  PluginError,
  z,
  type DatasourcePlugin,
  type KeyHistoryPage,
  type Keyspace,
} from "@table-craft/plugin-api";
import { helperRequestFailed, toEngineError } from "@table-craft/desktop/engine/failures.js";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import {
  KEY_HISTORY_MAX_BYTES,
  KEY_HISTORY_MAX_COUNT,
  KEY_HISTORY_MAX_CURSOR_LENGTH,
  KEY_HISTORY_MAX_TIMEOUT_MS,
} from "@table-craft/desktop/engine/protocol.js";
import { fakeManifest } from "../support/manifests.js";

const PLUGIN_ID = "history-fixture";
const KEY = { text: "\\xff", hex: "ff" };
const REQUEST = {
  id: 1,
  type: "keyspace.history",
  database: 0,
  key: KEY,
  cursor: null,
  count: 20,
  maxBytes: KEY_HISTORY_MAX_BYTES,
  timeoutMs: KEY_HISTORY_MAX_TIMEOUT_MS,
} as const;
const REVISION = "9007199254740993";
const PAGE: KeyHistoryPage = {
  events: [
    {
      kind: "PUT",
      key: KEY,
      value: { text: "", hex: null },
      createRevision: "1",
      modRevision: "1",
      version: "1",
      lease: "0",
    },
    { kind: "DELETE", key: KEY, value: null, createRevision: "1", modRevision: REVISION, version: "0", lease: "0" },
  ],
  snapshotRevision: REVISION,
  terminalRevision: null,
  cursor: null,
  complete: true,
  unavailableThrough: null,
  gaps: [],
  stopReason: "snapshotEnd",
};

function fixture(extra: Partial<Keyspace> = {}) {
  const apply = vi.fn<Keyspace["apply"]>().mockResolvedValue({ commands: [] });
  const keyspace: Keyspace = {
    delimiter: "/",
    databases: () => Promise.resolve([{ index: 0, keys: 0, expires: 0, current: true }]),
    scan: () => Promise.resolve({ keys: [], cursor: null, scanned: 0 }),
    describe: () => Promise.resolve([]),
    read: vi.fn<Keyspace["read"]>(),
    preview: () => [],
    apply,
    rename: () => Promise.resolve(),
    expire: () => Promise.resolve(),
    remove: () => Promise.resolve(0),
    ...extra,
  };
  const plugin: DatasourcePlugin = {
    id: PLUGIN_ID,
    capabilities: ["commands", "keyValue"],
    connectionSchema: z.object({}),
    connect: () =>
      Promise.resolve({
        keyspace,
        serverVersion: null,
        execute: vi.fn(),
        close: () => Promise.resolve(),
      }),
  };
  const engine = createEngine({
    datasource: { id: "history", pluginId: PLUGIN_ID, config: {}, readOnly: false, keepAliveSeconds: 0 },
    plugins: [
      {
        status: "loaded",
        directory: "fixture",
        manifest: fakeManifest({ id: PLUGIN_ID, capabilities: ["commands", "keyValue"] }),
        plugin,
      },
    ],
  });
  return { engine, connection: engine.connect(), apply };
}

describe("key history engine bridge", () => {
  it.each([false, true])("givenRevisionConflict_whenCurrentKeyIsPresent%j_thenCarriesCurrentSnapshot", (present) => {
    const current = {
      database: 0,
      key: KEY,
      value: present ? { text: "", hex: null } : null,
      revision: present ? { createRevision: "1", modRevision: REVISION, version: "2", lease: "0" } : null,
      snapshotRevision: REVISION,
    };
    const error = new ConflictError("key", "revision differs", { current });
    expect(toEngineError(helperRequestFailed(error))).toMatchObject({ code: "conflict", keyConflict: current });
  });

  it("givenMalformedOrOversizedCurrentSnapshot_whenConflictBridged_thenOmitsUnsafePayload", () => {
    for (const current of [
      { database: 0, key: KEY, value: null, revision: null, snapshotRevision: 1 },
      {
        database: 0,
        key: KEY,
        value: { text: "x".repeat(KEY_HISTORY_MAX_BYTES + 1), hex: null },
        revision: null,
        snapshotRevision: "1",
      },
    ]) {
      const error = Object.assign(new PluginError("conflict", "changed"), { current });
      expect(toEngineError(helperRequestFailed(error))).not.toHaveProperty("keyConflict");
    }
  });
  it("givenHistory_whenRequested_thenPreservesBinaryKeyEmptyPutDeletionAndDecimalRevisions", async () => {
    const history = vi.fn<NonNullable<Keyspace["history"]>>().mockResolvedValue(PAGE);
    const { engine, connection } = fixture({ history });
    try {
      expect(await connection.handle(REQUEST)).toEqual({ id: 1, type: REQUEST.type, result: PAGE });
      const { id: _id, type: _type, ...expected } = REQUEST;
      expect(history).toHaveBeenCalledWith(expected);
      await connection.handle({ ...REQUEST, cursor: "opaque-next" });
      expect(history).toHaveBeenLastCalledWith({ ...expected, cursor: "opaque-next" });
      expect(await connection.handle({ id: 2, type: "keyspace.databases" })).toMatchObject({
        result: { features: { history: true } },
      });
    } finally {
      await connection.close();
      await engine.close();
    }
  });

  it("givenCompactedPage_whenRequested_thenPreservesGapsAndStopReason", async () => {
    const page: KeyHistoryPage = {
      ...PAGE,
      complete: false,
      unavailableThrough: "42",
      gaps: [{ fromRevision: "1", toRevision: "42", reason: "compacted" }],
      stopReason: "compacted",
    };
    const { engine, connection } = fixture({ history: () => Promise.resolve(page) });
    try {
      expect(await connection.handle(REQUEST)).toMatchObject({ result: page });
    } finally {
      await connection.close();
      await engine.close();
    }
  });

  it.each([
    { count: 0 },
    { count: KEY_HISTORY_MAX_COUNT + 1 },
    { count: 1.5 },
    { maxBytes: KEY_HISTORY_MAX_BYTES + 1 },
    { maxBytes: 0 },
    { timeoutMs: KEY_HISTORY_MAX_TIMEOUT_MS + 1 },
    { timeoutMs: 0 },
    { database: -1 },
    { cursor: 2 },
    { cursor: "x".repeat(KEY_HISTORY_MAX_CURSOR_LENGTH + 1) },
    { key: { text: "binary", hex: "zz" } },
  ])("givenInvalidHistoryBoundsOrTypes_whenRequested_thenRefusedBeforePluginCall", async (invalid) => {
    const history = vi.fn<NonNullable<Keyspace["history"]>>().mockResolvedValue(PAGE);
    const { engine, connection } = fixture({ history });
    try {
      expect(await connection.handle({ ...REQUEST, ...invalid })).toMatchObject({
        type: "engine.error",
        error: { code: "invalidRequest" },
      });
      expect(history).not.toHaveBeenCalled();
    } finally {
      await connection.close();
      await engine.close();
    }
  });

  it("givenOldPlugin_whenHistoryRequested_thenActionableTypedErrorAndNoHistoryFeature", async () => {
    const { engine, connection } = fixture();
    try {
      expect(await connection.handle(REQUEST)).toMatchObject({
        type: "engine.error",
        error: { code: "invalidRequest", hint: expect.stringContaining("plugin") as unknown },
      });
      expect(await connection.handle({ id: 2, type: "keyspace.databases" })).toMatchObject({
        result: { features: { history: false } },
      });
    } finally {
      await connection.close();
      await engine.close();
    }
  });

  it.each([false, true])("givenRevisionGuard_whenSupportIs%j_thenNeverSilentlyIgnored", async (supported) => {
    const { engine, connection, apply } = fixture({ features: { revisionGuard: supported } });
    const options = { type: "string", guard: true, revisionGuard: { modRevision: REVISION } };
    const changes = [{ kind: "setString", value: { text: "restored", hex: null }, original: null }];
    try {
      const response = await connection.handle({
        id: 1,
        type: "keyspace.apply",
        database: 0,
        key: KEY,
        changes,
        options,
      });
      if (supported) {
        expect(response).toMatchObject({ result: { commands: [] } });
        expect(apply).toHaveBeenCalledWith(0, KEY, changes, options);
      } else {
        expect(response).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
        expect(apply).not.toHaveBeenCalled();
      }
    } finally {
      await connection.close();
      await engine.close();
    }
  });

  it("givenLegacyApply_whenNoRevisionGuard_thenOldPluginStillWorks", async () => {
    const { engine, connection, apply } = fixture();
    try {
      expect(
        await connection.handle({
          id: 1,
          type: "keyspace.apply",
          database: 0,
          key: KEY,
          changes: [{ kind: "setString", value: { text: "", hex: null }, original: null }],
          options: { type: "string", guard: true },
        }),
      ).toMatchObject({ result: { commands: [] } });
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      await connection.close();
      await engine.close();
    }
  });

  it.each(["-1", "1.5", "01", 1])(
    "givenInvalidRevisionGuard_whenApplied_thenRefusedBeforePluginCall",
    async (modRevision) => {
      const { engine, connection, apply } = fixture({ features: { revisionGuard: true } });
      try {
        expect(
          await connection.handle({
            id: 1,
            type: "keyspace.apply",
            database: 0,
            key: KEY,
            changes: [{ kind: "setString", value: { text: "", hex: null }, original: null }],
            options: { type: "string", guard: true, revisionGuard: { modRevision } },
          }),
        ).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
        expect(apply).not.toHaveBeenCalled();
      } finally {
        await connection.close();
        await engine.close();
      }
    },
  );

  it("givenPluginConflict_whenRestoreSubmitted_thenTypedConflict", async () => {
    const apply = vi.fn<Keyspace["apply"]>().mockRejectedValue(new PluginError("conflict", "The key changed."));
    const { engine, connection } = fixture({ features: { revisionGuard: true }, apply });
    try {
      expect(
        await connection.handle({
          id: 1,
          type: "keyspace.apply",
          database: 0,
          key: KEY,
          changes: [{ kind: "setString", value: { text: "", hex: null }, original: null }],
          options: { type: "string", guard: true, revisionGuard: { modRevision: "0" } },
        }),
      ).toMatchObject({ type: "engine.error", error: { code: "conflict" } });
    } finally {
      await connection.close();
      await engine.close();
    }
  });
});
