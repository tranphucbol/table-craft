import { describe, expect, it } from "vitest";
import { isRunningOn } from "@table-craft/desktop/renderer/state/consoles.js";

describe("running consoles", () => {
  it("givenConsoleRunningOnDatasource_whenAsked_thenDatasourceIsRunning", () => {
    const consoles = {
      a: { datasourceId: "pg", status: "ready" },
      b: { datasourceId: "pg", status: "running" },
    } as const;

    expect(isRunningOn(consoles, "pg")).toBe(true);
  });

  it("givenConsoleRunningOnAnotherDatasource_whenAsked_thenDatasourceIsNotRunning", () => {
    const consoles = {
      a: { datasourceId: "pg", status: "ready" },
      b: { datasourceId: "mysql", status: "running" },
    } as const;

    expect(isRunningOn(consoles, "pg")).toBe(false);
  });

  it("givenNoActiveDatasource_whenAsked_thenNothingIsRunning", () => {
    expect(isRunningOn({ a: { datasourceId: "pg", status: "running" } }, undefined)).toBe(false);
  });
});
