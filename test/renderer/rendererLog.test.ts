import { describe, expect, it } from "vitest";
import type { LogRecord } from "@table-craft/desktop/log/record.js";
import { createRendererLog, LOG_BATCH_RECORDS, LOG_FLUSH_MS } from "@table-craft/desktop/renderer/log/log.js";
import { fieldsText, LOG_ROW_FIELD_CHARS, scopeOptions } from "@table-craft/desktop/renderer/model/logRow.js";
import {
  AGENT_RECORDS,
  ALL_RECORDS,
  filterFor,
  isAllRecords,
  matches,
  prepended,
  scopesOf,
} from "@table-craft/desktop/renderer/state/logView.js";
import { AGENT_LOG_SCOPE } from "@table-craft/desktop/settings/mcp.js";

function harness() {
  const sent: (readonly LogRecord[])[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const log = createRendererLog({
    send: (records) => sent.push(records),
    setTimeout: (run, ms) => timers.push({ run, ms }),
    clearTimeout: () => undefined,
    now: () => new Date("2026-10-23T10:00:00.000Z"),
  });
  return { sent, timers, log };
}

function record(fields: Partial<LogRecord> & Record<string, unknown>): LogRecord {
  return { ts: "2026-10-23T10:00:00.000Z", level: "info", process: "main", scope: "app", msg: "m", ...fields };
}

describe("renderer log", () => {
  it("givenRecords_whenTimerFires_thenOneBatchSent", () => {
    const { sent, timers, log } = harness();
    const logger = log.logger("grid");

    logger.info("first");
    logger.warn("second", { rows: 3 });
    expect(sent).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(LOG_FLUSH_MS);
    timers[0]?.run();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.map((entry) => [entry.level, entry.scope, entry.msg])).toEqual([
      ["info", "grid", "first"],
      ["warn", "grid", "second"],
    ]);
    expect(sent[0]?.[1]?.["rows"]).toBe(3);
  });

  it("givenFullBatch_whenAnotherRecordQueued_thenSentWithoutWaiting", () => {
    const { sent, log } = harness();
    const logger = log.logger("engine");

    for (let index = 0; index < LOG_BATCH_RECORDS; index += 1) logger.debug("tick", { index });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(LOG_BATCH_RECORDS);
  });

  it("givenThrownError_whenLogged_thenSerialisedWithCause", () => {
    const { sent, log } = harness();
    log.logger("window").error("uncaught error", { err: new Error("outer", { cause: new Error("inner") }) });
    log.flush();

    expect(sent[0]?.[0]?.err?.message).toBe("outer");
    expect(sent[0]?.[0]?.err?.cause?.message).toBe("inner");
  });
});

describe("log view", () => {
  it("givenLevelFilter_whenMatched_thenThatLevelAndMoreSevereShown", () => {
    const warnings = { ...ALL_RECORDS, level: "warn" as const };

    expect(matches(record({ level: "error" }), warnings)).toBe(true);
    expect(matches(record({ level: "warn" }), warnings)).toBe(true);
    expect(matches(record({ level: "info" }), warnings)).toBe(false);
  });

  it("givenQuotedDatabaseMessage_whenSearchedByIt_thenMatched", () => {
    const failure = record({ level: "warn", msg: "statement failed", error: 'relation "missing" does not exist' });

    expect(matches(failure, filterFor({ requestId: null, message: 'relation "missing" does not exist' }))).toBe(true);
    expect(matches(failure, filterFor({ requestId: null, message: "something else" }))).toBe(false);
  });

  it("givenRequestTarget_whenMatched_thenOnlyThatRequest", () => {
    const filter = filterFor({ requestId: 7, message: "ignored when the request is known" });

    expect(matches(record({ requestId: 7 }), filter)).toBe(true);
    expect(matches(record({ requestId: 8 }), filter)).toBe(false);
    expect(isAllRecords(filter)).toBe(false);
    expect(isAllRecords({ ...ALL_RECORDS })).toBe(true);
  });

  it("givenAppendedBatch_whenPrepended_thenNewestFirst", () => {
    const older = [record({ msg: "b" }), record({ msg: "a" })];
    const next = prepended(older, [record({ msg: "c" }), record({ msg: "d", scope: "engine" })]);

    expect(next.map((entry) => entry.msg)).toEqual(["d", "c", "b", "a"]);
    expect(scopesOf(next)).toEqual(["app", "engine"]);
  });
});

describe("log view, agent records", () => {
  it("givenAgentFilter_whenMatched_thenOnlyAgentRecordsAtInfoAndUp", () => {
    const call = record({ process: "mcp", scope: AGENT_LOG_SCOPE, msg: "agent call" });
    const host = record({ process: "mcp", scope: "mcp", msg: "listening" });
    const debug = record({ process: "mcp", scope: AGENT_LOG_SCOPE, level: "debug" });

    expect([call, host, debug].filter((entry) => matches(entry, AGENT_RECORDS))).toEqual([call]);
  });

  it("givenLongField_whenRowText_thenCutWithEllipsisOnOneLine", () => {
    const sql = `SELECT\n  ${"a".repeat(LOG_ROW_FIELD_CHARS * 2)}`;

    const text = fieldsText(record({ tool: "run_query", target: sql }));

    expect(text.startsWith("tool=run_query target=SELECT a")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThan(LOG_ROW_FIELD_CHARS + 40);
  });

  it("givenChosenScopeWithoutRecords_whenOptionsBuilt_thenItIsListed", () => {
    expect(scopeOptions(["app", "engine"], AGENT_LOG_SCOPE)).toEqual(["agent", "app", "engine"]);
    expect(scopeOptions(["app"], "")).toEqual(["app"]);
    expect(scopeOptions(["agent", "app"], AGENT_LOG_SCOPE)).toEqual(["agent", "app"]);
  });
});
