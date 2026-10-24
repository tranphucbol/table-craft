import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { loadSession, openStore, report, ReportError } from "../../scripts/agent-cost/report.js";
import { classifyCall, summarise, type MessageRow, type SessionRecord } from "../../scripts/agent-cost/summary.js";

const WORKTREE = "/repo/worktree/049";
const STEP_COST = 0.1;
const CONTEXT = 100_000;

interface ToolPart {
  name: string;
  input: Record<string, unknown>;
}

function assistant(tools: ToolPart[], context = CONTEXT): MessageRow {
  return {
    type: "assistant",
    data: JSON.stringify({
      cost: STEP_COST,
      tokens: { input: 0, output: 10, reasoning: 0, cache: { read: context, write: 0 } },
      content: tools.map(({ name, input }) => ({ type: "tool", name, state: { status: "completed", input } })),
    }),
  };
}

const read = (path: string): ToolPart => ({ name: "read", input: { path } });
const shell = (command: string): ToolPart => ({ name: "shell", input: { command } });
const edit = (path: string): ToolPart => ({ name: "edit", input: { path, oldString: "a", newString: "b" } });

function session(rows: MessageRow[], children: SessionRecord["children"] = []): SessionRecord {
  return { id: "ses_1", title: "049 test", directory: WORKTREE, rows, children };
}

describe("agent cost summary", () => {
  it("givenSessionRows_whenSummarised_thenCountsLookupAndEditSteps", () => {
    const summary = summarise(
      session([
        { type: "user", data: "{}" },
        assistant([read("a.ts"), shell("grep -n foo b.ts")]),
        assistant([shell("cd packages && sed -n '1,20p' c.ts")]),
        assistant([read("a.ts"), edit("a.ts")]),
        assistant([edit("docs/plans/049.md")]),
        assistant([shell("bun run lint")]),
        assistant([]),
        { type: "assistant", data: JSON.stringify({ content: [] }) },
      ]),
    );

    expect(summary).toMatchObject({ steps: 6, lookupSteps: 2, editSteps: 2, oneToolSteps: 3 });
    expect(summary.byKind.get("lookup")).toEqual({ steps: 3, cost: expect.closeTo(0.25) as number });
    expect(summary.byKind.get("think")?.steps).toBe(1);
    expect(summary.beforeFirstCodeEdit.steps).toBe(2);
    expect(summary.afterLastCodeEdit.steps).toBe(3);
    expect(summary.cost).toBeCloseTo(STEP_COST * 6);
  });

  it("givenRepeatedReadsOfOneFile_whenSummarised_thenListsItAsReRead", () => {
    const summary = summarise(
      session([
        assistant([read(`${WORKTREE}/packages/desktop/src/engine/engine.ts`)]),
        assistant([read("packages/desktop/src/engine/engine.ts")]),
        assistant([shell(`cd ${WORKTREE}/packages/desktop && sed -n '225,300p' src/engine/engine.ts`)]),
        assistant([shell("cat packages/desktop/src/engine/protocol.ts | head -5")]),
      ]),
    );

    expect(summary.reReads).toEqual([["packages/desktop/src/engine/engine.ts", 3]]);
    expect(summary.maxReads).toBe(3);
  });

  it("givenShellCommands_whenClassified_thenSortsThemByWhatTheyDo", () => {
    const kinds = [
      "COMPOSE_PROJECT_NAME=tc-g bun run test:smoke:db:headless test/e2e/a.smoke.test.ts",
      "bun run typecheck",
      "git commit -m 'Split'",
      "git log --oneline -3",
      "bun install",
    ].map((command) => classifyCall("shell", { command }).kind);

    expect(kinds).toEqual(["live-test", "verify", "git", "lookup", "other"]);
  });

  it("givenSubagentSessions_whenSummarised_thenCountsExploreRunsAndTheirCost", () => {
    const summary = summarise(
      session(
        [assistant([{ name: "subagent", input: { agent: "explore" } }])],
        [
          { agent: "explore", cost: 0.3 },
          { agent: "explore", cost: 0.2 },
          { agent: "oracle", cost: 1 },
        ],
      ),
    );

    expect(summary.exploreSubagents).toBe(2);
    expect(summary.subagentCost).toBeCloseTo(1.5);
    expect(summary.byKind.get("delegate")?.steps).toBe(1);
  });

  it("givenContextDrop_whenSummarised_thenCountsACompaction", () => {
    const summary = summarise(session([assistant([], 150_000), assistant([], 60_000), assistant([], 70_000)]));

    expect(summary).toMatchObject({ compactions: 1, contextFirst: 150_000, contextMax: 150_000 });
    expect(summary.contextAverage).toBe(93_333);
  });
});

describe("agent cost report", () => {
  let folder: string | undefined;

  afterEach(() => {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });

  function seededStore(): string {
    folder = mkdtempSync(join(tmpdir(), "agent-cost-"));
    const path = join(folder, "opencode.db");
    const db = new DatabaseSync(path);
    db.exec(`
      create table session_v2 (id text primary key, parent_id text, title text, directory text not null,
        agent text, cost real not null default 0, time_created integer not null);
      create table session_message (id text primary key, session_id text not null, type text not null,
        seq integer not null, data text not null);
    `);
    const addSession = db.prepare(
      "insert into session_v2 (id, parent_id, title, directory, agent, cost, time_created) values (?, ?, ?, ?, ?, ?, ?)",
    );
    addSession.run("ses_plan", null, "049 Cut token burn", WORKTREE, "build", 0.2, 1);
    addSession.run("ses_other", null, "045 Sessions view", WORKTREE, "build", 0, 2);
    addSession.run("ses_map", "ses_plan", "Map engine", WORKTREE, "explore", 0.25, 3);
    const addMessage = db.prepare(
      "insert into session_message (id, session_id, type, seq, data) values (?, ?, ?, ?, ?)",
    );
    [assistant([read("a.ts")]), assistant([read("a.ts")])].forEach((row, seq) =>
      addMessage.run(`m${seq}`, "ses_plan", row.type, seq, row.data),
    );
    db.close();
    return path;
  }

  it("givenStore_whenSessionNamedByTitleFragment_thenLoadsItWithItsSubagents", () => {
    const store = openStore(seededStore());
    try {
      const loaded = loadSession(store, "Cut token");

      expect(loaded).toMatchObject({ id: "ses_plan", directory: WORKTREE, children: [{ agent: "explore" }] });
      expect(loaded.rows).toHaveLength(2);
      expect(report(store, ["ses_plan"])).toMatch(/a\.ts ×2/);
    } finally {
      store.close();
    }
  });

  it("givenAmbiguousOrUnknownReference_whenLoaded_thenFailsNamingWhatToPass", () => {
    const store = openStore(seededStore());
    try {
      expect(() => loadSession(store, "0")).toThrow(/matches 2 sessions; pass one id/);
      expect(() => loadSession(store, "ses_missing")).toThrow(ReportError);
    } finally {
      store.close();
    }
  });
});
