import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyDetails, KeyHistoryEvent, KeyHistoryPage, WireValue } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import type { ValueTextEdit } from "@table-craft/desktop/renderer/grid/ValuePanel.js";
import { StringValueEditor } from "@table-craft/desktop/renderer/keys/StringValueEditor.js";
import { decodeValue, valueBytes } from "@table-craft/desktop/renderer/model/valueFormats.js";
import {
  createKeyTabsStore,
  pendingKeyChanges,
  useKeyTabs,
  type KeyTab,
} from "@table-craft/desktop/renderer/state/keyTabs.js";

vi.mock("../../packages/desktop/node_modules/react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemo: <T>(factory: () => T): T => factory(),
}));

const KEY = { text: "/config/app", hex: null };
const DETAILS: KeyDetails = {
  key: KEY,
  type: "string",
  typeName: "string",
  ttlMs: 60_000,
  length: 7,
  memoryBytes: null,
  encoding: null,
  idleSeconds: null,
  revision: { createRevision: "1", modRevision: "10", version: "2", lease: "123" },
};
const OLD: KeyHistoryEvent = {
  key: KEY,
  kind: "PUT",
  value: { text: "old", hex: null },
  createRevision: "1",
  modRevision: "9",
  version: "1",
  lease: "old-lease",
};
const PAGE: KeyHistoryPage = {
  events: [OLD],
  snapshotRevision: "10",
  terminalRevision: "1",
  cursor: null,
  complete: true,
  unavailableThrough: null,
  gaps: [],
  stopReason: "snapshotEnd",
};

function editorProps(tab: KeyTab) {
  const rendered: unknown = StringValueEditor({ tab, tabId: "key", format: "text", editable: true });
  const element = rendered as {
    readonly props: {
      readonly children: { readonly props: { readonly value: WireValue | undefined; readonly edit: ValueTextEdit } };
    };
  };
  return element.props.children.props;
}

afterEach(() => vi.restoreAllMocks());

describe("string editor replacement contract", () => {
  it("givenMountedCurrentValue_whenHistoryRestored_thenChangesEditorKeyAndDecodedDocumentButNotSaveBaseline", async () => {
    const call = vi.fn((type: string): Promise<unknown> => {
      if (type === "session.open") return Promise.resolve({ sessionId: "session" });
      if (type === "keyspace.open")
        return Promise.resolve({ details: DETAILS, value: "current", statement: null, readOnly: null });
      if (type === "keyspace.databases") return Promise.resolve({ features: { history: true, revisionGuard: true } });
      if (type === "keyspace.history") return Promise.resolve(PAGE);
      return Promise.resolve(null);
    });
    const store = createKeyTabsStore({
      connect: () => Promise.resolve({ call } as unknown as EngineClient),
      clock: () => 1_000,
    });
    await store.getState().open("key", { datasourceId: "config", database: 0, key: KEY });
    vi.spyOn(useKeyTabs, "getState").mockImplementation(store.getState);
    const original = store.getState().tabs.key!;
    const mounted = editorProps(original);
    expect(mounted.value).toBe("current");
    store.getState().historyMode("key", "history");
    await vi.waitFor(() => expect(store.getState().tabs.key?.history?.events).toHaveLength(1));
    expect(editorProps(store.getState().tabs.key!).edit.revision).toBe(mounted.edit.revision);

    expect(store.getState().restoreHistory("key")).toBe(true);
    const restored = store.getState().tabs.key!;
    const replacement = editorProps(restored);
    // ValuePanel remounts its retained document only when edit.revision changes, after decoding the new bytes.
    expect(replacement.edit.revision).not.toBe(mounted.edit.revision);
    expect(await decodeValue(valueBytes(replacement.value)!, "text")).toMatchObject({ text: "old" });
    expect(restored.details).toBe(original.details);
    expect(restored.value).toBe(original.value);
    expect(restored.readAt).toBe(original.readAt);
    expect(restored.details?.revision?.lease).toBe("123");

    replacement.edit.onChange("old plus typing", "text");
    const typed = store.getState().tabs.key!;
    expect(editorProps(typed).edit.revision).toBe(replacement.edit.revision);
    expect(pendingKeyChanges(typed)).toEqual({
      changes: [
        { kind: "setString", value: { text: "old plus typing", hex: null }, original: { text: "current", hex: null } },
      ],
    });
    expect(call.mock.calls.some(([type]) => type === "keyspace.apply")).toBe(false);

    store.getState().revertAll("key");
    const reverted = editorProps(store.getState().tabs.key!);
    expect(reverted.edit.revision).not.toBe(replacement.edit.revision);
    expect(reverted.value).toBe("current");
  });
});
