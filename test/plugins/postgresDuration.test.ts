import { postgresDurationMs } from "@table-craft/plugin-postgres/timeout";
import { describe, expect, it } from "vitest";

describe("postgres statement_timeout", () => {
  it("givenSeconds_whenDurationMs_thenMs", () => {
    expect(postgresDurationMs("5s")).toBe(5_000);
    expect(postgresDurationMs("250ms")).toBe(250);
    expect(postgresDurationMs("1500")).toBe(1_500);
  });

  it("givenZero_whenDurationMs_thenZero", () => {
    expect(postgresDurationMs("0")).toBe(0);
    expect(postgresDurationMs("unreadable")).toBe(0);
  });

  it("givenMinutes_whenDurationMs_thenMs", () => {
    expect(postgresDurationMs("2min")).toBe(120_000);
    expect(postgresDurationMs("1h")).toBe(3_600_000);
  });
});
