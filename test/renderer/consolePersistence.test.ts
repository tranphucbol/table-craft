import { afterEach, describe, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { history, historyField, redo, undo } from "@codemirror/commands";
import type { CommandAdmission } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { scrubEditorState } from "@table-craft/desktop/renderer/console/editorPrivacy.js";
import {
  AUTOSAVE_DELAY_MS,
  bridgeConsoleFiles,
  createAutosave,
} from "@table-craft/desktop/renderer/state/consoleFiles.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import {
  checkConsolePersistence,
  PERSISTENCE_REJECTED,
  PERSISTENCE_UNCHECKED,
} from "@table-craft/desktop/renderer/state/consolePersistence.js";
import { REDIS_PLUGIN, view } from "./datasourceViews.js";

const host = vi.hoisted(() => ({ write: vi.fn(() => Promise.resolve({ ok: true, value: null })) }));
vi.mock("@table-craft/desktop/renderer/bridge.js", () => ({ bridge: () => ({ writeConsole: host.write }) }));

const SECRET_TEXT = "get /before\nuser add bob:private-password\nget /after";
const REJECT: CommandAdmission = { admit: "reject", safeLabel: "credential command" };
const EXECUTE: CommandAdmission = { admit: "execute", safeLabel: "" };

function engine(answer: unknown = [REJECT]) {
  const call = vi.fn(() => Promise.resolve(answer));
  return { call, client: { call } as unknown as EngineClient };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  host.write.mockClear();
  useConsoles.setState({ consoles: {} });
  useDatasources.setState({ datasources: [], plugins: [], connections: {} });
});

