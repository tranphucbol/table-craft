import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import type { ErrorAnswer } from "@table-craft/desktop/engine/protocol.js";
import { markOfError } from "@table-craft/desktop/renderer/model/errorLocation.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";

/** Go to Error and the answers a run of several statements waits for (decisions 082, 083). */
export const ERROR_ACTION_IDS = {
  next: "console.gotoError",
  previous: "console.gotoPreviousError",
  show: "console.showError",
  skip: "console.errorSkip",
  skipAll: "console.errorSkipAll",
  stop: "console.errorStop",
  retry: "console.errorRetry",
} as const;

const hasMarks = (context: ActionContext) => (context.console?.errorMarks.length ?? 0) > 0;
const isAsking = (context: ActionContext) => context.console?.question != null;

function answer(context: ActionContext, value: ErrorAnswer): void {
  if (context.activeTab !== null) useConsoles.getState().answerError(context.activeTab.id, value);
}

function answerAction(id: string, title: string, value: ErrorAnswer): AnyAction {
  return defineAction({
    id,
    title,
    category: "Console",
    tabKind: "console",
    when: isAsking,
    run: (context) => answer(context, value),
  });
}

export const ERROR_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: ERROR_ACTION_IDS.next,
    title: "Next Error",
    category: "Console",
    shortcut: "F2",
    tabKind: "console",
    when: hasMarks,
    run: (context) => {
      if (context.activeTab !== null) useConsoles.getState().gotoError(context.activeTab.id, false);
    },
  }),
  defineAction({
    id: ERROR_ACTION_IDS.previous,
    title: "Previous Error",
    category: "Console",
    shortcut: "Shift+F2",
    tabKind: "console",
    when: hasMarks,
    run: (context) => {
      if (context.activeTab !== null) useConsoles.getState().gotoError(context.activeTab.id, true);
    },
  }),
  defineAction({
    id: ERROR_ACTION_IDS.show,
    title: "Go to Error",
    category: "Console",
    icon: "search",
    tabKind: "console",
    when: (context) =>
      context.console !== null && markOfError(context.console.errorMarks, context.console.error) !== null,
    run: (context) => {
      if (context.activeTab !== null) useConsoles.getState().showError(context.activeTab.id);
    },
  }),
  answerAction(ERROR_ACTION_IDS.skip, "Skip Failed Statement", "skip"),
  answerAction(ERROR_ACTION_IDS.skipAll, "Skip All Failed Statements", "skipAll"),
  answerAction(ERROR_ACTION_IDS.stop, "Stop at Failed Statement", "stop"),
  answerAction(ERROR_ACTION_IDS.retry, "Retry Failed Statement", "retry"),
];
