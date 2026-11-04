import { join } from "node:path";
import { loadPlugins } from "@table-craft/core";
import { serviceProblems } from "@table-craft/plugin-api";
import sqlite from "@table-craft/plugin-sqlite";
import { describe, expect, it } from "vitest";
import { languageFor } from "../support/declaredServices.js";

const FROZEN_DIRECTORY = join(import.meta.dirname, "..", "support", "frozen-plugins", "sqlite-2.0.0");
const WITHOUT_SAVEPOINTS = sqlite.capabilities.filter((capability) => capability !== "savepoints");

describe("savepoints capability", () => {
  it("givenLanguageWithUndeclaredSavepoints_whenServiceProblems_thenUndeclared", () => {
    const problems = serviceProblems(WITHOUT_SAVEPOINTS, sqlite);

    expect(problems.map((problem) => problem.message)).toEqual([
      "has the savepoints service on its language but does not declare savepoints",
    ]);
  });

  it("givenDeclaredSavepointsWithoutService_whenServiceProblems_thenMissing", () => {
    const language = languageFor(sqlite.language, WITHOUT_SAVEPOINTS);

    const problems = serviceProblems(sqlite.capabilities, { language });

    expect(problems).toEqual([
      expect.objectContaining({ kind: "missing", capability: "savepoints", where: "language" }),
    ]);
  });

  it("givenFrozen200Sqlite_whenLoaded_thenAvailableWithoutSavepoints", async () => {
    const [loaded] = await loadPlugins([{ directory: FROZEN_DIRECTORY }]);

    expect(loaded?.status).toBe("loaded");
    expect(loaded?.status === "loaded" && loaded.plugin.capabilities).not.toContain("savepoints");
    expect(loaded?.status === "loaded" && loaded.plugin.language?.services.savepoints).toBeUndefined();
  });
});
