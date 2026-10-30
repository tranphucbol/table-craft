import { describe, expect, it } from "vitest";
import { activityOf } from "@table-craft/desktop/renderer/model/activity.js";

const READY = { status: "ready", transactionOpen: false } as const;
const RUNNING = { status: "running", transactionOpen: false } as const;
const STARTED_AT = 1_000;
const EARLIER = 500;

describe("activity", () => {
  it("givenNoSession_whenRead_thenIdle", () => {
    expect(activityOf(undefined, [])).toEqual({ kind: "idle" });
  });

  it("givenReadyAutoConsole_whenRead_thenIdle", () => {
    expect(activityOf(READY, [{ outcome: "success", startedAt: STARTED_AT }])).toEqual({ kind: "idle" });
  });

  it("givenRunningConsole_whenRead_thenRunningFromNewestRunningExecution", () => {
    const executions = [
      { outcome: "running", startedAt: STARTED_AT },
      { outcome: "success", startedAt: EARLIER },
    ] as const;
    expect(activityOf(RUNNING, executions)).toEqual({ kind: "running", startedAt: STARTED_AT });
  });

  it("givenRunningWithoutExecution_whenRead_thenRunningWithoutStart", () => {
    expect(activityOf(RUNNING, [{ outcome: "success", startedAt: EARLIER }])).toEqual({
      kind: "running",
      startedAt: null,
    });
  });

  it("givenOpenTransaction_whenRead_thenTransaction", () => {
    expect(activityOf({ ...READY, transactionOpen: true }, [])).toEqual({ kind: "transaction" });
  });

  it("givenRunningInOpenTransaction_whenRead_thenRunningWins", () => {
    const executions = [{ outcome: "running", startedAt: STARTED_AT }] as const;
    expect(activityOf({ ...RUNNING, transactionOpen: true }, executions)).toEqual({
      kind: "running",
      startedAt: STARTED_AT,
    });
  });
});
