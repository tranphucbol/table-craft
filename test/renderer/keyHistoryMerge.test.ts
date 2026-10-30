import { describe, expect, it, vi } from "vitest";
import type {
  KeyConflictSnapshot,
  KeyDetails,
  KeyHistoryEvent,
  KeyHistoryPage,
  KeyRevision,
  OpenedKey,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { alignDiff, diffText, keyDiff } from "@table-craft/desktop/renderer/model/keyDiff.js";
import {
  appendHistory,
  historyEventId,
  revisionAge,
  previousHistoryVersion,
  historyLineDelta,
} from "@table-craft/desktop/renderer/model/keyHistory.js";
import { mergeKeyText } from "@table-craft/desktop/renderer/model/keyMerge.js";
import { beginKeyMerge, canSaveKeyMerge } from "@table-craft/desktop/renderer/model/keyMergeSession.js";
import {
  createKeyTabsStore,
  pendingKeyChanges,
  KEY_SAVED_NOTICE_MS,
} from "@table-craft/desktop/renderer/state/keyTabs.js";
import { keyValueSize, keyValueCount } from "@table-craft/desktop/renderer/keys/keyValueFacts.js";
import { parseKeyYaml } from "@table-craft/desktop/renderer/model/valueFormats.js";
import { KEY_ACTIONS, KEY_ACTION_IDS } from "@table-craft/desktop/renderer/actions/keyActions.js";
import { createActionRegistry } from "@table-craft/desktop/renderer/actions/registry.js";
import { createKeyDispatcher, findClashes } from "@table-craft/desktop/renderer/actions/keymap.js";
import { IDLE_CONTEXT, keydown } from "./support.js";

const bytes = (text: string) => ({ text, hex: null });
const KEY = bytes("/config/app");
const TARGET = { datasourceId: "config", database: 0, key: KEY };
const revision = (modRevision: string, version = "2"): KeyRevision => ({
  createRevision: "1",
  modRevision,
  version,
  lease: "123",
});
const DETAILS: KeyDetails = {
  key: KEY,
  type: "string",
  typeName: "string",
  ttlMs: null,
  length: 1,
  memoryBytes: null,
  encoding: null,
  idleSeconds: null,
  revision: revision("10"),
};
const event = (modRevision: string, value = "old"): KeyHistoryEvent => ({
  ...revision(modRevision),
  key: KEY,
  kind: "PUT",
  value: bytes(value),
});
const page = (events: readonly KeyHistoryEvent[], extra: Partial<KeyHistoryPage> = {}): KeyHistoryPage => ({
  events,
  snapshotRevision: "10",
  terminalRevision: "1",
  cursor: null,
  complete: true,
  unavailableThrough: null,
  gaps: [],
  stopReason: "snapshotEnd",
  ...extra,
});
const snapshot = (value: string | null, modRevision = "11"): KeyConflictSnapshot => ({
  database: 0,
  key: KEY,
  value: value === null ? null : bytes(value),
  revision: value === null ? null : revision(modRevision, "3"),
  snapshotRevision: modRevision,
});
const failure = (value: string | null, modRevision = "11") =>
  new EngineRequestError({
    code: "conflict",
    message: "Key changed.",
    hint: "Merge the changes.",
    keyConflict: snapshot(value, modRevision),
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  options: {
    readonly history?: () => Promise<KeyHistoryPage>;
    readonly apply?: () => Promise<unknown>;
    readonly opened?: () => Promise<OpenedKey>;
    readonly readOnly?: () => boolean;
    readonly features?: { readonly history?: boolean; readonly revisionGuard?: boolean };
  } = {},
) {
  const call = vi.fn((type: string): Promise<unknown> => {
    if (type === "session.open") return Promise.resolve({ sessionId: "s1" });
    if (type === "keyspace.databases")
      return Promise.resolve({ features: options.features ?? { history: true, revisionGuard: true } });
    if (type === "keyspace.open")
      return (
        options.opened?.() ?? Promise.resolve({ details: DETAILS, value: "base", statement: null, readOnly: null })
      );
    if (type === "keyspace.history") return options.history?.() ?? Promise.resolve(page([event("9")]));
    if (type === "keyspace.apply") return options.apply?.() ?? Promise.resolve({ commands: [] });
    return Promise.resolve([]);
  });
  const store = createKeyTabsStore({
    connect: () => Promise.resolve({ call } as unknown as EngineClient),
    readOnly: options.readOnly,
  });
  await store.getState().open("key", TARGET);
  return { store, call };
}

describe("key history", () => {
  it.each([
    { value: { text: "\\xff", hex: "ff" }, enabled: true },
    { value: bytes("k8s\u0000protobuf"), enabled: false },
    { value: { text: "k8s\\x00", hex: "6b387300ff" }, enabled: false },
  ])("givenHistoryValue_whenRestoreActionChecked_thenBinaryAndKubernetesAgreeWithStore", async ({ value, enabled }) => {
    const { store } = await fixture({ history: () => Promise.resolve(page([{ ...event("9"), value }])) });
    await store.getState().loadHistory("key");
    const registry = createActionRegistry(() => ({
      ...IDLE_CONTEXT,
      activeTab: { id: "key", kind: "key", title: KEY.text },
      keyTab: store.getState().tabs.key!,
    }));
    registry.register(KEY_ACTIONS);
    expect(registry.isEnabled(KEY_ACTION_IDS.restoreHistory)).toBe(enabled);
    expect(store.getState().restoreHistory("key")).toBe(enabled);
  });
  it("givenPendingTextOrBinary_whenCounted_thenMeasuredUtf8BytesAndNoInventedLines", async () => {
    const { store } = await fixture();
    store.getState().setStringValue("key", bytes("é\n猫"));
    expect(keyValueSize(store.getState().tabs.key!)).toBe(6);
    expect(keyValueCount(store.getState().tabs.key!)).toBe("2 lines · 6 bytes");
    store.getState().setStringValue("key", { text: "\\xff", hex: "ff00" });
    expect(keyValueSize(store.getState().tabs.key!)).toBe(2);
    expect(keyValueCount(store.getState().tabs.key!)).toBe("2 bytes");
  });
  it("givenAdjacentVersions_whenCompared_thenLineDeltaAndNoGuessedPreviousAcrossGap", () => {
    const current = { ...event("9", "a\nc"), version: "3" };
    const previous = { ...event("8", "a\nb"), version: "2" };
    expect(previousHistoryVersion([current, previous], current)).toEqual(previous);
    expect(historyLineDelta(current, previous)).toEqual({ added: 1, removed: 1 });
    expect(previousHistoryVersion([current, { ...previous, version: "1" }], current)).toBeNull();
    expect(previousHistoryVersion([current, { ...previous, createRevision: "7" }], current)).toBeNull();
    expect(historyLineDelta(current, { ...previous, value: { text: "", hex: "ff" } })).toBeNull();
  });

  it("givenRestoredValue_whenSaveRefused_thenRestoreNoticeDoesNotSurviveConflict", async () => {
    const { store } = await fixture({ apply: () => Promise.reject(failure("theirs")) });
    await store.getState().loadHistory("key");
    store.getState().restoreHistory("key");
    expect(store.getState().tabs.key?.notice).toContain("Historical value staged");
    expect(await store.getState().submit("key")).toBe(false);
    expect(store.getState().tabs.key?.notice).toBeNull();
    expect(store.getState().tabs.key?.merge?.visible).toBe(true);
  });

  it("givenSuccessfulGuardedSave_whenFourSecondsPass_thenVersionNoticeClears", async () => {
    vi.useFakeTimers();
    try {
      const { store } = await fixture();
      store.getState().setStringValue("key", bytes("mine"));
      expect(await store.getState().submit("key")).toBe(true);
      expect(store.getState().tabs.key?.notice).toBe("Saved as v3");
      vi.advanceTimersByTime(KEY_SAVED_NOTICE_MS - 1);
      expect(store.getState().tabs.key?.notice).toBe("Saved as v3");
      vi.advanceTimersByTime(1);
      expect(store.getState().tabs.key?.notice).toBeNull();
      store.getState().close("key");
    } finally {
      vi.useRealTimers();
    }
  });

  it("givenSavedNotice_whenInvalidInputOrReload_thenNoStaleSavedOrRestoreNotice", async () => {
    const { store } = await fixture();
    store.getState().setStringValue("key", bytes("mine"));
    await store.getState().submit("key");
    store.getState().setStringProblem("key", "Invalid hex");
    expect(store.getState().tabs.key?.notice).toBeNull();
    store.getState().revertAll("key");
    await store.getState().loadHistory("key");
    store.getState().restoreHistory("key");
    await store.getState().reload("key");
    expect(store.getState().tabs.key?.notice).toBeNull();
    store.getState().close("key");
  });

  it("givenKubernetesEnvelope_whenRead_thenWritesBlockedWithTruthfulDisclosure", async () => {
    const { store, call } = await fixture({
      opened: () => Promise.resolve({ details: DETAILS, value: "k8s\u0000protobuf", statement: null, readOnly: null }),
    });
    expect(store.getState().tabs.key?.readOnly).toContain("Decoding is not supported");
    store.getState().setStringValue("key", bytes("changed"));
    expect(await store.getState().submit("key")).toBe(false);
    expect(call.mock.calls.some(([type]) => type === "keyspace.apply")).toBe(false);
  });
  it("givenLargeRevisions_whenPagesOverlap_thenExactOrderAndDistance", () => {
    const events = appendHistory([event("9007199254740993")], [event("9007199254740994"), event("9007199254740993")]);
    expect(events.map(historyEventId)).toEqual(["9007199254740994:PUT", "9007199254740993:PUT"]);
    expect(revisionAge("9007199254740995", "9007199254740993")).toBe("2 revisions ago");
    expect(revisionAge("9007199254740995", "9007199254740994")).toBe("1 revision ago");
  });

  it("givenHistory_whenRestored_thenStagesWithoutWriteAndUsesCurrentBaseline", async () => {
    const { store, call } = await fixture();
    await store.getState().loadHistory("key");
    expect(store.getState().restoreHistory("key")).toBe(true);
    const tab = store.getState().tabs.key!;
    expect(tab).toMatchObject({
      stringValue: bytes("old"),
      details: { revision: revision("10") },
      history: { mode: "value" },
    });
    expect(pendingKeyChanges(tab)).toEqual({
      changes: [{ kind: "setString", value: bytes("old"), original: bytes("base") }],
    });
    expect(call.mock.calls.some(([type]) => type === "keyspace.apply")).toBe(false);
    await store.getState().submit("key");
    expect(call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({ options: { type: "string", guard: true, revisionGuard: { modRevision: "10" } } }),
    );
  });

  it("givenUnsavedOrReadOnlyOrDisconnected_whenRestored_thenDoesNotReplaceEdit", async () => {
    let readOnly = false;
    const { store } = await fixture({ readOnly: () => readOnly });
    await store.getState().loadHistory("key");
    store.getState().setStringValue("key", bytes("mine"));
    store.getState().historyMode("key", "history");
    expect(store.getState().restoreHistory("key")).toBe(false);
    expect(store.getState().tabs.key?.stringValue).toEqual(bytes("mine"));
    store.getState().revertAll("key");
    readOnly = true;
    expect(store.getState().restoreHistory("key")).toBe(false);
    readOnly = false;
    store.getState().detach("config", null);
    expect(store.getState().restoreHistory("key")).toBe(false);
  });

  it.each([{ ...event("8"), kind: "DELETE" as const, value: null }, event("9", "k8s\u0000protobuf")])(
    "givenDeletionOrKubernetes_whenRestored_thenRefused",
    async (version) => {
      const { store } = await fixture({ history: () => Promise.resolve(page([version])) });
      await store.getState().loadHistory("key");
      expect(store.getState().restoreHistory("key")).toBe(false);
    },
  );

  it("givenBinaryHistory_whenRestored_thenStagesExactBytesAndKeepsGuard", async () => {
    const value = { text: "\\xff\\x00", hex: "ff00" };
    const { store, call } = await fixture({ history: () => Promise.resolve(page([{ ...event("9"), value }])) });
    await store.getState().loadHistory("key");
    expect(store.getState().restoreHistory("key")).toBe(true);
    expect(store.getState().tabs.key?.stringValue).toEqual(value);
    expect(call.mock.calls.some(([type]) => type === "keyspace.apply")).toBe(false);
    await store.getState().submit("key");
    expect(call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({
        changes: [{ kind: "setString", value, original: bytes("base") }],
        options: { type: "string", guard: true, revisionGuard: { modRevision: "10" } },
      }),
    );
  });

  it("givenPartialPages_whenAppended_thenKeepsGapsAndDeduplicates", async () => {
    let calls = 0;
    const { store, call } = await fixture({
      history: () =>
        Promise.resolve(
          calls++ === 0
            ? page([event("9")], {
                cursor: "older",
                complete: false,
                stopReason: "byteLimit",
                gaps: [{ fromRevision: "2", toRevision: "3", reason: "compacted" }],
              })
            : page([event("9"), event("4")]),
        ),
    });
    await store.getState().loadHistory("key");
    await store.getState().loadHistory("key");
    expect(store.getState().tabs.key?.history?.events).toHaveLength(2);
    expect(store.getState().tabs.key?.history?.page?.gaps).toHaveLength(1);
    expect(call).toHaveBeenCalledWith(
      "keyspace.history",
      expect.objectContaining({ cursor: "older", count: 20, maxBytes: 1_048_576, timeoutMs: 5_000 }),
    );
  });

  it.each(["close", "detach", "reload"] as const)("givenPendingHistory_when%s_thenLatePageIgnored", async (action) => {
    const pending = deferred<KeyHistoryPage>();
    const { store } = await fixture({ history: () => pending.promise });
    const request = store.getState().loadHistory("key");
    if (action === "close") store.getState().close("key");
    if (action === "detach") store.getState().detach("config", null);
    if (action === "reload") await store.getState().reload("key");
    pending.resolve(page([event("9")]));
    await request;
    expect(store.getState().tabs.key?.history?.events ?? []).toEqual([]);
  });

  it("givenNoOptionalFeatures_whenOpened_thenNoHistoryOrRevisionGuard", async () => {
    const { store, call } = await fixture({ features: {} });
    await store.getState().loadHistory("key");
    store.getState().setStringValue("key", bytes("mine"));
    await store.getState().submit("key", false);
    expect(call.mock.calls.some(([type]) => type === "keyspace.history")).toBe(false);
    expect(call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({ options: { type: "string", guard: false } }),
    );
  });

  it("givenInvalidEditorText_whenRestoredOrSubmitted_thenDoesNotLoseUnsavedInput", async () => {
    const { store, call } = await fixture();
    await store.getState().loadHistory("key");
    store.getState().setStringProblem("key", "Invalid hex");
    expect(store.getState().restoreHistory("key")).toBe(false);
    expect(await store.getState().submit("key")).toBe(false);
    expect(call.mock.calls.some(([type]) => type === "keyspace.apply")).toBe(false);
    store.getState().setStringValue("key", bytes("valid"));
    expect(store.getState().tabs.key?.stringProblem).toBeNull();
  });

  it("givenAbsentKey_whenOldPutRestored_thenStagesRecreationGuardedOnAbsence", async () => {
    const { store, call } = await fixture({
      opened: () =>
        Promise.resolve({
          details: { ...DETAILS, type: null, revision: undefined },
          value: null,
          statement: null,
          readOnly: null,
        }),
    });
    await store.getState().loadHistory("key");
    expect(store.getState().restoreHistory("key")).toBe(true);
    expect(store.getState().tabs.key).toMatchObject({
      recreating: true,
      lostType: "string",
      stringValue: bytes("old"),
    });
    await store.getState().submit("key");
    expect(call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({
        options: { type: "string", guard: true, revisionGuard: { modRevision: "0" } },
        changes: [{ kind: "setString", original: null, value: bytes("old") }],
      }),
    );
  });
});

describe("key merge", () => {
  it("givenIndependentYamlPaths_whenMerged_thenStructuredAndIntegersRemainExact", () => {
    const merged = mergeKeyText(
      "# Original comment\nlimits:\n  daily: 1\n  weekly: 2\nrevision: 9007199254740993\n",
      "limits:\n  daily: 3\n  weekly: 2\nrevision: 9007199254740993\n",
      "limits:\n  daily: 1\n  weekly: 4\nrevision: 9007199254740993\n",
    );
    expect(merged.format).toBe("yaml");
    expect(merged.conflicts).toEqual([]);
    expect(parseKeyYaml(merged.text)).toEqual({ limits: { daily: 3n, weekly: 4n }, revision: 9007199254740993n });
    expect(merged.text).not.toContain("Original comment");
  });

  it("givenOverlappingYamlPaths_whenChosen_thenOnlyThatPathIsReplaced", () => {
    const base = "limits:\n  daily: 1\nflag: true\n";
    const theirs = "limits:\n  daily: 2\nflag: true\n";
    const yours = "limits:\n  daily: 3\nflag: false\n";
    const merged = mergeKeyText(base, theirs, yours);
    expect(merged.conflicts.map((conflict) => conflict.path)).toEqual(["/limits/daily"]);
    const resolved = mergeKeyText(base, theirs, yours, { "/limits/daily": "theirs" });
    expect(resolved.conflicts).toEqual([]);
    expect(parseKeyYaml(resolved.text)).toEqual({ limits: { daily: 2n }, flag: false });
    expect(mergeKeyText("a: 1\n", "{}\n# YAML\n", "a: null\n").conflicts).toHaveLength(1);
  });

  it("givenYamlArrays_whenBothChanged_thenWholeArrayConflicts", () => {
    const merged = mergeKeyText("items: [a, b]\n", "items: [c, b]\n", "items: [a, d]\n");
    expect(merged.format).toBe("yaml");
    expect(merged.conflicts.map((conflict) => conflict.path)).toEqual(["/items"]);
  });

  it("givenUnsafeYamlFloatOrAliases_whenMerged_thenNoLossyNormalization", () => {
    for (const source of ["value: 1.0000000000000001\n", "value: &anchor [1]\ncopy: *anchor\n"]) {
      const merged = mergeKeyText(source, source, source);
      expect(merged.format).toBe("text");
      expect(merged.text).toBe(source);
      expect(diffText(bytes(source))).toBe(source);
    }
  });

  it("givenYamlFormattingOnly_whenDiffed_thenNormalizedForComparison", () => {
    expect(diffText(bytes("limits: {daily: 1, weekly: 2}\n"))).toBe(
      diffText(bytes("limits:\n  daily: 1\n  weekly: 2\n")),
    );
  });

  it("givenInvalidManualYamlResult_whenAcknowledged_thenSaveStillBlocked", () => {
    const merge = beginKeyMerge(snapshot("a: 2\nb: 1\n"), bytes("a: 1\nb: 1\n"), bytes("a: 1\nb: 2\n"));
    expect(merge.merged.format).toBe("yaml");
    expect(canSaveKeyMerge(merge)).toBe(true);
    expect(canSaveKeyMerge({ ...merge, manual: true, acknowledged: true, text: "a: [" })).toBe(false);
  });

  it("givenMultipleConflicts_whenNavigatingBackward_thenWrapsAndHasDistinctShortcut", async () => {
    const { store } = await fixture({
      opened: () => Promise.resolve({ details: DETAILS, value: '{"a":1,"b":1}', statement: null, readOnly: null }),
      apply: () => Promise.reject(failure('{"a":2,"b":2}')),
    });
    store.getState().setStringValue("key", bytes('{"a":3,"b":3}'));
    await store.getState().submit("key");
    expect(store.getState().tabs.key?.merge?.merged.conflicts).toHaveLength(2);
    store.getState().previousMergeConflict("key");
    expect(store.getState().tabs.key?.merge?.conflictIndex).toBe(1);
    store.getState().previousMergeConflict("key");
    expect(store.getState().tabs.key?.merge?.conflictIndex).toBe(0);
    store.getState().nextMergeConflict("key");
    expect(store.getState().tabs.key?.merge?.conflictIndex).toBe(1);
    expect(KEY_ACTIONS.find((action) => action.id === KEY_ACTION_IDS.previousMergeConflict)?.shortcut).toBe("Shift+F7");
    expect(findClashes(KEY_ACTIONS)).toEqual([]);
    const ran = vi.fn();
    const registry = createActionRegistry(() => ({
      ...IDLE_CONTEXT,
      activeTab: { id: "key", kind: "key", title: KEY.text },
      keyTab: store.getState().tabs.key!,
    }));
    const previousAction = KEY_ACTIONS.find((action) => action.id === KEY_ACTION_IDS.previousMergeConflict)!;
    registry.register([{ ...previousAction, run: ran }]);
    const dispatch = createKeyDispatcher({ registry, platform: "mac", paletteOpen: () => false });
    dispatch(keydown({ key: "F7", shiftKey: true }));
    expect(ran).toHaveBeenCalledOnce();
  });
  it.each(["base", "", '{"a":1}'])(
    "givenDeletedBaseline_whenConcurrentKeyRecreated_thenRequiresExplicitResolution_%s",
    (recreated) => {
      const deleted = beginKeyMerge(snapshot(null), bytes("base"), bytes("yours"));
      const chosen = { ...deleted, acknowledged: true };
      const repeated = beginKeyMerge(snapshot(recreated, "12"), bytes("base"), bytes("yours"), chosen);
      expect(repeated.base).toBeNull();
      expect(repeated.text).toBe("yours");
      expect(repeated.merged.automatic).toBe(0);
      expect(repeated.merged.conflicts).toEqual([{ path: "", theirs: recreated, yours: "yours" }]);
      expect(canSaveKeyMerge(repeated)).toBe(false);
      expect(mergeKeyText(repeated.base, recreated, repeated.yours, { "": "theirs" })).toMatchObject({
        text: recreated,
        conflicts: [],
      });
    },
  );

  it("givenDeletedBaseline_whenConcurrentRecreationMatchesMine_thenNoDivergentValueToResolve", () => {
    const deleted = beginKeyMerge(snapshot(null), bytes("base"), bytes("yours"));
    const repeated = beginKeyMerge(snapshot("yours", "12"), bytes("base"), bytes("yours"), {
      ...deleted,
      acknowledged: true,
    });
    expect(repeated.base).toBeNull();
    expect(repeated.merged.conflicts).toEqual([]);
    expect(canSaveKeyMerge(repeated)).toBe(true);
  });

  it("givenDeletionThenRecreation_whenSavingYoursAgain_thenStopsUntilRecreationIsResolved", async () => {
    let applies = 0;
    const { store, call } = await fixture({
      apply: () => Promise.reject(applies++ === 0 ? failure(null) : failure("base", "12")),
    });
    store.getState().setStringValue("key", bytes("yours"));
    await store.getState().submit("key");
    store.getState().chooseMerge("key", "", "yours");
    await store.getState().saveMerge("key");
    expect(store.getState().tabs.key?.merge).toMatchObject({
      base: null,
      acknowledged: false,
      text: "yours",
      snapshot: { revision: { modRevision: "12" } },
    });
    expect(await store.getState().saveMerge("key")).toBe(false);
    expect(call.mock.calls.filter(([type]) => type === "keyspace.apply")).toHaveLength(2);
    store.getState().chooseMerge("key", "", "yours");
    await store.getState().saveMerge("key");
    expect(call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({
        options: { type: "string", guard: true, revisionGuard: { modRevision: "12" } },
        changes: [{ kind: "setString", value: bytes("yours"), original: bytes("base") }],
      }),
    );
  });

  it("givenIndependentJsonPaths_whenMerged_thenAutomaticAndMissingDistinctFromNull", () => {
    const merged = mergeKeyText('{"a":1,"b":1}', '{"a":2,"b":1}', '{"a":1,"b":null}');
    expect(JSON.parse(merged.text)).toEqual({ a: 2, b: null });
    expect(merged.conflicts).toEqual([]);
    expect(mergeKeyText('{"a":1}', "{}", '{"a":null}').conflicts).toHaveLength(1);
  });

  it.each(['{"n":9007199254740993}', '{"n":1.0000000000000001}'])(
    "givenUnsafeJsonNumber_whenMerged_thenTextIsNotRounded_%s",
    (base) => {
      expect(mergeKeyText(base, base, base).text).toBe(base);
      expect(diffText(bytes(base))).toBe(base);
    },
  );

  it("givenConflict_whenResolvedAndSaved_thenGuardUsesConflictSnapshotNotOriginal", async () => {
    let calls = 0;
    const { store, call } = await fixture({
      apply: () => (calls++ === 0 ? Promise.reject(failure("theirs")) : Promise.resolve({ commands: [] })),
    });
    store.getState().setStringValue("key", bytes("yours"));
    expect(await store.getState().submit("key", false)).toBe(false);
    expect(await store.getState().saveMerge("key")).toBe(false);
    store.getState().chooseMerge("key", "Line 1", "yours");
    expect(await store.getState().saveMerge("key")).toBe(true);
    expect(call).toHaveBeenLastCalledWith("keyspace.databases", {});
    expect(call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({
        changes: [{ kind: "setString", value: bytes("yours"), original: bytes("theirs") }],
        options: { type: "string", guard: true, revisionGuard: { modRevision: "11" } },
      }),
    );
  });

  it("givenManualResult_whenServerChangesAgain_thenRetainsResultAndRechecksNewSnapshot", async () => {
    let calls = 0;
    const { store } = await fixture({
      apply: () => Promise.reject(failure(calls++ === 0 ? "theirs" : "new theirs", calls === 1 ? "11" : "12")),
    });
    store.getState().setStringValue("key", bytes("yours"));
    await store.getState().submit("key");
    store.getState().editMerge("key", "hand merged");
    store.getState().acknowledgeMerge("key");
    await store.getState().saveMerge("key");
    const merge = store.getState().tabs.key?.merge;
    expect(merge).toMatchObject({
      text: "hand merged",
      yours: "hand merged",
      changedAgain: true,
      snapshot: { revision: { modRevision: "12" } },
    });
    expect(merge !== undefined && merge !== null && canSaveKeyMerge(merge)).toBe(false);
  });

  it("givenDeletedSnapshot_whenChoosingYours_thenChecksAbsenceBeforeRecreating", async () => {
    const { store, call } = await fixture({ apply: () => Promise.reject(failure(null)) });
    store.getState().setStringValue("key", bytes("yours"));
    await store.getState().submit("key");
    store.getState().chooseMerge("key", "", "yours");
    await store.getState().saveMerge("key");
    expect(call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({
        options: { type: "string", guard: true, revisionGuard: { modRevision: "0" } },
        changes: [{ kind: "setString", original: null, value: bytes("yours") }],
      }),
    );
  });

  it("givenBinaryConflict_whenMerged_thenReadOnlyAndHexRetained", () => {
    const merge = beginKeyMerge(snapshot("theirs"), bytes("base"), { text: "\\xff", hex: "ff" });
    expect(canSaveKeyMerge(merge)).toBe(false);
    expect(diffText(merge.yoursValue)).toBe("Binary value (hex)\nff");
  });

  it("givenCancelledMerge_whenSubmitting_thenReopensWithoutWriting", async () => {
    const { store, call } = await fixture({ apply: () => Promise.reject(failure("theirs")) });
    store.getState().setStringValue("key", bytes("yours"));
    await store.getState().submit("key");
    store.getState().editMerge("key", "hand merged");
    store.getState().cancelMerge("key");
    expect(store.getState().tabs.key?.stringValue).toEqual(bytes("hand merged"));
    await store.getState().submit("key");
    expect(store.getState().tabs.key?.merge?.visible).toBe(true);
    expect(call.mock.calls.filter(([type]) => type === "keyspace.apply")).toHaveLength(1);
  });

  it("givenInFlightSave_whenTabReopened_thenLateSuccessCannotClearNewEdits", async () => {
    const pending = deferred<unknown>();
    const { store } = await fixture({ apply: () => pending.promise });
    store.getState().setStringValue("key", bytes("old edit"));
    const saving = store.getState().submit("key");
    expect(await store.getState().reload("key")).toBe(false);
    store.getState().close("key");
    await store.getState().open("key", TARGET);
    store.getState().setStringValue("key", bytes("new edit"));
    pending.resolve({ commands: [] });
    await saving;
    expect(store.getState().tabs.key?.stringValue).toEqual(bytes("new edit"));
  });

  it("givenDiff_whenChanged_thenExplicitSignsAndLineNumbers", () => {
    expect(keyDiff("a\nb", "a\nc")).toEqual([
      { kind: "same", text: "a", left: 1, right: 1 },
      { kind: "delete", text: "b", left: 2, right: null },
      { kind: "insert", text: "c", left: null, right: 2 },
    ]);
    expect(diffText(null)).toBe("(key absent)");
    const paired = alignDiff(keyDiff("a\nb", "a\nc"));
    expect(paired[1]).toMatchObject({ left: { kind: "delete", text: "b" }, right: { kind: "insert", text: "c" } });
  });
});
