import { ConflictError, PluginError } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";
import {
  CONFLICT_HINT,
  EngineFailure,
  helperRequestFailed,
  toEngineError,
} from "@table-craft/desktop/engine/failures.js";

describe("helper request failures", () => {
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
