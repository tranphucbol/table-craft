import { describe, expect, it } from "vitest";
import { applyAgentEdit } from "@table-craft/desktop/renderer/model/agentEdits.js";

const TEXT = "SELECT id FROM orders\nWHERE status = 'open';";

function replace(...edits: [string, string][]) {
  return { kind: "replace" as const, edits: edits.map(([oldText, newText]) => ({ oldText, newText })) };
}

describe("agent edits", () => {
  it("givenOneMatch_whenEdited_thenReplacedAndCaretAfterIt", () => {
    const outcome = applyAgentEdit(TEXT, 0, replace(["SELECT id", "SELECT id, total"]), null);

    expect(outcome).toMatchObject({
      ok: true,
      text: "SELECT id, total FROM orders\nWHERE status = 'open';",
      selection: { from: 16, to: 16 },
    });
  });

  it("givenTwoEdits_whenSecondMissing_thenNothingChanged", () => {
    const outcome = applyAgentEdit(TEXT, 0, replace(["id", "total"], ["missing", "x"]), null);

    expect(outcome).toEqual({ ok: false, reason: "notFound", index: 1, matches: 0 });
  });

  it("givenAmbiguousOldText_whenEdited_thenRefusedWithMatchCount", () => {
    const outcome = applyAgentEdit("a = 1 OR a = 1", 0, replace(["a = 1", "a = 2"]), null);

    expect(outcome).toEqual({ ok: false, reason: "ambiguous", index: 0, matches: 2 });
  });

  it("givenEditsAppliedInOrder_whenLaterEditMatchesEarlierInsert_thenApplied", () => {
    const outcome = applyAgentEdit(TEXT, 0, replace(["SELECT id", "SELECT id, total"], [", total", ", amount"]), null);

    expect(outcome).toMatchObject({ ok: true, text: "SELECT id, amount FROM orders\nWHERE status = 'open';" });
  });

  it("givenStaleRevision_whenWholeReplace_thenStale", () => {
    expect(applyAgentEdit(TEXT, 3, { kind: "whole", text: "SELECT 1", revision: 2 }, null)).toEqual({
      ok: false,
      reason: "stale",
      index: null,
      matches: 0,
    });
    expect(applyAgentEdit(TEXT, 3, { kind: "whole", text: "SELECT 1", revision: 3 }, null)).toMatchObject({
      ok: true,
      text: "SELECT 1",
      selection: { from: 8, to: 8 },
    });
  });

  it("givenSelect_whenEdited_thenSelectionCoversIt", () => {
    const outcome = applyAgentEdit(TEXT, 0, replace(["'open'", "'paid'"]), "'paid'");
    const from = TEXT.indexOf("'open'");

    expect(outcome).toMatchObject({ ok: true, selection: { from, to: from + 6 } });
    expect(applyAgentEdit(TEXT, 0, replace(["'open'", "'paid'"]), "nowhere")).toMatchObject({
      ok: false,
      reason: "selectNotFound",
      matches: 0,
    });
  });

  it("givenSeveralEdits_whenApplied_thenOneChangeSpansThem", () => {
    const outcome = applyAgentEdit(TEXT, 0, replace(["SELECT id", "SELECT *"], ["'open'", "'paid'"]), null);

    expect(outcome).toMatchObject({
      ok: true,
      change: { from: 7, to: TEXT.indexOf("open") + 4, insert: "* FROM orders\nWHERE status = 'paid" },
    });
  });
});
