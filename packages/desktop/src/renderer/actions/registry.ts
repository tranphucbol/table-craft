import type { Chord } from "@table-craft/desktop/renderer/actions/chords.js";
import type { ActionContext, FocusRegion } from "@table-craft/desktop/renderer/actions/context.js";
import type { TabKind } from "@table-craft/desktop/renderer/state/tabs.js";

/** Every command the app has is one of these (decision 015): menus, palette, keymap and buttons only `invoke`. */
export type ActionCategory =
  | "App"
  | "Editor"
  | "Console"
  | "Result Grid"
  | "Table Editor"
  | "Key Editor"
  | "Database"
  | "Editor Tabs"
  | "Tool Windows"
  | "Navigation";

/** Names, not components, so the registry stays free of React; `ui/icons.ts` maps them. */
export type ActionIcon =
  | "run"
  | "runAll"
  | "commit"
  | "rollback"
  | "pin"
  | "cancel"
  | "newConsole"
  | "close"
  | "database"
  | "services"
  | "server"
  | "search"
  | "add"
  | "properties"
  | "duplicate"
  | "delete"
  | "connect"
  | "disconnect"
  | "folder"
  | "synchronize"
  | "collapseAll"
  | "copy"
  | "fetchNextPage"
  | "fetchAll"
  | "rerun"
  | "export"
  | "import"
  | "valuePanel"
  | "sortAscending"
  | "sortDescending"
  | "hide"
  | "revert"
  | "preview"
  | "submit"
  | "count"
  | "filter"
  | "goTo"
  | "referencing"
  | "table"
  | "ddl"
  | "quickDoc"
  | "generate"
  | "history"
  | "reopen"
  | "explain"
  | "explainAnalyze"
  | "settings"
  | "menu"
  | "log"
  | "diagnostics"
  | "update"
  | "download"
  | "findNext"
  | "findPrevious"
  | "sessions"
  | "terminate"
  | "quickFix"
  | "transpose"
  | "saveFile"
  | "loadFile";

export interface Action<A = void> {
  readonly id: string;
  readonly title: string;
  readonly category: ActionCategory;
  readonly icon?: ActionIcon;
  readonly shortcut?: Chord;
  /** The shortcut works only while focus is in these regions; menus, buttons and the palette still run it. */
  readonly shortcutRegion?: FocusRegion | readonly FocusRegion[];
  /**
   * The action runs only while the active tab is of this kind, so one chord can mean Run in a
   * console and Submit in a table tab (plan 008).
   */
  readonly tabKind?: TabKind;
  /**
   * Actions sharing this one's chord that it goes before while both could fire; one that does not
   * run then leaves the chord to them, as Submit leaves ⌘↩ to Run when nothing is pending (decision 057).
   */
  readonly preempts?: readonly string[];
  /**
   * Whether the action exists for the active tab at all, as when its datasource's plugin lacks the
   * capability (decision 007); absent means always. Unavailable actions leave the palette and never run.
   */
  readonly available?: (context: ActionContext) => boolean;
  /** Whether the action can run now; absent means always. */
  readonly when?: (context: ActionContext) => boolean;
  /**
   * Whether the work this action starts is under way now, so its buttons show progress rather than
   * look idle, as Run spins while its console runs (plan 112); absent means never.
   */
  readonly busy?: (context: ActionContext) => boolean;
  readonly run: (context: ActionContext, args: A) => void | Promise<void>;
}

/** Stored without its argument type; `never` because every `Action<A>` accepts it. */
export type AnyAction = Action<never>;

export type InvokeOutcome = "ran" | "disabled" | "unknown";

export function defineAction<A = void>(action: Action<A>): Action<A> {
  return action;
}

export interface ActionRegistry {
  register(actions: readonly AnyAction[]): void;
  /** The only way anything runs a command. */
  invoke(id: string, args?: unknown): InvokeOutcome;
  isEnabled(id: string, context?: ActionContext): boolean;
  /** False when the action's `available` says it does not apply now. */
  isAvailable(id: string, context?: ActionContext): boolean;
  /** False for an unknown action or one without `busy`. */
  isBusy(id: string, context?: ActionContext): boolean;
  get(id: string): AnyAction | undefined;
  all(): readonly AnyAction[];
  /** Called after every action that ran, with its id. */
  onInvoked(listener: (id: string) => void): () => void;
}

export function createActionRegistry(
  contextOf: () => ActionContext,
  reportFailure: (id: string, cause: unknown) => void = () => undefined,
): ActionRegistry {
  const actions = new Map<string, AnyAction>();
  const listeners = new Set<(id: string) => void>();

  function enabled(action: AnyAction, context: ActionContext): boolean {
    if (action.tabKind !== undefined && context.activeTab?.kind !== action.tabKind) return false;
    if (action.available?.(context) === false) return false;
    return action.when?.(context) ?? true;
  }

  return {
    register(added) {
      for (const action of added) {
        const existing = actions.get(action.id);
        if (existing !== undefined) {
          throw new Error(
            `Action id "${action.id}" is registered twice: "${existing.title}" and "${action.title}". Give one a new id.`,
          );
        }
        actions.set(action.id, action);
      }
    },
    invoke(id, args) {
      const action = actions.get(id);
      if (action === undefined) return "unknown";
      const context = contextOf();
      if (!enabled(action, context)) return "disabled";
      try {
        void Promise.resolve(action.run(context, args as never)).catch((cause: unknown) => reportFailure(id, cause));
      } catch (cause) {
        reportFailure(id, cause);
      }
      for (const listener of listeners) listener(id);
      return "ran";
    },
    isEnabled(id, context = contextOf()) {
      const action = actions.get(id);
      return action !== undefined && enabled(action, context);
    },
    isAvailable(id, context = contextOf()) {
      const action = actions.get(id);
      return action !== undefined && (action.available?.(context) ?? true);
    },
    isBusy(id, context = contextOf()) {
      return actions.get(id)?.busy?.(context) ?? false;
    },
    get: (id) => actions.get(id),
    all: () => [...actions.values()],
    onInvoked(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
