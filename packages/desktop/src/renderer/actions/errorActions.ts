import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import type { ErrorAnswer } from "@table-craft/desktop/engine/protocol.js";
import { editorOf } from "@table-craft/desktop/renderer/console/caretAnchor.js";
import { nextProblemIn } from "@table-craft/desktop/renderer/console/inspections.js";
import { openIntentions } from "@table-craft/desktop/renderer/console/intentions.js";
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
  showIntentions: "editor.showIntentions",
} as const;

function consoleEditor(context: ActionContext) {
  return context.activeTab?.kind === "console" ? editorOf(context.activeTab.id) : null;
}

/** Server marks, or live problems F2 visits, in the active console (plan 108 decision 5). */
function hasStops(context: ActionContext): boolean {
  if ((context.console?.errorMarks.length ?? 0) > 0) return true;
  const view = consoleEditor(context);
  return view !== null && nextProblemIn(view.state, false) !== null;
}

function gotoProblem(context: ActionContext, backward: boolean): void {
  if (context.activeTab === null) return;
  const view = consoleEditor(context);
  const stop = view === null ? null : nextProblemIn(view.state, backward);
  if (stop === null) useConsoles.getState().gotoError(context.activeTab.id, backward);
  else useConsoles.getState().jumpTo(context.activeTab.id, stop);
}
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
    when: hasStops,
    run: (context) => gotoProblem(context, false),
  }),
  defineAction({
    id: ERROR_ACTION_IDS.previous,
    title: "Previous Error",
    category: "Console",
    shortcut: "Shift+F2",
    tabKind: "console",
    when: hasStops,
    run: (context) => gotoProblem(context, true),
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
  defineAction({
    id: ERROR_ACTION_IDS.showIntentions,
    title: "Show Context Actions",
    category: "Editor",
    icon: "quickFix",
    shortcut: "Alt+Enter",
    shortcutRegion: "editor",
    tabKind: "console",
    when: (context) => consoleEditor(context) !== null,
    run: (context) => {
      const view = consoleEditor(context);
      if (view === null) return;
      view.focus();
      openIntentions(view);
    },
  }),
  answerAction(ERROR_ACTION_IDS.skip, "Skip Failed Statement", "skip"),
  answerAction(ERROR_ACTION_IDS.skipAll, "Skip All Failed Statements", "skipAll"),
  answerAction(ERROR_ACTION_IDS.stop, "Stop at Failed Statement", "stop"),
  answerAction(ERROR_ACTION_IDS.retry, "Retry Failed Statement", "retry"),
];
