import { describe, expect, it, vi } from "vitest";
import {
  consoleNameFrom,
  createAutosave,
  firstFreeName,
  type ConsoleFileAccess,
  type Timers,
} from "@table-craft/desktop/renderer/state/consoleFiles.js";

/** Timers that fire only when the test says so. */
function manualTimers(): Timers & { readonly fire: () => void } {
  const scheduled = new Map<number, () => void>();
  let next = 0;
  return {
    set: (run) => {
      scheduled.set(++next, run);
      return next;
    },
    clear: (timer) => scheduled.delete(timer as number),
    fire: () => {
      const runs = [...scheduled.values()];
      scheduled.clear();
      for (const run of runs) run();
    },
  };
}

function memoryFiles(): ConsoleFileAccess & { readonly saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    list: (datasourceId) =>
      Promise.resolve(
        [...saved.keys()].filter((key) => key.startsWith(`${datasourceId}/`)).map((key) => key.split("/")[1] ?? ""),
      ),
    read: (datasourceId, name) => Promise.resolve(saved.get(`${datasourceId}/${name}`) ?? null),
    write: (datasourceId, name, text) => {
      saved.set(`${datasourceId}/${name}`, text);
      return Promise.resolve();
    },
    remove: (datasourceId, name) => {
      saved.delete(`${datasourceId}/${name}`);
      return Promise.resolve();
    },
  };
}

function autosaveHarness() {
  const files = memoryFiles();
  const timers = manualTimers();
  const onError = vi.fn();
  const autosave = createAutosave({ files, timers, onError });
  return { files, timers, onError, autosave };
}

describe("console files", () => {
  it("givenUsedNames_whenNewConsole_thenFirstFreeName", () => {
    expect(firstFreeName([])).toBe("console");
    expect(firstFreeName(["console", "console_1", "console_3"])).toBe("console_2");
    expect(firstFreeName(["console_1"])).toBe("console");
  });

  it("givenTitleHint_whenOpened_thenNamedFromHint", () => {
    expect(consoleNameFrom("Top customers by revenue")).toBe("Top_customers_by_revenue");
    expect(consoleNameFrom("..")).toBeNull();
    expect(consoleNameFrom("x".repeat(80))).toHaveLength(58);
  });

  it("givenTakenHint_whenOpened_thenSuffixed", () => {
    expect(firstFreeName(["orders"], "orders")).toBe("orders_1");
    expect(firstFreeName(["console"], "orders")).toBe("orders");
  });

  it("givenTyping_whenItPauses_thenOnlyTheLastTextIsWritten", () => {
    const { files, timers, autosave } = autosaveHarness();

    autosave.changed("pg", "console", "SEL");
    autosave.changed("pg", "console", "SELECT 1");
    expect(files.saved.size).toBe(0);
    timers.fire();

    expect(files.saved.get("pg/console")).toBe("SELECT 1");
  });

  it("givenEmptyConsole_whenClosed_thenFileDeleted", async () => {
    const { files, autosave } = autosaveHarness();
    files.saved.set("pg/console", "SELECT 1");

    await autosave.closed("pg", "console", "  \n");

    expect(files.saved.has("pg/console")).toBe(false);
  });

  it("givenPendingChange_whenClosed_thenWrittenNowAndTimerDropped", async () => {
    const { files, timers, autosave } = autosaveHarness();
    autosave.changed("pg", "console", "SELECT 1");

    await autosave.closed("pg", "console", "SELECT 2");
    timers.fire();

    expect(files.saved.get("pg/console")).toBe("SELECT 2");
  });

  it("givenPendingChanges_whenFlushed_thenAllWrittenBeforeTheTimers", async () => {
    const { files, autosave } = autosaveHarness();
    autosave.changed("pg", "console", "SELECT 1");
    autosave.changed("lite", "console_1", "SELECT 2");

    await autosave.flush();

    expect(Object.fromEntries(files.saved)).toEqual({ "pg/console": "SELECT 1", "lite/console_1": "SELECT 2" });
  });

  it("givenDatasourceGone_whenDiscarded_thenItsPendingWritesNeverHappen", () => {
    const { files, timers, autosave } = autosaveHarness();
    autosave.changed("pg", "console", "SELECT 1");
    autosave.changed("lite", "console", "SELECT 2");

    autosave.discard("pg");
    timers.fire();

    expect(Object.fromEntries(files.saved)).toEqual({ "lite/console": "SELECT 2" });
  });

  it("givenWriteFails_whenSaved_thenErrorReported", async () => {
    const { files, onError, autosave } = autosaveHarness();
    const failure = new Error("disk full");
    vi.spyOn(files, "write").mockRejectedValue(failure);

    await autosave.closed("pg", "console", "SELECT 1");

    expect(onError).toHaveBeenCalledWith(failure);
  });
});
