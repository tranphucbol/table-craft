import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_SETTINGS,
  fetchesAll,
  isDefaultRunSettings,
  pagingWith,
  runSettingsSummary,
  runTimeoutError,
  timeoutWith,
} from "@table-craft/desktop/renderer/model/runSettings.js";

const BASE = { pageRows: 500, fetchAllCap: 100_000 };

describe("run settings", () => {
  it.each([
    ["default", { kind: "default" } as const, BASE],
    ["custom page", { kind: "page", pageRows: 2000 } as const, { pageRows: 2000, fetchAllCap: 100_000 }],
    ["all", { kind: "all" } as const, BASE],
  ])("givenRows_%s_whenPaging_thenSent", (_name, rows, sent) => {
    expect(pagingWith(BASE, rows)).toEqual(sent);
  });

  it("givenCustomPageAboveTheCap_whenPaging_thenCapRaisedToThePage", () => {
    expect(pagingWith({ pageRows: 500, fetchAllCap: 1000 }, { kind: "page", pageRows: 2000 })).toEqual({
      pageRows: 2000,
      fetchAllCap: 2000,
    });
  });

  it.each([
    [{ kind: "default" } as const, 30, 30],
    [{ kind: "seconds", seconds: 5 } as const, 30, 5],
    [{ kind: "none" } as const, 30, 0],
    [{ kind: "seconds", seconds: 5 } as const, 0, 5],
  ])("givenTimeout_%o_overBase_%i_thenSeconds_%i", (timeout, base, seconds) => {
    expect(timeoutWith(base, timeout)).toBe(seconds);
  });

  it("givenDefaults_thenNothingSummarised", () => {
    expect(isDefaultRunSettings(DEFAULT_RUN_SETTINGS)).toBe(true);
    expect(fetchesAll(DEFAULT_RUN_SETTINGS)).toBe(false);
    expect(runSettingsSummary(DEFAULT_RUN_SETTINGS)).toBeNull();
  });

  it("givenOverrides_thenSummaryNamesThem", () => {
    expect(
      runSettingsSummary({ rows: { kind: "page", pageRows: 2000 }, timeout: { kind: "seconds", seconds: 10 } }),
    ).toBe("2,000 rows a page · Timeout 10 s");
    expect(runSettingsSummary({ rows: { kind: "all" }, timeout: { kind: "none" } })).toBe("All rows · No timeout");
  });

  it.each([
    [0, false],
    [1, true],
    [86_400, true],
    [86_401, false],
    [1.5, false],
  ])("givenTimeout_%d_thenValid_%s", (seconds, valid) => {
    expect(runTimeoutError(seconds) === null).toBe(valid);
  });
});