describe("console persistence privacy", () => {
  it("givenInlinePassword_whenAutosaveFiresBeforeExecute_thenAdmissionPrecedesAnyFileWrite", async () => {
    vi.useFakeTimers();
    const { call, client } = engine();
    useDatasources.setState({
      datasources: [view({ id: "kv", name: "kv", pluginId: REDIS_PLUGIN.id })],
      plugins: [REDIS_PLUGIN],
      connections: { kv: { status: "connected", error: null, serverVersion: null, serverBrand: null } },
    });
    vi.spyOn(useDatasources.getState(), "connect").mockResolvedValue(client);
    await useConsoles.getState().open("privacy", "kv", { connect: false, sql: SECRET_TEXT });
    const onError = vi.fn();
    const autosave = createAutosave({
      files: bridgeConsoleFiles(),
      timers: {
        set: (run, ms) => setTimeout(run, ms),
        clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
      onError,
    });
    autosave.changed("kv", "console", SECRET_TEXT);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);

    expect(call).toHaveBeenCalledExactlyOnceWith("commands.admit", { commands: [SECRET_TEXT] });
    expect(host.write).not.toHaveBeenCalled();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: PERSISTENCE_REJECTED });
    expect(useConsoles.getState().consoles.privacy).toMatchObject({ sql: "", privacyReset: 1 });
  });

  it("givenWholeDocument_whenSaving_thenOriginalSnapshotIsAdmittedWithoutSplitting", async () => {
    const { client, call } = engine([EXECUTE]);
    const scrub = vi.fn();
    await checkConsolePersistence("get /a\nget /b", {
      capabilities: ["commands"],
      client: () => Promise.resolve(client),
      scrub,
    });
    expect(call).toHaveBeenCalledWith("commands.admit", { commands: ["get /a\nget /b"] });
    expect(scrub).not.toHaveBeenCalled();
  });

  it("givenEditsDuringAdmission_whenOldTextIsRejected_thenUndoResetStillReachesTheOriginalEditor", async () => {
    let rejectText: (value: unknown) => void = () => undefined;
    const call = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          rejectText = resolve;
        }),
    );
    const client = { call } as unknown as EngineClient;
    useDatasources.setState({
      datasources: [view({ id: "kv", name: "kv", pluginId: REDIS_PLUGIN.id })],
      plugins: [REDIS_PLUGIN],
      connections: { kv: { status: "connected", error: null, serverVersion: null, serverBrand: null } },
    });
    vi.spyOn(useDatasources.getState(), "connect").mockResolvedValue(client);
    await useConsoles.getState().open("privacy", "kv", { connect: false, sql: SECRET_TEXT });
    const saving = bridgeConsoleFiles().write("kv", "console", SECRET_TEXT);
    await Promise.resolve();
    useConsoles.getState().setSql("privacy", "get /now-safe-but-undo-is-not");
    rejectText([REJECT]);
    await expect(saving).rejects.toThrow(PERSISTENCE_REJECTED);
    expect(host.write).not.toHaveBeenCalled();
    expect(useConsoles.getState().consoles.privacy).toMatchObject({ sql: "", privacyReset: 1 });
  });

  it.each([null, [], [{ admit: "execute" }]])(
    "givenUnavailableOrMalformedAdmission_whenSaving_thenFailsClosed %#",
    async (answer) => {
      const { client } = engine(answer);
      const scrub = vi.fn();
      await expect(
        checkConsolePersistence(SECRET_TEXT, {
          capabilities: ["commands"],
          client: () => Promise.resolve(client),
          scrub,
        }),
      ).rejects.toThrow(PERSISTENCE_UNCHECKED);
      expect(scrub).not.toHaveBeenCalled();
    },
  );

  it("givenOfflineOrUnknownLanguage_whenSaving_thenNoConnectionIsStartedAndTextIsNotWritten", async () => {
    const client = vi.fn(() => Promise.resolve(null));
    await expect(
      checkConsolePersistence(SECRET_TEXT, { capabilities: ["commands"], client, scrub: vi.fn() }),
    ).rejects.toThrow(PERSISTENCE_UNCHECKED);
    expect(client).toHaveBeenCalledOnce();
    client.mockClear();
    await expect(checkConsolePersistence(SECRET_TEXT, { capabilities: null, client, scrub: vi.fn() })).rejects.toThrow(
      PERSISTENCE_UNCHECKED,
    );
    expect(client).not.toHaveBeenCalled();
  });

  it("givenSqlOnlyLanguage_whenSaving_thenExistingOfflineSaveIsUnchanged", async () => {
    const client = vi.fn(() => Promise.resolve(null));
    await checkConsolePersistence("select 1", { capabilities: ["sql"], client, scrub: vi.fn() });
    expect(client).not.toHaveBeenCalled();
  });

  it("givenTrustedUsernameOnly_whenSaving_thenNoPromptAndNoScrub", async () => {
    const { client } = engine([
      {
        admit: "managed",
        intent: "credentials",
        safeLabel: "user add",
        arguments: { kind: "credentials", user: "bob", change: "createUser" },
      },
    ]);
    const scrub = vi.fn();
    await checkConsolePersistence("user add bob", {
      capabilities: ["commands"],
      client: () => Promise.resolve(client),
      scrub,
    });
    expect(scrub).not.toHaveBeenCalled();
  });

  it("givenPasswordInDocumentAndUndo_whenScrubbed_thenNeitherUndoRedoNorCachedHistoryRestoresIt", () => {
    const compartment = new Compartment();
    let state = EditorState.create({ doc: "get /a", extensions: [compartment.of(history())] });
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: SECRET_TEXT } }).state;
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: "get /b" } }).state;
    state = scrubEditorState(state, compartment);
    const target = { state, dispatch: vi.fn() };
    expect(undo(target)).toBe(false);
    expect(redo(target)).toBe(false);
    expect(state.doc.toString()).toBe("");
    expect(JSON.stringify(state.toJSON({ history: historyField }))).not.toContain("private-password");
    state = state.update({ changes: { from: 0, insert: "get /safe" } }).state;
    expect(
      undo({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      }),
    ).toBe(true);
    expect(state.doc.toString()).toBe("");
  });
});
