import { ConflictError, PluginError } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";
import {
  CONFLICT_HINT,
  EngineFailure,
  helperRequestFailed,
  toEngineError,
} from "@table-craft/desktop/engine/failures.js";

describe("helper request failures", () => {
  const maxBytes = 1024 * 1024;
  const revision = { createRevision: "1", modRevision: "2", version: "2", lease: "0" };
  function conflict(value: { text: string; hex: string | null }) {
    return toEngineError(
      helperRequestFailed(
        new ConflictError("k", "changed", {
          current: { database: 0, key: { text: "k", hex: null }, value, revision, snapshotRevision: "3" },
        }),
      ),
    );
  }

  it.each([300000, maxBytes - 1])("givenBinarySnapshotOf%dBytes_whenMapped_thenPreserveAtomicBaseline", (size) => {
    const value = { text: "\\xff".repeat(size), hex: "ff".repeat(size) };
    expect(conflict(value).keyConflict).toEqual({
      database: 0,
      key: { text: "k", hex: null },
      value,
      revision,
      snapshotRevision: "3",
    });
  });

  it("givenUtf8SnapshotAtDecodedLimit_whenMapped_thenPreserved", () => {
    expect(conflict({ text: "a".repeat(maxBytes - 1), hex: null }).keyConflict).toBeDefined();
  });

  it.each([
    { text: "a".repeat(maxBytes), hex: null },
    { text: "é".repeat(maxBytes / 2), hex: null },
    { text: "\\xff".repeat(maxBytes), hex: "ff".repeat(maxBytes) },
    { text: "x".repeat(maxBytes * 4 + 1), hex: "ff" },
    { text: "binary", hex: "ff".repeat(maxBytes + 1) },
    { text: "binary", hex: "fg" },
    { text: "binary", hex: "f" },
    { text: "\ud800", hex: null },
  ])("givenOversizedOrMalformedSnapshot_whenMapped_thenDropUntrustedBaseline %#", (value) => {
    expect(conflict(value)).toMatchObject({ code: "conflict", hint: CONFLICT_HINT });
    expect(conflict(value).keyConflict).toBeUndefined();
  });

  it("givenConflict_whenMapped_thenConflictCodeWithReloadHint", () => {
    const error = toEngineError(helperRequestFailed(new ConflictError("user:42", 'field "name" is now Zed')));

    expect(error.code).toBe("conflict");
    expect(error.message).toContain('field "name" is now Zed');
    expect(error.hint).toBe(CONFLICT_HINT);
  });

  it("givenPluginRefusal_whenMapped_thenStatementFailedNotABug", () => {
    const error = toEngineError(helperRequestFailed(new PluginError("statementFailed", "to already exists.")));

    expect(error).toMatchObject({ code: "statementFailed", message: "to already exists." });
  });

  it("givenNonPluginError_whenMapped_thenLeftAsTheBugItIs", () => {
    const cause = new TypeError("undefined is not a function");

    expect(helperRequestFailed(cause)).toBe(cause);
    expect(helperRequestFailed(cause)).not.toBeInstanceOf(EngineFailure);
  });
});
