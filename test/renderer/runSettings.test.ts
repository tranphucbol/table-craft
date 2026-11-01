import { describe, expect, it } from "vitest";
import {
  causedByRunSettings,
  CONSOLE_TIMEOUT_HINT,
  DEFAULT_RUN_SETTINGS,
  effectiveRunSettings,
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
    ).toBe("Page size 2,000 · Timeout 10 s");
    expect(runSettingsSummary({ rows: { kind: "all" }, timeout: { kind: "none" } })).toBe("All rows · No timeout");
  });

  it.each([
    ["custom page equal to Settings", { rows: { kind: "page", pageRows: 500 }, timeout: { kind: "default" } }, null],
    [
      "custom seconds equal to the default",
      { rows: { kind: "default" }, timeout: { kind: "seconds", seconds: 30 } },
      null,
    ],
    [
      "custom page that differs",
      { rows: { kind: "page", pageRows: 20 }, timeout: { kind: "default" } },
      "Page size 20",
    ],
    ["none over a default timeout", { rows: { kind: "default" }, timeout: { kind: "none" } }, "No timeout"],
  ] as const)("givenRunSettings_%s_whenEffective_thenSummary_%s", (_name, settings, summary) => {
    expect(runSettingsSummary(effectiveRunSettings(settings, { pageRows: 500, timeoutSeconds: 30 }))).toBe(summary);
  });

  it("givenNoDefaultTimeout_whenNone_thenNothingOverridden", () => {
    const settings = { rows: { kind: "default" }, timeout: { kind: "none" } } as const;
    expect(runSettingsSummary(effectiveRunSettings(settings, { pageRows: 500, timeoutSeconds: 0 }))).toBeNull();
  });

  it.each([
    [CONSOLE_TIMEOUT_HINT, true],
    ["Raise the data source's timeout.", false],
    [null, false],
  ])("givenHint_%s_thenCausedByRunSettings_%s", (hint, caused) => {
    expect(causedByRunSettings({ hint })).toBe(caused);
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
