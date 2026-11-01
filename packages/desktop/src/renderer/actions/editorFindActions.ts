import { getSearchQuery } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import type { Chord } from "@table-craft/desktop/renderer/actions/chords.js";
import type { ActionContext, FocusRegion } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { editorOf } from "@table-craft/desktop/renderer/console/caretAnchor.js";
import {
  canScopeToSelection,
  closeFind,
  excludeCurrent,
  findNextMatch,
  findOpen,
  findPreviousMatch,
  onMatch,
  openFind,
  queryValid,
  replaceCurrent,
  replaceEvery,
  selectAllOccurrences,
  toggleInSelection,
  toggleOption,
  togglePreserveCase,
  type FindOption,
} from "@table-craft/desktop/renderer/console/find/commands.js";

/** The console editor's find and replace (plan 139), DataGrip's editor find bar. */
export const EDITOR_FIND_ACTION_IDS = {
  find: "editor.find",
  replace: "editor.replace",
  findNext: "editor.findNext",
  findPrevious: "editor.findPrevious",
  findNextInField: "editor.findNextInField",
  findPreviousInField: "editor.findPreviousInField",
  replaceOne: "editor.replaceOne",
  replaceAll: "editor.replaceAll",
  exclude: "editor.excludeOccurrence",
  selectAll: "editor.selectAllOccurrences",
  matchCase: "editor.findMatchCase",
  words: "editor.findWords",
  regex: "editor.findRegex",
  preserveCase: "editor.findPreserveCase",
  inSelection: "editor.findInSelection",
  close: "editor.closeFind",
} as const;

/** Where the console's find chords work: the editor and both rows of its find bar. */
const EDITOR_AND_BAR: readonly FocusRegion[] = ["editor", "editorFind", "editorReplace"];
const BAR: readonly FocusRegion[] = ["editorFind", "editorReplace"];

function consoleView(context: ActionContext): EditorView | null {
  return context.activeTab?.kind === "console" ? editorOf(context.activeTab.id) : null;
}

/** The console's editor while its find bar is open. */
function openBar(context: ActionContext): EditorView | null {
  const view = consoleView(context);
  return view !== null && findOpen(view.state) ? view : null;
}

function searchable(context: ActionContext): EditorView | null {
  const view = openBar(context);
  return view !== null && queryValid(view.state) ? view : null;
}

function writable(context: ActionContext): EditorView | null {
  const view = searchable(context);
  return view !== null && !view.state.readOnly ? view : null;
}

function withView(pick: (context: ActionContext) => EditorView | null, run: (view: EditorView) => unknown) {
  return (context: ActionContext) => {
    const view = pick(context);
    if (view !== null) run(view);
  };
}

function optionAction(id: string, title: string, option: FindOption, shortcut: Chord): AnyAction {
  return defineAction({
    id,
    title,
    category: "Editor",
    shortcut,
    shortcutRegion: BAR,
    tabKind: "console",
    when: (context) => openBar(context) !== null,
    run: withView(openBar, (view) => toggleOption(view, option)),
  });
}

export const EDITOR_FIND_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.find,
    title: "Find in Console",
    category: "Editor",
    icon: "search",
    shortcut: "Mod+F",
    shortcutRegion: EDITOR_AND_BAR,
    tabKind: "console",
    when: (context) => consoleView(context) !== null,
    run: withView(consoleView, (view) => openFind(view, { replace: false })),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.replace,
    title: "Replace in Console",
    category: "Editor",
    icon: "replace",
    shortcut: "Mod+R",
    shortcutRegion: EDITOR_AND_BAR,
    tabKind: "console",
    when: (context) => consoleView(context) !== null,
    run: withView(consoleView, (view) => openFind(view, { replace: true })),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.findNext,
    title: "Find Next Occurrence",
    category: "Editor",
    icon: "findNext",
    shortcut: "Mod+G",
    shortcutRegion: EDITOR_AND_BAR,
    tabKind: "console",
    when: (context) => consoleView(context) !== null,
    run: withView(consoleView, findNextMatch),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.findPrevious,
    title: "Find Previous Occurrence",
    category: "Editor",
    icon: "findPrevious",
    shortcut: "Shift+Mod+G",
    shortcutRegion: EDITOR_AND_BAR,
    tabKind: "console",
    when: (context) => consoleView(context) !== null,
    run: withView(consoleView, findPreviousMatch),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.findNextInField,
    title: "Find Next",
    category: "Editor",
    shortcut: "Enter",
    shortcutRegion: "editorFind",
    tabKind: "console",
    inPalette: false,
    when: (context) => searchable(context) !== null,
    run: withView(searchable, findNextMatch),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.findPreviousInField,
    title: "Find Previous",
    category: "Editor",
    shortcut: "Shift+Enter",
    shortcutRegion: "editorFind",
    tabKind: "console",
    inPalette: false,
    when: (context) => searchable(context) !== null,
    run: withView(searchable, findPreviousMatch),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.replaceOne,
    title: "Replace",
    category: "Editor",
    shortcut: "Enter",
    shortcutRegion: "editorReplace",
    tabKind: "console",
    when: (context) => writable(context) !== null,
    run: withView(writable, replaceCurrent),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.replaceAll,
    title: "Replace All",
    category: "Editor",
    shortcut: "Mod+Alt+Enter",
    shortcutRegion: BAR,
    tabKind: "console",
    when: (context) => writable(context) !== null,
    run: withView(writable, replaceEvery),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.exclude,
    title: "Exclude",
    category: "Editor",
    tabKind: "console",
    when: (context) => {
      const view = searchable(context);
      return view !== null && onMatch(view.state);
    },
    run: withView(searchable, excludeCurrent),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.selectAll,
    title: "Select All Occurrences",
    category: "Editor",
    icon: "selectAll",
    shortcut: "Mod+Alt+Shift+J",
    shortcutRegion: EDITOR_AND_BAR,
    tabKind: "console",
    when: (context) => consoleView(context) !== null,
    run: withView(consoleView, selectAllOccurrences),
  }),
  // IntelliJ's mnemonics for the find bar's options.
  optionAction(EDITOR_FIND_ACTION_IDS.matchCase, "Match Case", "caseSensitive", "Alt+C"),
  optionAction(EDITOR_FIND_ACTION_IDS.words, "Words", "wholeWord", "Alt+W"),
  optionAction(EDITOR_FIND_ACTION_IDS.regex, "Regex", "regexp", "Alt+X"),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.preserveCase,
    title: "Preserve Case",
    category: "Editor",
    shortcut: "Alt+P",
    shortcutRegion: BAR,
    tabKind: "console",
    when: (context) => {
      const view = openBar(context);
      return view !== null && !getSearchQuery(view.state).regexp;
    },
    run: withView(openBar, togglePreserveCase),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.inSelection,
    title: "In Selection",
    category: "Editor",
    icon: "inSelection",
    tabKind: "console",
    when: (context) => {
      const view = openBar(context);
      return view !== null && canScopeToSelection(view.state);
    },
    run: withView(openBar, toggleInSelection),
  }),
  defineAction({
    id: EDITOR_FIND_ACTION_IDS.close,
    title: "Close Find",
    category: "Editor",
    icon: "close",
    tabKind: "console",
    when: (context) => openBar(context) !== null,
    run: withView(openBar, closeFind),
  }),
];
