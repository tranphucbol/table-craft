import { describe, expect, it } from "vitest";
import { ACTIVITY_TARGET_CHARS, createActivity, createRuns } from "@table-craft/desktop/mcp/activity.js";
import { ADMISSION_REFUSALS, createClientGate } from "@table-craft/desktop/mcp/clients.js";
import { byWindow, createConsoleOwners } from "@table-craft/desktop/mcp/consoleOwners.js";

const NOW = 1_000;
const TIMEOUT_MS = 60_000;

function manualTimers() {
  const timers: (() => void)[] = [];
  return {
    setTimer: (run: () => void) => timers.push(run),
    clearTimer: () => undefined,
    fire: () => timers.splice(0).forEach((run) => run()),
  };
}

function gate(timers = manualTimers()) {
  let changes = 0;
  const created = createClientGate({
    onChange: () => (changes += 1),
    now: () => NOW,
    timeoutMs: TIMEOUT_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { gate: created, timers, changes: () => changes };
}

describe("client gate", () => {
  it("givenKnownClients_whenAdmitted_thenAnsweredAtOnce", async () => {
    const { gate: clients } = gate();
    clients.setKnown([
      { name: "Claude Code", allowed: true },
      { name: "Cursor", allowed: false },
    ]);
    expect(await clients.admit("Claude Code", "1.0")).toBe("allowed");
    expect(await clients.admit("Cursor", "1.0")).toBe("blocked");
    expect(clients.pending()).toEqual([]);
  });

  it("givenNoWindow_whenUnknownClientAdmitted_thenRefusedWithoutWaiting", async () => {
    const { gate: clients } = gate();
    expect(await clients.admit("OpenCode", "1.0")).toBe("noWindow");
  });

  it("givenUnknownClient_whenUserAllows_thenEveryWaitingCallAdmitted", async () => {
    const { gate: clients, changes } = gate();
    clients.setWindows(true);
    const first = clients.admit("OpenCode", "1.2");
    const second = clients.admit("OpenCode", "1.2");
    expect(clients.pending()).toEqual([{ name: "OpenCode", version: "1.2", since: NOW, deadline: NOW + TIMEOUT_MS }]);
    clients.setKnown([{ name: "OpenCode", allowed: true }]);
    expect(await Promise.all([first, second])).toEqual(["allowed", "allowed"]);
    expect(clients.pending()).toEqual([]);
    expect(changes()).toBe(2);
  });

  it("givenUnknownClient_whenNobodyAnswers_thenTimedOut", async () => {
    const { gate: clients, timers } = gate();
    clients.setWindows(true);
    const admission = clients.admit("OpenCode", "1.2");
    timers.fire();
    expect(await admission).toBe("timedOut");
    expect(ADMISSION_REFUSALS.timedOut("OpenCode")).toContain("allow it from the MCP chip");
  });

  it("givenUnknownClientWaiting_whenLastWindowCloses_thenRefused", async () => {
    const { gate: clients } = gate();
    clients.setWindows(true);
    const admission = clients.admit("OpenCode", "1.2");
    clients.setWindows(false);
    expect(await admission).toBe("noWindow");
  });
});

describe("agent activity and runs", () => {
  const CALL = {
    tool: "run_query",
    datasourceId: "shop",
    at: NOW,
    durationMs: 4,
    approvalWaitMs: 0,
    outcome: "ok",
    clientId: "mcp-1",
    clientName: "Claude Code",
    rowCount: 1,
    message: null,
  } as const;

  it("givenMoreCallsThanLimit_whenAdded_thenNewestFirstAndOldestDropped", () => {
    const activity = createActivity(() => undefined, 2);
    activity.add({ ...CALL, target: "SELECT 1" });
    activity.add({ ...CALL, target: "SELECT 2" });
    activity.add({ ...CALL, target: "SELECT 3" });
    expect(activity.list().map((entry) => [entry.id, entry.target])).toEqual([
      [3, "SELECT 3"],
      [2, "SELECT 2"],
    ]);
  });

  it("givenLongTarget_whenAdded_thenCutInListAndKeptWhole", () => {
    const activity = createActivity(() => undefined);
    const sql = "x".repeat(ACTIVITY_TARGET_CHARS + 10);
    activity.add({ ...CALL, target: sql });
    expect(activity.list()[0]?.target).toHaveLength(ACTIVITY_TARGET_CHARS + 1);
    expect(activity.fullTarget(1)).toBe(sql);
  });

  it("givenDroppedCall_whenFullTargetAsked_thenNull", () => {
    const activity = createActivity(() => undefined, 1);
    activity.add({ ...CALL, target: "SELECT 1" });
    activity.add({ ...CALL, target: "SELECT 2" });
    expect(activity.fullTarget(1)).toBeNull();
    expect(activity.fullTarget(2)).toBe("SELECT 2");
  });

  it("givenRunningWork_whenCancelled_thenCancelCalledAndRunGoneAfter", async () => {
    const runs = createRuns(
      () => undefined,
      () => NOW,
    );
    let release = (): void => undefined;
    let cancelled = 0;
    const work = runs.track(
      { clientId: "mcp-1", clientName: "Claude Code", datasourceId: "shop", tool: "run_query", sql: "SELECT 1" },
      () => {
        cancelled += 1;
        release();
        return Promise.resolve();
      },
      () => new Promise<string>((resolve) => (release = () => resolve("done"))),
    );
    expect(runs.list()).toEqual([
      {
        id: "run-1",
        clientId: "mcp-1",
        clientName: "Claude Code",
        datasourceId: "shop",
        tool: "run_query",
        sql: "SELECT 1",
        startedAt: NOW,
        cancellable: true,
      },
    ]);
    expect(await runs.cancel("run-1")).toBe(true);
    expect(await work).toBe("done");
    expect(cancelled).toBe(1);
    expect(runs.list()).toEqual([]);
    expect(await runs.cancel("run-1")).toBe(false);
  });

  it("givenPluginWithoutCancel_whenTracked_thenNotCancellable", async () => {
    const runs = createRuns(
      () => undefined,
      () => NOW,
    );
    let release = (): void => undefined;
    const work = runs.track(
      { clientId: "mcp-1", clientName: "Claude Code", datasourceId: "shop", tool: "run_query", sql: "SELECT 1" },
      null,
      () => new Promise<string>((resolve) => (release = () => resolve("done"))),
    );
    expect(runs.list().map((run) => run.cancellable)).toEqual([false]);
    expect(await runs.cancel("run-1")).toBe(false);
    release();
    expect(await work).toBe("done");
  });
});

describe("console owners", () => {
  const owned = (handle: string, sessionId: string, window = 1) => ({
    handle,
    sessionId,
    window,
    datasourceId: "shop",
  });

  it("givenTwoSessions_whenFound_thenOnlyTheOwnerSeesItsConsole", () => {
    const owners = createConsoleOwners();
    const first = owners.next();
    owners.claim(owned(first, "a"));

    expect(owners.find("a", first)?.handle).toBe(first);
    expect(owners.find("b", first)).toBeNull();
    expect(owners.next()).not.toBe(first);
  });

  it("givenSessionEnds_whenReleased_thenItsConsolesGroupedByWindow", () => {
    const owners = createConsoleOwners();
    owners.claim(owned("c1", "a", 1));
    owners.claim(owned("c2", "a", 2));
    owners.claim(owned("c3", "a", 1));
    owners.claim(owned("c4", "b", 1));

    const ended = owners.endSession("a");

    expect(byWindow(ended)).toEqual(
      new Map([
        [1, ["c1", "c3"]],
        [2, ["c2"]],
      ]),
    );
    expect(owners.ofSession("a")).toEqual([]);
    expect(owners.clear().map((entry) => entry.handle)).toEqual(["c4"]);
  });
});
