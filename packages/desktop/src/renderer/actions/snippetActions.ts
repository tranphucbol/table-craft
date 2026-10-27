import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import type { PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { editorOf } from "@table-craft/desktop/renderer/console/caretAnchor.js";

import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useSnippets } from "@table-craft/desktop/renderer/state/snippets.js";
import {
  eligibleSnippetPlugins,
  snippetDraftDirty,
  snippetFieldProblems,
  snippetSuggestions,
  useSnippetsDialog,
} from "@table-craft/desktop/renderer/state/snippetsDialog.js";
import type { SnippetScope, TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

export function defaultSnippetScope(context: ActionContext, plugins: readonly PluginInfo[]): SnippetScope {
  const datasource =
    context.console === null
      ? context.datasource?.view
      : context.datasources.find((view) => view.id === context.console?.datasourceId);
  const plugin = eligibleSnippetPlugins(plugins).find((plugin) => plugin.id === datasource?.pluginId);
  return plugin === undefined ? { kind: "all" } : { kind: "plugin", pluginId: plugin.id };
}

export const SNIPPET_ACTION_IDS = {
  show: "snippets.show",
  new: "snippets.new",
  select: "snippets.select",
  change: "snippets.change",
  search: "snippets.search",
  save: "snippets.save",
  delete: "snippets.delete",
  close: "snippets.close",
  reload: "snippets.reload",
  dismissError: "snippets.dismissError",
  import: "snippets.import",
  export: "snippets.export",
  importSelection: "snippets.importSelection",
  openCreated: "snippets.openCreated",
  cancelImport: "snippets.cancelImport",
  cut: "editor.cut",
  copy: "editor.copy",
  paste: "editor.paste",
} as const;

const SAVE_CHOICE = "save";
const DISCARD_CHOICE = "discard";

function editable(): boolean {
  return useSnippetsDialog.getState().open && !useSnippetsDialog.getState().working && !useSnippets.getState().busy;
}

function canSave(): boolean {
  const dialog = useSnippetsDialog.getState();
  return (
    editable() &&
    snippetDraftDirty(dialog) &&
    dialog.draft !== null &&
    (!dialog.validated || Object.keys(snippetFieldProblems(dialog.draft, useSnippets.getState().snippets)).length === 0)
  );
}

async function saveDraft(): Promise<boolean> {
  const dialog = useSnippetsDialog.getState();
  const draft = dialog.draft;
  if (draft === null) return false;
  const problem = Object.values(snippetFieldProblems(draft, useSnippets.getState().snippets))[0] ?? null;
  dialog.setProblem(problem);
  if (problem !== null) return false;
  if (!(await useSnippets.getState().save(draft))) return false;
  const saved = useSnippets.getState().snippets.find((snippet) => snippet.id === draft.id) ?? draft;
  dialog.select(saved, saved);
  if (dialog.importConsoleId !== null) {
    dialog.created(dialog.importConsoleId, saved);
    dialog.hide();
  }
  return true;
}

async function leaveDraft(): Promise<boolean> {
  if (!snippetDraftDirty(useSnippetsDialog.getState())) return true;
  const answer = await useModal.getState().ask({
    kind: "choice",
    title: "Unsaved snippet",
    message: "Save your changes before leaving this snippet?",
    choices: [
      { id: DISCARD_CHOICE, label: "Discard Changes", variant: "danger" },
      { id: SAVE_CHOICE, label: "Save", variant: "primary" },
    ],
    focusedChoice: SAVE_CHOICE,
  });
  return answer === SAVE_CHOICE ? saveDraft() : answer === DISCARD_CHOICE;
}

async function working(run: () => Promise<void>): Promise<void> {
  const dialog = useSnippetsDialog.getState();
  dialog.setWorking(true);
  try {
    await run();
  } finally {
    dialog.setWorking(false);
  }
}

export const SNIPPET_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: SNIPPET_ACTION_IDS.show,
    title: "Snippets…",
    category: "Editor",
    icon: "generate",
    when: () => !useSnippetsDialog.getState().open,
    run: async (context) => {
      const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const dialog = useSnippetsDialog.getState();
      dialog.show(
        useSnippets.getState().snippets[0] ?? null,
        focus,
        defaultSnippetScope(context, useDatasources.getState().plugins),
      );
      if (!useSnippets.getState().loaded) {
        await working(async () => {
          await useSnippets.getState().load();
          const first = useSnippets.getState().snippets[0] ?? null;
          dialog.select(first, first);
        });
      }
    },
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.new,
    title: "New Snippet",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: () => editable() && useSnippets.getState().loaded,
    run: () =>
      working(async () => {
        if (!(await leaveDraft())) return;
        useSnippets.getState().dismissError();
        useSnippetsDialog.getState().search("");
        useSnippetsDialog.getState().select(
          {
            id: crypto.randomUUID(),
            name: "",
            prefix: "",
            scope: useSnippetsDialog.getState().defaultScope,
            body: "",
          },
          null,
        );
      }),
  }),
  defineAction<string>({
    id: SNIPPET_ACTION_IDS.select,
    title: "Select Snippet",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: editable,
    run: (_context, id) =>
      working(async () => {
        if (id === useSnippetsDialog.getState().draft?.id || !(await leaveDraft())) return;
        const snippet = useSnippets.getState().snippets.find((snippet) => snippet.id === id);
        if (snippet !== undefined) {
          useSnippets.getState().dismissError();
          useSnippetsDialog.getState().select(snippet, snippet);
        }
      }),
  }),
  defineAction<Partial<Pick<TextSnippet, "name" | "prefix" | "scope" | "body">>>({
    id: SNIPPET_ACTION_IDS.change,
    title: "Edit Snippet",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: editable,
    run: (_context, patch) => useSnippetsDialog.getState().change(patch),
  }),
  defineAction<string>({
    id: SNIPPET_ACTION_IDS.search,
    title: "Search Snippets",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: editable,
    run: (_context, query) => useSnippetsDialog.getState().search(query),
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.save,
    title: "Save Snippet",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: canSave,
    run: () =>
      working(async () => {
        await saveDraft();
      }),
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.delete,
    title: "Delete Snippet…",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: () => editable() && useSnippetsDialog.getState().original !== null,
    run: () =>
      working(async () => {
        const dialog = useSnippetsDialog.getState();
        const draft = dialog.draft;
        if (draft === null || dialog.original === null) return;
        const answer = await useModal.getState().ask({
          kind: "confirm",
          title: "Delete snippet",
          message: `Delete “${draft.name || "Untitled snippet"}”? This cannot be undone.`,
          confirm: "Delete",
          destructive: true,
        });
        if (answer === null) return;
        if (dialog.original !== null && !(await useSnippets.getState().remove(draft.id))) return;
        const next = useSnippets.getState().snippets.find((snippet) => snippet.id !== draft.id) ?? null;
        dialog.select(next, next);
      }),
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.close,
    title: "Close Snippets",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: editable,
    run: () =>
      working(async () => {
        if (await leaveDraft()) useSnippetsDialog.getState().hide();
      }),
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.reload,
    title: "Reload Snippets",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: editable,
    run: () =>
      working(async () => {
        if (useSnippetsDialog.getState().importConsoleId !== null) {
          await useSnippets.getState().load();
          return;
        }
        if (!(await leaveDraft())) return;
        await useSnippets.getState().load();
        if (useSnippets.getState().error !== null) return;
        const first = useSnippets.getState().snippets[0] ?? null;
        useSnippetsDialog.getState().select(first, first);
      }),
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.dismissError,
    title: "Dismiss Snippet Error",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: editable,
    run: () => {
      useSnippets.getState().dismissError();
      useSnippetsDialog.getState().setProblem(null);
    },
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.import,
    title: "Import Snippets",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open,
    when: editable,
    run: () =>
      working(async () => {
        if (!(await leaveDraft())) return;
        await useSnippets.getState().importSnippets();
      }),
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.export,
    title: "Export Snippets",
    category: "Editor",
    available: () => useSnippetsDialog.getState().open && useSnippets.getState().snippets.length > 0,
    when: editable,
    run: () =>
      working(async () => {
        await useSnippets.getState().exportSnippets();
      }),
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.importSelection,
    title: "Import into Snippet…",
    category: "Editor",
    when: (context) =>
      !useSnippetsDialog.getState().open &&
      useModal.getState().pending === null &&
      context.console !== null &&
      context.console.selection.from !== context.console.selection.to,
    run: async (context) => {
      const console = context.console;
      if (console === null || context.activeTab?.kind !== "console" || console.selection.from === console.selection.to)
        return;
      const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const dialog = useSnippetsDialog.getState();
      const { from, to } = console.selection;
      const selectedText = console.sql.slice(Math.min(from, to), Math.max(from, to));
      const scope = defaultSnippetScope(context, useDatasources.getState().plugins);
      const suggestion = snippetSuggestions(selectedText);
      dialog.show(null, focus, scope);
      dialog.beginImport(context.activeTab.id);
      useSnippets.getState().dismissError();
      useSnippetsDialog.getState().search("");
      useSnippetsDialog.getState().select(
        {
          id: crypto.randomUUID(),
          ...suggestion,
          scope,
          body: selectedText,
        },
        null,
      );
      if (!useSnippets.getState().loaded) {
        await working(async () => {
          await useSnippets.getState().load();
        });
      }
    },
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.cancelImport,
    title: "Cancel Snippet Import",
    category: "Editor",
    available: () => useSnippetsDialog.getState().importConsoleId !== null && useSnippetsDialog.getState().open,
    when: editable,
    run: () => useSnippetsDialog.getState().hide(),
  }),
  defineAction({
    id: SNIPPET_ACTION_IDS.openCreated,
    title: "Open Snippets",
    category: "Editor",
    when: () => !useSnippetsDialog.getState().open && useSnippetsDialog.getState().notice !== null,
    run: (context) => {
      const notice = useSnippetsDialog.getState().notice;
      if (notice === null) return;
      const snippet = useSnippets.getState().snippets.find((item) => item.id === notice.snippet.id);
      const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      useSnippetsDialog
        .getState()
        .show(snippet ?? null, focus, defaultSnippetScope(context, useDatasources.getState().plugins));
    },
  }),
  ...(["cut", "copy", "paste"] as const).map((command) =>
    defineAction({
      id: SNIPPET_ACTION_IDS[command],
      title: command === "cut" ? "Cut" : command === "copy" ? "Copy" : "Paste",
      category: "Editor",
      available: (context) => context.console !== null,
      when: (context) =>
        context.console !== null &&
        !context.paletteOpen &&
        (command === "paste" || context.console.selection.from !== context.console.selection.to),
      run: async (context) => {
        if (context.console === null || context.activeTab?.kind !== "console") return;
        const view = editorOf(context.activeTab.id);
        if (view === null) return;
        view.focus();
        const state = view.state;
        if (command === "paste") {
          const text = await navigator.clipboard.readText();
          if (view.dom.isConnected && view.state === state)
            view.dispatch({ ...state.replaceSelection(text), userEvent: "input.paste", scrollIntoView: true });
        } else if (!state.selection.main.empty) {
          await navigator.clipboard.writeText(
            state.selection.ranges.map(({ from, to }) => state.sliceDoc(from, to)).join("\n"),
          );
          if (command === "cut" && view.dom.isConnected && view.state === state)
            view.dispatch({ ...state.replaceSelection(""), userEvent: "delete.cut", scrollIntoView: true });
        }
      },
    }),
  ),
];
