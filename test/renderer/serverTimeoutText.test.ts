import { describe, expect, it } from "vitest";
import { serverLimitText, serverTimeoutText } from "@table-craft/desktop/renderer/model/format.js";

const MYSQL = { setting: "max_execution_time", covers: "reads", counts: "statement" } as const;
const POSTGRES = { setting: "statement_timeout", covers: "all", counts: "statement" } as const;

describe("server timeout text", () => {
  it("givenNoTestYet_whenHint_thenAsksForATest", () => {
    expect(serverTimeoutText(undefined)).toBe("Test the connection to see what the database stops.");
  });

  it("givenServerWithoutLimit_whenHint_thenAppStillCancels", () => {
    expect(serverTimeoutText(null)).toBe("This server cannot stop statements by itself; the app still cancels them.");
  });

  it("givenReadsOnly_whenHint_thenSelects", () => {
    expect(serverTimeoutText(MYSQL)).toBe(
      "The database stops SELECTs at the limit, counting while rows wait to be read.",
    );
    expect(serverLimitText(MYSQL)).toBe("limit: max_execution_time, SELECT only");
  });

  it("givenAllStatements_whenHint_thenEveryStatement", () => {
    expect(serverTimeoutText(POSTGRES)).toBe(
      "The database stops every statement at the limit, counting while rows wait to be read.",
    );
    expect(serverTimeoutText({ ...POSTGRES, counts: "serverWork" })).toBe(
      "The database stops every statement that works past the limit.",
    );
    expect(serverLimitText(POSTGRES)).toBe("limit: statement_timeout");
  });
});
