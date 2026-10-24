import { describe, expect, it } from "vitest";
import { DEFAULT_TESTS, parseRunArguments } from "./runner.js";

describe("headless runner arguments (runner.ts)", () => {
  it("givenOnlyReporterFlag_whenParsed_thenRunsDefaultTestsWithFlag", () => {
    expect(parseRunArguments(["--reporter=verbose"])).toEqual({
      databases: false,
      tests: [DEFAULT_TESTS],
      options: ["--reporter=verbose"],
    });
  });

  it("givenFilterAndFlag_whenParsed_thenFilterKeptAndFlagPassed", () => {
    expect(parseRunArguments(["test/e2e/routine.smoke.test.ts", "--bail=1"])).toEqual({
      databases: false,
      tests: ["test/e2e/routine.smoke.test.ts"],
      options: ["--bail=1"],
    });
  });

  it("givenDatabasesFlag_whenParsed_thenNotPassedToVitest", () => {
    const parsed = parseRunArguments(["--databases", "--reporter=dot"]);

    expect(parsed.databases).toBe(true);
    expect(parsed.options).toEqual(["--reporter=dot"]);
    expect(parsed.tests).toEqual([DEFAULT_TESTS]);
  });
});
