import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_ACTIONS } from "@table-craft/desktop/renderer/actions/allActions.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { currentContext } from "@table-craft/desktop/renderer/actions/context.js";
import { EXPLAIN_ACTION_IDS } from "@table-craft/desktop/renderer/actions/explainActions.js";
import { createActionRegistry, defineAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  useConsoles,
  type ConsoleSession,
  type ConsoleStatus,
  type ErrorQuestion,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { IDLE_CONTEXT } from "./support.js";

const RUN_ACTIONS = [ACTION_IDS.run, ACTION_IDS.runAll] as const;

const QUESTION: ErrorQuestion = {
  number: 1,
  total: 2,
  sql: "SELECT nope",
  error: { code: "statementFailed", message: "no such column: nope", hint: "" },
};

function patchConsole(id: string, changes: Partial<ConsoleSession>): void {
  const { consoles } = useConsoles.getState();
  const session = consoles[id];
  if (session === undefined) throw new Error(`No console "${id}" to patch.`);
  useConsoles.setState({ consoles: { ...consoles, [id]: { ...session, ...changes } } });
}

function busyActions(tabId: string): string[] {
  const registry = createActionRegistry(currentContext);
  registry.register(ALL_ACTIONS);
  return RUN_ACTIONS.filter((id) => registry.isBusy(id, currentContext(tabId)));
}

describe("busy actions", () => {
  it("givenActionWithoutBusy_whenAsked_thenNotBusy", () => {
    const registry = createActionRegistry(() => IDLE_CONTEXT);
    registry.register([defineAction({ id: "console.run", title: "Run", category: "Console", run: () => undefined })]);

    expect(registry.isBusy("console.run")).toBe(false);
  });

  it("givenUnknownAction_whenAsked_thenNotBusy", () => {
    expect(createActionRegistry(() => IDLE_CONTEXT).isBusy("nope")).toBe(false);
  });
});

describe("Run and Run All busy", () => {
  const initialTabs = useTabs.getState();
  const initialConsoles = useConsoles.getState();
  const initialDatasources = useDatasources.getState();

  beforeEach(async () => {
    vi.stubGlobal("document", { activeElement: null });
    useTabs.setState({ ...initialTabs, tabs: [], activeId: null, groupActiveIds: { left: null, right: null } }, true);
    useConsoles.setState({ consoles: {} });
    useDatasources.setState({
      selection: null,
      datasources: ["left-db", "right-db"].map((id) => ({
        id,
        name: id,
        pluginId: "sqlite",
        folder: null,
        color: null,
        readOnly: false,
        comment: "",
        config: {},
        secretModes: {},
        storedSecrets: [],
        ephemeral: false,
      })),
    });
    await useConsoles.getState().open("left", "left-db", { connect: false });
    await useConsoles.getState().open("right", "right-db", { connect: false });
    useTabs.getState().open({ id: "left", kind: "console", title: "left" });
    useTabs.getState().open({ id: "right", kind: "console", title: "right" });
    useTabs.getState().moveToGroup("right", "right");
  });

  afterEach(() => {
    useTabs.setState(initialTabs, true);
    useConsoles.setState(initialConsoles, true);
    useDatasources.setState(initialDatasources, true);
    vi.unstubAllGlobals();
  });

  it("givenRunningConsole_whenAsked_thenRunAndRunAllBusy", () => {
    patchConsole("left", { status: "running" });

    expect(busyActions("left")).toEqual(RUN_ACTIONS);
  });

  it.each<ConsoleStatus>(["ready", "connecting", "confirming", "failed", "disconnected"])(
    "givenReadyConnectingOrConfirmingConsole_whenAsked_thenNotBusy (%s)",
    (status) => {
      patchConsole("left", { status });

      expect(busyActions("left")).toEqual([]);
    },
  );

  it("givenFailedStatementQuestion_whenAsked_thenNotBusy", () => {
    patchConsole("left", { status: "running", question: QUESTION });

    expect(busyActions("left")).toEqual([]);
  });

  it("givenExplainRunning_whenAsked_thenRunBusy", () => {
    // Explain sets the same `running` status as Run; the console runs one thing at a time (decision 1).
    patchConsole("left", { status: "running" });
    const registry = createActionRegistry(currentContext);
    registry.register(ALL_ACTIONS);

    expect(registry.isBusy(ACTION_IDS.run, currentContext("left"))).toBe(true);
    expect(registry.isBusy(EXPLAIN_ACTION_IDS.explain, currentContext("left"))).toBe(false);
  });

  it("givenSplitConsoles_whenOneRuns_thenOnlyItsTabIsBusy", () => {
    patchConsole("right", { status: "running" });

    expect(busyActions("right")).toEqual(RUN_ACTIONS);
    expect(busyActions("left")).toEqual([]);
  });
});
