import { describe, expect, it } from "vitest";
import { FIND_HISTORY_LIMIT, recorded } from "@table-craft/desktop/renderer/console/find/findHistory.js";

describe("console find history", () => {
  it("givenRepeatedQuery_whenRecorded_thenMovesToTopOnce", () => {
    expect(recorded(["b", "a", "c"], "a")).toEqual(["a", "b", "c"]);
  });

  it("givenQueryAlreadyNewest_whenRecorded_thenListUnchanged", () => {
    const list = ["a", "b"];

    expect(recorded(list, "a")).toBe(list);
  });

  it("givenEmptyQuery_whenRecorded_thenNothingAdded", () => {
    expect(recorded(["a"], "")).toEqual(["a"]);
  });

  it("givenMoreThanLimit_whenRecorded_thenOldestDropped", () => {
    const full = Array.from({ length: FIND_HISTORY_LIMIT }, (_, index) => `q${String(index)}`);

    const next = recorded(full, "new");

    expect(next).toHaveLength(FIND_HISTORY_LIMIT);
    expect(next[0]).toBe("new");
    expect(next).not.toContain(`q${String(FIND_HISTORY_LIMIT - 1)}`);
  });
});
