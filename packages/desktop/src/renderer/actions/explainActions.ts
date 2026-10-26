import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  activePlanOf,
  canRun,
  useConsoles,
  type PlanTab,
  type PlanView,
} from "@table-craft/desktop/renderer/state/consoles.js";

export const EXPLAIN_ACTION_IDS = {
  explain: "console.explain",
  explainAnalyze: "console.explainAnalyze",
  rerun: "plan.rerun",
  copy: "plan.copy",
  showTree: "plan.showTree",
  showRaw: "plan.showRaw",
} as const;

const canExplain = (context: ActionContext) => context.capabilities.includes("explain");
const canAnalyse = (context: ActionContext) => context.capabilities.includes("explainAnalyze");
const consoleReady = (context: ActionContext) => context.console !== null && canRun(context.console.status);

function shownPlan(context: ActionContext): { readonly consoleId: string; readonly plan: PlanTab } | null {
  const plan = context.console === null ? null : activePlanOf(context.console);
  if (plan === null || context.activeTab === null) return null;
  return { consoleId: context.activeTab.id, plan };
}

function explainActive(context: ActionContext, analyze: boolean): void {
  if (context.activeTab !== null) void useConsoles.getState().explain(context.activeTab.id, analyze);
}

function showView(context: ActionContext, view: PlanView): void {
  const shown = shownPlan(context);
  if (shown !== null) useConsoles.getState().updatePlan(shown.consoleId, shown.plan.id, { view });
}

/** Explain Plan and Explain Analyse (plan 012 decision 8), and what the plan tab's toolbar does. */
export const EXPLAIN_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: EXPLAIN_ACTION_IDS.explain,
    title: "Explain Plan",
    category: "Console",
    icon: "explain",
    shortcut: "Mod+Shift+E",
    tabKind: "console",
    available: canExplain,
    when: consoleReady,
    run: (context) => explainActive(context, false),
  }),
  defineAction({
    // No chord, deliberately: it runs the statement (plan 012 decision 8).
    id: EXPLAIN_ACTION_IDS.explainAnalyze,
    title: "Explain Analyse",
    category: "Console",
    icon: "explainAnalyze",
    tabKind: "console",
    available: canAnalyse,
    when: consoleReady,
    run: (context) => explainActive(context, true),
  }),
  defineAction({
    id: EXPLAIN_ACTION_IDS.rerun,
    title: "Explain Again",
    category: "Console",
    icon: "rerun",
    tabKind: "console",
    when: (context) => shownPlan(context) !== null && consoleReady(context),
    run: async (context) => {
      const shown = shownPlan(context);
      if (shown !== null) await useConsoles.getState().rerun(shown.consoleId, shown.plan.id);
    },
  }),
  defineAction({
    id: EXPLAIN_ACTION_IDS.copy,
    title: "Copy Raw Plan",
    category: "Console",
    icon: "copy",
    tabKind: "console",
    when: (context) => shownPlan(context) !== null,
    run: async (context) => {
      const shown = shownPlan(context);
      if (shown !== null) await writeClipboard(shown.plan.plan.raw);
    },
  }),
  defineAction({
    id: EXPLAIN_ACTION_IDS.showTree,
    title: "Show Plan Tree",
    category: "Console",
    tabKind: "console",
    when: (context) => shownPlan(context) !== null,
    run: (context) => showView(context, "tree"),
  }),
  defineAction({
    id: EXPLAIN_ACTION_IDS.showRaw,
    title: "Show Raw Plan",
    category: "Console",
    tabKind: "console",
    when: (context) => shownPlan(context) !== null,
    run: (context) => showView(context, "raw"),
  }),
];
