import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { MSSQL, MySQL, PLSQL, PostgreSQL, sql, SQLite, StandardSQL, type SQLDialect } from "@codemirror/lang-sql";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type EditorStateConfig,
} from "@codemirror/state";
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useEffect, useRef } from "react";
import { SNIPPET_ACTION_IDS } from "@table-craft/desktop/renderer/actions/snippetActions.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { ERROR_ACTION_IDS } from "@table-craft/desktop/renderer/actions/errorActions.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { invoke, registry } from "@table-craft/desktop/renderer/actions/index.js";
import { trackEditor } from "@table-craft/desktop/renderer/console/caretAnchor.js";
import { completion, connectedEngine } from "@table-craft/desktop/renderer/console/completionSource.js";
import { EDITOR_THEME, FLASH_CLASS } from "@table-craft/desktop/renderer/console/editorTheme.js";
import { scrubEditorState } from "@table-craft/desktop/renderer/console/editorPrivacy.js";
import { etcdLanguage } from "@table-craft/desktop/renderer/console/highlighters/etcd.js";
import { redisLanguage } from "@table-craft/desktop/renderer/console/highlighters/redis.js";
import { connectedSignature } from "@table-craft/desktop/renderer/console/signatureHint.js";
import { snippetSource } from "@table-craft/desktop/renderer/console/snippetCompletion.js";
import {
  errorMarks,
  errorMarksOf,
  marksChanged,
  setErrorMarks,
} from "@table-craft/desktop/renderer/console/errorMarks.js";
import { insertionAt, replacementAt } from "@table-craft/desktop/renderer/console/insertion.js";
import { applyEditorJump } from "@table-craft/desktop/renderer/console/editorJump.js";
import {
  connectedInspector,
  inspectionSource,
  refreshInspections,
} from "@table-craft/desktop/renderer/console/inspectionSource.js";
import { inspections } from "@table-craft/desktop/renderer/console/inspections.js";
import { intentions, type IntentionTarget } from "@table-craft/desktop/renderer/console/intentions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import {
  DRAG_OBJECT_TYPE,
  parseDraggedObject,
  type DraggedObject,
} from "@table-craft/desktop/renderer/model/dragObject.js";
import type { ErrorMark } from "@table-craft/desktop/renderer/model/errorLocation.js";
import type { TextSpan } from "@table-craft/desktop/renderer/model/statementAt.js";
import { AUTOFOCUS_ATTRIBUTE } from "@table-craft/desktop/renderer/shell/focus.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { connectionOf, pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { useSnippets } from "@table-craft/desktop/renderer/state/snippets.js";
import { useSnippetsDialog } from "@table-craft/desktop/renderer/state/snippetsDialog.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import { withInspection } from "@table-craft/desktop/settings/settings.js";
import { useCommandTxn } from "./transaction/store.js";

/** The manifest's `highlight` names one of these; anything else gets standard SQL (plan 006 decision 1). */
const DIALECTS: Readonly<Record<string, SQLDialect>> = {
  postgresql: PostgreSQL,
  mysql: MySQL,
  sqlite: SQLite,
  plsql: PLSQL,
  mssql: MSSQL,
};

export const EDITOR_LABEL = "SQL console";
const FLASH_MS = 900;
const EDITOR_MENU_ITEM =
  "flex cursor-default items-center gap-gap rounded px-gap py-1 outline-none data-[highlighted]:bg-raised data-[disabled]:opacity-40";
const CodeIcon = ACTION_ICONS.generate;
/** CodeMirror's `Mod-Enter` inserts a blank line; here it is Run, which the registry owns. */
const REGISTRY_KEYS = new Set(["Mod-Enter"]);

const NO_MARKS: readonly ErrorMark[] = [];
const savedEditors = new Map<string, { readonly state: EditorState; readonly privacyReset: number }>();
useConsoles.subscribe((state, before) => {
  for (const id of savedEditors.keys()) {
    if (state.consoles[id]?.privacyReset !== before.consoles[id]?.privacyReset) savedEditors.delete(id);
  }
});

function restoredEditor(config: EditorStateConfig, saved: EditorState | undefined): EditorState {
  return saved === undefined
    ? EditorState.create(config)
    : EditorState.fromJSON(saved.toJSON({ history: historyField }), config, { history: historyField });
}

