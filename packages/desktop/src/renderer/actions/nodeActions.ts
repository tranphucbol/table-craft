import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { nextRunOn, runOnChoices } from "@table-craft/desktop/renderer/model/runOn.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { useServer } from "@table-craft/desktop/renderer/state/server.js";

export const NODE_ACTION_IDS = {
  runOn: "console.runOn",
} as const;

/** A node picked in the Run on picker; without it the action moves to the next choice. */
export interface RunOnArgs {
  readonly node: string;
}

/** Where a console's commands run on a cluster (decision 114). */
export const NODE_ACTIONS: readonly AnyAction[] = [
  defineAction<RunOnArgs | undefined>({
    id: NODE_ACTION_IDS.runOn,
    title: "Run On Next Node",
    category: "Console",
    tabKind: "console",
    available: (context) => context.capabilities.includes("nodes"),
    when: (context) =>
      context.console !== null &&
      runOnChoices(useServer.getState().nodes[context.console.datasourceId] ?? []).length > 0,
    run: (context, args) => {
      const consoleId = context.activeTab?.id;
      const session = context.console;
      if (consoleId === undefined || session === null) return;
      const choices = runOnChoices(useServer.getState().nodes[session.datasourceId] ?? []);
      useConsoles.getState().setNode(consoleId, args?.node ?? nextRunOn(choices, session.node));
    },
  }),
];
