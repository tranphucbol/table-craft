import { describe, expect, it } from "vitest";
import { ConsoleFileError, CONSOLES_DIR, createConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import { memoryFiles } from "../support/memoryFiles.js";

const DIRECTORY = "/profile";
const DATASOURCE = "ds-1";

function consoles(initial: Record<string, string> = {}) {
  const files = memoryFiles(initial);
  return { files, consoles: createConsoleFiles({ directory: DIRECTORY, files }) };
}

describe("console files", () => {
  it("givenConsoleWritten_whenRead_thenSameTextUnderTheDatasourceDirectory", async () => {
    const { files, consoles: store } = consoles();

    await store.write(DATASOURCE, "console", "SELECT 1;");

    expect(await store.read(DATASOURCE, "console")).toBe("SELECT 1;");
    expect([...files.contents.keys()]).toEqual([`${DIRECTORY}/${CONSOLES_DIR}/${DATASOURCE}/console.sql`]);
  });

  it("givenNameWithSlash_whenWritten_thenRejected", async () => {
    const { files, consoles: store } = consoles();

    await expect(store.write(DATASOURCE, "../escape", "x")).rejects.toBeInstanceOf(ConsoleFileError);
    await expect(store.write("..", "console", "x")).rejects.toBeInstanceOf(ConsoleFileError);
    await expect(store.read(DATASOURCE, "a/b")).rejects.toBeInstanceOf(ConsoleFileError);
    expect(files.contents.size).toBe(0);
  });

  it("givenWriteKilledHalfway_whenRead_thenPreviousTextIsWhole", async () => {
    const { files, consoles: store } = consoles();
    await store.write(DATASOURCE, "console", "SELECT 1;");

    files.dieDuringNextWrite();
    await expect(store.write(DATASOURCE, "console", "SELECT 2;")).rejects.toThrow();

    expect(await store.read(DATASOURCE, "console")).toBe("SELECT 1;");
  });

  it("givenSavedConsoles_whenListed_thenSortedNamesWithoutExtensionOrStrays", async () => {
    const base = `${DIRECTORY}/${CONSOLES_DIR}/${DATASOURCE}`;
    const { consoles: store } = consoles({
      [`${base}/console_1.sql`]: "",
      [`${base}/console.sql`]: "",
      [`${base}/console.sql.tmp`]: "",
      [`${base}/notes.txt`]: "",
    });

    expect(await store.list(DATASOURCE)).toEqual(["console", "console_1"]);
    expect(await store.list("none")).toEqual([]);
  });

  it("givenScratchConsole_whenRenamed_thenFileMovesAndTakenNamesRefused", async () => {
    const { consoles: store } = consoles();
    await store.write(DATASOURCE, "console", "a");
    await store.write(DATASOURCE, "taken", "b");

    await store.rename(DATASOURCE, "console", "report");

    expect(await store.list(DATASOURCE)).toEqual(["report", "taken"]);
    expect(await store.read(DATASOURCE, "report")).toBe("a");
    await expect(store.rename(DATASOURCE, "report", "taken")).rejects.toThrow(
      'A console named "taken" already exists.',
    );
  });

  it("givenRenamedScratch_whenNameInvalid_thenRejectedWithPattern", async () => {
    const { consoles: store } = consoles();
    await store.write(DATASOURCE, "console", "a");

    for (const name of ["has space", "a/b", "..", "x".repeat(65)]) {
      const error = await store.rename(DATASOURCE, "console", name).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ConsoleFileError);
      expect((error as ConsoleFileError).hint).toBe("Use up to 64 letters, digits, underscores, dots or dashes.");
    }
    expect(await store.list(DATASOURCE)).toEqual(["console"]);
  });

  it("givenConsole_whenDeleted_thenGoneAndOthersKept", async () => {
    const { consoles: store } = consoles();
    await store.write(DATASOURCE, "console", "a");
    await store.write(DATASOURCE, "console_1", "b");

    await store.delete(DATASOURCE, "console");
    await store.delete(DATASOURCE, "never_saved");

    expect(await store.list(DATASOURCE)).toEqual(["console_1"]);
  });
});
