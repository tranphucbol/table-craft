import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DIAGRAM_STATE, type DiagramState, type NamespaceLayout } from "@table-craft/desktop/diagrams/state.js";
import type { DescribedCatalog } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { createCatalogStore } from "@table-craft/desktop/renderer/state/catalog.js";
import {
  createDiagramsStore,
  DIAGRAM_SAVE_DEBOUNCE_MS,
  DiagramsFailure,
  type DiagramPersistence,
} from "@table-craft/desktop/renderer/state/diagrams.js";
import { PG_NAMESPACES, PUBLIC_CATALOG, PUBLIC_PATH } from "./catalogFixtures.js";

const TAB = "diagram-pg";
const PUBLIC_TARGET = { datasourceId: "pg", path: PUBLIC_PATH, namespace: "public" };
const SAVED: DiagramState = { ...DEFAULT_DIAGRAM_STATE, inferKeys: false };

interface Persisted {
  readonly reads: string[];
  readonly saves: [string, DiagramState][];
  failNextSave: boolean;
}

function storeWith(options: { ephemeral?: boolean; read?: () => Promise<DiagramState> } = {}) {
  const client = {
    call(type: string): Promise<unknown> {
      if (type === "catalog.namespaces") return Promise.resolve(PG_NAMESPACES);
      if (type === "catalog.describe") return Promise.resolve(PUBLIC_CATALOG satisfies DescribedCatalog);
      return Promise.resolve([]);
    },
    fail: () => undefined,
    onEvent: () => () => undefined,
  } as unknown as EngineClient;
  const connect = () => Promise.resolve(client);
  const catalog = createCatalogStore({ connect });
  const persisted: Persisted = { reads: [], saves: [], failNextSave: false };
  const persistence: DiagramPersistence = {
    read(datasourceId) {
      persisted.reads.push(datasourceId);
      return options.read?.() ?? Promise.resolve(SAVED);
    },
    save(datasourceId, state) {
      if (persisted.failNextSave) {
        persisted.failNextSave = false;
        return Promise.reject(new DiagramsFailure("Could not save the diagrams.", "Check the disk."));
      }
      persisted.saves.push([datasourceId, state]);
      return Promise.resolve();
    },
  };
  const diagrams = createDiagramsStore({
    connect,
    catalog: () => catalog,
    persistence,
    isEphemeral: () => options.ephemeral === true,
  });
  return { diagrams, persisted };
}

function moved(x: number) {
  return (layout: NamespaceLayout): NamespaceLayout => ({
    ...layout,
    positions: { ...layout.positions, orders: { x, y: 0 } },
  });
}

describe("diagram store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("givenTwoDiagramsOfADatasource_whenOpened_thenItsStateIsReadOnce", async () => {
    const { diagrams, persisted } = storeWith();

    await Promise.all([
      diagrams.getState().open(TAB, PUBLIC_TARGET),
      diagrams.getState().open(`${TAB}-again`, PUBLIC_TARGET),
    ]);

    expect(persisted.reads).toEqual(["pg"]);
    expect(diagrams.getState().states["pg"]).toBe(SAVED);
  });

  it("givenSeveralChanges_whenTheDebounceEnds_thenOneSaveWithTheLastState", async () => {
    const { diagrams, persisted } = storeWith();
    await diagrams.getState().open(TAB, PUBLIC_TARGET);

    diagrams.getState().ensureLayout(TAB, ["orders", "customers"]);
    diagrams.getState().updateLayout(TAB, moved(10));
    diagrams.getState().updateLayout(TAB, moved(20));
    await vi.advanceTimersByTimeAsync(DIAGRAM_SAVE_DEBOUNCE_MS - 1);
    expect(persisted.saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(persisted.saves).toHaveLength(1);
    const [datasourceId, state] = persisted.saves[0] ?? [];
    expect(datasourceId).toBe("pg");
    expect(state?.layouts[JSON.stringify(PUBLIC_PATH)]?.positions["orders"]).toEqual({ x: 20, y: 0 });
  });

  it("givenEphemeralDatasource_whenChanged_thenNothingSaved", async () => {
    const { diagrams, persisted } = storeWith({ ephemeral: true });
    await diagrams.getState().open(TAB, PUBLIC_TARGET);

    diagrams.getState().updateState("pg", (state) => ({ ...state, inferKeys: true }));
    await vi.advanceTimersByTimeAsync(DIAGRAM_SAVE_DEBOUNCE_MS * 2);

    expect(persisted.saves).toEqual([]);
    expect(diagrams.getState().states["pg"]?.inferKeys).toBe(true);
  });

  it("givenSaveFails_whenNextSaveGoesThrough_thenFailureShownThenCleared", async () => {
    const { diagrams, persisted } = storeWith();
    await diagrams.getState().open(TAB, PUBLIC_TARGET);
    persisted.failNextSave = true;

    diagrams.getState().updateState("pg", (state) => ({ ...state, inferKeys: true }));
    await vi.advanceTimersByTimeAsync(DIAGRAM_SAVE_DEBOUNCE_MS);
    expect(diagrams.getState().failures["pg"]).toEqual({
      message: "Could not save the diagrams.",
      hint: "Check the disk.",
    });

    diagrams.getState().updateState("pg", (state) => ({ ...state, inferKeys: false }));
    await vi.advanceTimersByTimeAsync(DIAGRAM_SAVE_DEBOUNCE_MS);
    expect(diagrams.getState().failures["pg"]).toBeUndefined();
    expect(persisted.saves).toHaveLength(1);
  });

  it("givenUnreadableState_whenOpened_thenDefaultsAndTheFailureShown", async () => {
    const { diagrams } = storeWith({
      read: () => Promise.reject(new DiagramsFailure("Could not read the diagrams.", "Check the file.")),
    });

    await diagrams.getState().open(TAB, PUBLIC_TARGET);

    expect(diagrams.getState().states["pg"]).toBe(DEFAULT_DIAGRAM_STATE);
    expect(diagrams.getState().failures["pg"]?.message).toBe("Could not read the diagrams.");
  });

  it("givenDeletedDatasource_whenForgotten_thenPendingSaveDropped", async () => {
    const { diagrams, persisted } = storeWith();
    await diagrams.getState().open(TAB, PUBLIC_TARGET);

    diagrams.getState().updateState("pg", (state) => ({ ...state, inferKeys: true }));
    diagrams.getState().forget("pg");
    await vi.advanceTimersByTimeAsync(DIAGRAM_SAVE_DEBOUNCE_MS * 2);

    expect(persisted.saves).toEqual([]);
    expect(diagrams.getState().states["pg"]).toBeUndefined();
  });
});