const setFlash = StateEffect.define<TextSpan | null>();
const FLASH_MARK = Decoration.mark({ class: FLASH_CLASS });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setFlash)) continue;
      const span = effect.value;
      const length = transaction.state.doc.length;
      const from = Math.min(span?.from ?? 0, length);
      const to = Math.min(span?.to ?? 0, length);
      next = from < to ? Decoration.set([FLASH_MARK.range(from, to)]) : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Command languages the manifest's `highlight` may name instead of a SQL dialect (decision 112). */
const COMMAND_HIGHLIGHTERS: Readonly<Record<string, Extension>> = {
  redis: redisLanguage,
  etcd: etcdLanguage,
};

export function dialectOf(highlight: string | null | undefined): SQLDialect {
  return DIALECTS[highlight ?? ""] ?? StandardSQL;
}

interface EditorLanguage {
  readonly capabilities: readonly string[];
  readonly highlight?: string | null;
}

/** Only SQL-capable datasources receive offline SQL keyword completion. */
export function keywordDialectOf(plugin: EditorLanguage | undefined): SQLDialect | null {
  return plugin?.capabilities.includes("sql") ? dialectOf(plugin.highlight) : null;
}

/** Capabilities select the language family; unknown command languages stay plain text. */
export function highlighterOf(plugin: EditorLanguage | undefined): Extension {
  const dialect = keywordDialectOf(plugin);
  if (dialect !== null) return sql({ dialect, upperCaseKeywords: true });
  return plugin?.capabilities.includes("commands") ? (COMMAND_HIGHLIGHTERS[plugin.highlight ?? ""] ?? []) : [];
}

function placeholderText(plugin: EditorLanguage | undefined): string {
  const shortcut = registry.get(ACTION_IDS.run)?.shortcut;
  const chord = shortcut === undefined ? "" : ` ${formatChord(shortcut, currentPlatform())}`;
  if (keywordDialectOf(plugin) === null) return `Type text;${chord} runs the current selection or command`;
  return `Type SQL;${chord} runs the statement at the caret`;
}

function chordOf(actionId: string): string {
  const shortcut = registry.get(actionId)?.shortcut;
  return shortcut === undefined ? "" : formatChord(shortcut, currentPlatform());
}

/** The Alt+Enter popup's reach outside the editor: the splitter for a suppression, and the settings. */
function intentionTarget(datasourceId: () => string | undefined): IntentionTarget {
  return {
    statements: (text) => {
      const id = datasourceId();
      const datasources = useDatasources.getState();
      if (id === undefined || connectionOf(datasources, id).status !== "connected") return null;
      return datasources.connect(id).then((client) => client.call("script.split", { text }));
    },
    disable: (inspection) =>
      void useSettings.getState().update((current) => withInspection(current, inspection, false)),
    chord: () => chordOf(ERROR_ACTION_IDS.showIntentions),
  };
}

/** Inserts the dropped object's qualified name, asked of its datasource's engine, where it was dropped. */
async function insertQualifiedName(view: EditorView, object: DraggedObject, at: number): Promise<void> {
  let text: string;
  try {
    const client = await useDatasources.getState().connect(object.datasourceId);
    text = await client.call("catalog.qualifiedName", { path: object.path, name: object.name });
  } catch {
    text = object.name;
  }
  if (!view.dom.isConnected) return;
  const from = Math.min(at, view.state.doc.length);
  view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
  view.focus();
}

/**
 * The console's CodeMirror editor. It owns its document while mounted and reports text and
 * selection to the console store; it only takes text back when the store's differs, as when a
 * console is restored.
 */
