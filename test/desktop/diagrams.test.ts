import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DIAGRAM_STATE, virtualKeyId, type DiagramState } from "@table-craft/desktop/diagrams/state.js";
import { createDiagramsService, DIAGRAMS_FILE, DiagramsError } from "@table-craft/desktop/main/diagrams.js";
import { registerIpc, type IpcOptions } from "@table-craft/desktop/main/ipc.js";
import { INVOKE_CHANNELS } from "@table-craft/desktop/preload/bridge.js";
import { memoryFiles } from "../support/memoryFiles.js";

const DIRECTORY = "/profile";
const PATH = `${DIRECTORY}/${DIAGRAMS_FILE}`;
const NOW = 1_700_000_000_000;
const PUBLIC = JSON.stringify(["public"]);
const NOTE_KEY = {
  path: ["public"],
  relation: "notes",
  columns: ["person_id"],
  target: { path: ["public"], relation: "people", columns: ["id"] },
};

function stateWith(x: number): DiagramState {
  return {
    inferKeys: false,
    hiddenKeys: ["orders(customer_id)->customers(id)"],
    virtualKeys: [{ id: virtualKeyId(NOTE_KEY), ...NOTE_KEY }],
    layouts: { [PUBLIC]: { positions: { notes: { x, y: 40 } }, hiddenTables: ["audit"], columns: "keys" } },
  };
}

function setup(initial: Record<string, string> = {}) {
  const files = memoryFiles(initial);
  const warned = vi.fn();
  const service = createDiagramsService({ directory: DIRECTORY, files, now: () => NOW, onWarning: warned });
  return { files, warned, service };
}

function saved(files: ReturnType<typeof memoryFiles>): unknown {
  return JSON.parse(files.contents.get(PATH) ?? "null");
}

describe("diagrams file", () => {
  it("givenNoFile_whenGet_thenDefaultState", async () => {
    const { files, service } = setup();

    expect(await service.get("pg")).toEqual(DEFAULT_DIAGRAM_STATE);
    expect(files.contents.has(PATH)).toBe(false);
  });

  it("givenSavedState_whenReadByANewService_thenSameState", async () => {
    const { files, service } = setup();
    await service.save("pg", stateWith(10));

    const reopened = createDiagramsService({ directory: DIRECTORY, files });

    expect(await reopened.get("pg")).toEqual(stateWith(10));
    expect(await reopened.get("other")).toEqual(DEFAULT_DIAGRAM_STATE);
    expect(saved(files)).toEqual({ version: 1, datasources: { pg: stateWith(10) } });
  });

  it.each([
    "{ not json",
    JSON.stringify({ version: 2, datasources: {} }),
    JSON.stringify({ version: 1, datasources: { pg: { ...stateWith(1), inferKeys: "yes" } } }),
  ])("givenCorruptFile_whenGet_thenRenamedAndDefaults (%s)", async (text) => {
    const { files, warned, service } = setup({ [PATH]: text });

    expect(await service.get("pg")).toEqual(DEFAULT_DIAGRAM_STATE);
    expect(await service.get("pg")).toEqual(DEFAULT_DIAGRAM_STATE);

    expect(files.contents.has(PATH)).toBe(false);
    expect(files.contents.get(`${PATH}.corrupt-${String(NOW)}`)).toBe(text);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]?.[0]).toContain(`${PATH}.corrupt-${String(NOW)}`);
  });

  it("givenConcurrentSaves_whenFlushed_thenLastWins", async () => {
    const { files, service } = setup();

    await Promise.all([1, 2, 3].map((x) => service.save("pg", stateWith(x))));

    expect(await service.get("pg")).toEqual(stateWith(3));
    expect(saved(files)).toEqual({ version: 1, datasources: { pg: stateWith(3) } });
  });

  it("givenDeletedDatasource_whenDeleted_thenEntryRemoved", async () => {
    const { files, service } = setup();
    await service.save("pg", stateWith(1));
    await service.save("lite", stateWith(2));

    await service.delete(["pg", "never-saved"]);

    expect(await service.get("pg")).toEqual(DEFAULT_DIAGRAM_STATE);
    expect(saved(files)).toEqual({ version: 1, datasources: { lite: stateWith(2) } });
  });

  it("givenWriteDiesHalfway_whenSaved_thenTypedFailureAndPreviousFileKept", async () => {
    const { files, service } = setup();
    await service.save("pg", stateWith(1));
    files.dieDuringNextWrite();

    await expect(service.save("pg", stateWith(2))).rejects.toBeInstanceOf(DiagramsError);

    expect(saved(files)).toEqual({ version: 1, datasources: { pg: stateWith(1) } });
    expect(await service.get("pg")).toEqual(stateWith(1));
  });

  it("givenDiagramIpc_whenStateInvalidOrDatasourceDeleted_thenRejectedOrForgotten", async () => {
    const handlers = new Map<string, (event: { sender: string }, ...args: unknown[]) => unknown>();
    const { service } = setup();
    let ids = ["pg", "lite"];
    const datasources = {
      list: () => ({ datasources: ids.map((id) => ({ id })) }),
      delete: vi.fn(() => {
        ids = ["lite"];
        return Promise.resolve();
      }),
    };
    const log = { warn: vi.fn(), error: vi.fn() };
    registerIpc({ handle: (channel, handler) => void handlers.set(channel, handler) }, {
      diagrams: service,
      service: datasources,
      log,
    } as unknown as IpcOptions<string>);
    function invoke(channel: string, payload?: unknown) {
      return handlers.get(channel)?.({ sender: "window" }, payload);
    }

    expect(
      await invoke(INVOKE_CHANNELS.saveDiagrams, { datasourceId: "pg", state: { ...stateWith(1), extra: 1 } }),
    ).toMatchObject({ ok: false });
    expect(await invoke(INVOKE_CHANNELS.saveDiagrams, { datasourceId: "pg", state: stateWith(1) })).toEqual({
      ok: true,
      value: null,
    });
    expect(await invoke(INVOKE_CHANNELS.readDiagrams, { datasourceId: "pg" })).toEqual({
      ok: true,
      value: stateWith(1),
    });

    await invoke(INVOKE_CHANNELS.deleteDatasources, { ids: ["pg"], folders: [] });

    expect(await service.get("pg")).toEqual(DEFAULT_DIAGRAM_STATE);
  });
});