export function Editor({ consoleId }: { readonly consoleId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const undoRef = useRef(new Compartment());
  const datasource = useConsoleDatasource(consoleId);
  const plugin = useDatasources((state) => pluginOf(state.plugins, datasource?.pluginId ?? ""));
  const text = useConsoles((state) => state.consoles[consoleId]?.sql ?? "");
  const flash = useConsoles((state) => state.consoles[consoleId]?.flash ?? null);
  const jump = useConsoles((state) => state.consoles[consoleId]?.jump ?? null);
  const insertion = useConsoles((state) => state.consoles[consoleId]?.insertion ?? null);
  const replacement = useConsoles((state) => state.consoles[consoleId]?.replacement ?? null);
  const marks = useConsoles((state) => state.consoles[consoleId]?.errorMarks ?? NO_MARKS);
  const namespace = useConsoles((state) => state.consoles[consoleId]?.namespace ?? null);
  const status = useDatasources((state) =>
    datasource === undefined ? null : connectionOf(state, datasource.id).status,
  );
  const inspectionSettings = useSettings((state) => state.settings.editor.inspections);
  const dialectRef = useRef(keywordDialectOf(plugin));
  const selection = useConsoles((state) => state.consoles[consoleId]?.selection);
  const hasSelection = selection !== undefined && selection.from !== selection.to;
  const txnPending = useCommandTxn((state) => state.drafts[consoleId]?.pending ?? null);

  useEffect(() => {
    useCommandTxn.getState().observe(consoleId, text);
  }, [consoleId, text]);

  useEffect(() => {
    void useSnippets.getState().load();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const store = useConsoles.getState();
    for (const id of savedEditors.keys()) {
      if (store.consoles[id] === undefined) savedEditors.delete(id);
    }
    const cached = savedEditors.get(consoleId);
    const privacyReset = store.consoles[consoleId]?.privacyReset ?? 0;
    const saved = cached?.privacyReset === privacyReset ? cached.state : undefined;
    savedEditors.delete(consoleId);
    const datasourceId = () => useConsoles.getState().consoles[consoleId]?.datasourceId;
    const view = new EditorView({
      parent: host,
      state: restoredEditor(
        {
          doc: store.consoles[consoleId]?.sql ?? "",
          selection: {
            anchor: store.consoles[consoleId]?.selection.from ?? 0,
            head: store.consoles[consoleId]?.selection.to ?? 0,
          },
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            undoRef.current.of(history()),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            rectangularSelection(),
            crosshairCursor(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            completion({
              dialect: () => dialectRef.current,
              engine: connectedEngine(datasourceId),
              signature: connectedSignature(datasourceId),
              current: () => useConsoles.getState().consoles[consoleId]?.namespace ?? null,
              snippets: snippetSource({
                snippets: () => useSnippets.getState().snippets,
                plugin: () => {
                  const state = useDatasources.getState();
                  const id = datasourceId();
                  const source = state.datasources.find((item) => item.id === id);
                  return pluginOf(state.plugins, source?.pluginId ?? "");
                },
              }),
            }),
            highlightSelectionMatches(),
            search({ top: false }),
            languageRef.current.of([highlighterOf(plugin), placeholder(placeholderText(plugin))]),
            flashField,
            errorMarks,
            inspections,
            inspectionSource({
              engine: connectedInspector(datasourceId),
              current: () => useConsoles.getState().consoles[consoleId]?.namespace ?? null,
              settings: () => useSettings.getState().settings.editor.inspections,
            }),
            intentions(intentionTarget(datasourceId)),
            EDITOR_THEME,
            keymap.of([
              ...completionKeymap,
              ...closeBracketsKeymap,
              ...defaultKeymap.filter((binding) => binding.key === undefined || !REGISTRY_KEYS.has(binding.key)),
              ...searchKeymap,
              ...historyKeymap,
              indentWithTab,
            ]),
            EditorView.contentAttributes.of({ "aria-label": EDITOR_LABEL, [AUTOFOCUS_ATTRIBUTE]: "" }),
            EditorView.updateListener.of((update) => {
              const consoles = useConsoles.getState();
              if (update.docChanged) consoles.setSql(consoleId, update.state.doc.toString());
              if (marksChanged(update)) consoles.marksMoved(consoleId, errorMarksOf(update.view));
              if (update.docChanged || update.selectionSet) {
                const { from, to } = update.state.selection.main;
                consoles.setSelection(consoleId, { from, to });
                const txn = useCommandTxn.getState();
                const draft = txn.drafts[consoleId];
                if (
                  !update.docChanged &&
                  draft?.open === true &&
                  draft.source !== null &&
                  draft.pending === null &&
                  draft.inserting === null &&
                  (from < draft.source.from || from > draft.source.to)
                )
                  void txn.read(consoleId);
              }
            }),
            EditorView.domEventHandlers({
              drop(event, target) {
                const object = parseDraggedObject(event.dataTransfer?.getData(DRAG_OBJECT_TYPE) ?? "");
                if (object === null) return false;
                event.preventDefault();
                const at =
                  target.posAtCoords({ x: event.clientX, y: event.clientY }) ?? target.state.selection.main.head;
                void insertQualifiedName(target, object, at);
                return true;
              },
            }),
          ],
        },
        saved,
      ),
    });
    viewRef.current = view;
    const untrack = trackEditor(consoleId, view);
    const stopPrivacy = useConsoles.subscribe((state, before) => {
      if (state.consoles[consoleId]?.privacyReset === before.consoles[consoleId]?.privacyReset) return;
      savedEditors.delete(consoleId);
      view.setState(scrubEditorState(view.state, undoRef.current));
    });
    if (useTabs.getState().activeId === consoleId) view.focus();
    return () => {
      untrack();
      stopPrivacy();
      const current = useConsoles.getState().consoles[consoleId];
      if (current !== undefined) savedEditors.set(consoleId, { state: view.state, privacyReset: current.privacyReset });
      view.destroy();
      viewRef.current = null;
    };
    // The dialect is reconfigured below; remounting on it would drop the undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consoleId]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || txnPending === null) return;
    const accepted = view.state.doc.toString() === txnPending.text;
    if (accepted)
      view.dispatch(
        replacementAt(view.state, {
          from: txnPending.from,
          to: txnPending.to,
          before: txnPending.text.slice(txnPending.from, txnPending.to),
          text: txnPending.replacement,
          selection: {
            from: txnPending.from + txnPending.replacement.length,
            to: txnPending.from + txnPending.replacement.length,
          },
          seq: txnPending.sequence,
        }) ?? {},
      );
    useCommandTxn.getState().applied(consoleId, txnPending.sequence, accepted);
  }, [consoleId, txnPending]);

  useEffect(() => {
    dialectRef.current = keywordDialectOf(plugin);
    viewRef.current?.dispatch({
      effects: languageRef.current.reconfigure([highlighterOf(plugin), placeholder(placeholderText(plugin))]),
    });
  }, [plugin]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    const latest = useConsoles.getState().consoles[consoleId]?.sql ?? "";
    if (current !== latest) view.dispatch({ changes: { from: 0, to: current.length, insert: latest } });
  }, [consoleId, text]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || errorMarksOf(view) === marks) return;
    view.dispatch({ effects: setErrorMarks.of(marks) });
  }, [marks]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshInspections.of(null) });
  }, [namespace, status, inspectionSettings]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || flash === null) return;
    view.dispatch({ effects: setFlash.of(flash) });
    const timer = setTimeout(() => {
      if (view.dom.isConnected) view.dispatch({ effects: setFlash.of(null) });
    }, FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || insertion === null) return;
    const from = view.state.selection.main.from;
    view.dispatch(insertionAt(view.state, insertion.text));
    useCommandTxn.getState().inserted(consoleId, insertion.text, from, from + insertion.text.length);
    view.focus();
    useConsoles.getState().inserted(consoleId, insertion.seq);
  }, [consoleId, insertion]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || replacement === null) return;
    const spec = replacementAt(view.state, replacement);
    if (spec !== null) view.dispatch(spec);
    view.focus();
    useConsoles.getState().replaced(consoleId, replacement.seq);
  }, [consoleId, replacement]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || jump === null) return;
    applyEditorJump(
      {
        length: view.state.doc.length,
        select: (anchor) => view.dispatch({ selection: { anchor }, scrollIntoView: true }),
        focus: () => view.focus(),
      },
      consoleId,
      useConsoles.getState(),
      useTabs.getState().activeId === consoleId,
    );
  }, [consoleId, jump]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div ref={hostRef} data-testid="sql-editor" className="h-full min-h-0 overflow-hidden" />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-50 min-w-56 rounded border border-line bg-panel p-1 text-ui text-ink shadow-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!useSnippetsDialog.getState().open) viewRef.current?.focus();
          }}
        >
          {(["cut", "copy", "paste"] as const).map((command) => (
            <ContextMenu.Item
              key={command}
              disabled={command !== "paste" && !hasSelection}
              className={EDITOR_MENU_ITEM}
              onSelect={() => invoke(SNIPPET_ACTION_IDS[command])}
            >
              {command === "cut" ? "Cut" : command === "copy" ? "Copy" : "Paste"}
              <span className="ml-auto font-editor text-ink-muted">
                {formatChord(`Mod+${command === "cut" ? "X" : command === "copy" ? "C" : "V"}`, currentPlatform())}
              </span>
            </ContextMenu.Item>
          ))}
          <ContextMenu.Separator className="my-1 h-px bg-line" />
          <ContextMenu.Item
            disabled={!hasSelection}
            className={EDITOR_MENU_ITEM}
            onSelect={() => invoke(SNIPPET_ACTION_IDS.importSelection)}
          >
            <CodeIcon aria-hidden className="size-icon text-ink-muted" /> Import into Snippet…
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
