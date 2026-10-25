import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { MSSQL, MySQL, PLSQL, PostgreSQL, sql, SQLite, StandardSQL, type SQLDialect } from "@codemirror/lang-sql";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
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
import { useEffect, useRef } from "react";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { ERROR_ACTION_IDS } from "@table-craft/desktop/renderer/actions/errorActions.js";
import { currentPlatform, formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { registry } from "@table-craft/desktop/renderer/actions/index.js";
import { trackEditor } from "@table-craft/desktop/renderer/console/caretAnchor.js";
import { completion, connectedEngine } from "@table-craft/desktop/renderer/console/completionSource.js";
import { EDITOR_THEME, FLASH_CLASS } from "@table-craft/desktop/renderer/console/editorTheme.js";
import { redisLanguage } from "@table-craft/desktop/renderer/console/highlighters/redis.js";
import { connectedSignature } from "@table-craft/desktop/renderer/console/signatureHint.js";
import {
  errorMarks,
  errorMarksOf,
  marksChanged,
  setErrorMarks,
} from "@table-craft/desktop/renderer/console/errorMarks.js";
import { insertionAt, replacementAt } from "@table-craft/desktop/renderer/console/insertion.js";
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
import { withInspection } from "@table-craft/desktop/settings/settings.js";

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
/** CodeMirror's `Mod-Enter` inserts a blank line; here it is Run, which the registry owns. */
const REGISTRY_KEYS = new Set(["Mod-Enter"]);

const NO_MARKS: readonly ErrorMark[] = [];

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
const COMMAND_HIGHLIGHTERS: Readonly<Record<string, Extension>> = { redis: redisLanguage };

export function dialectOf(highlight: string | null | undefined): SQLDialect {
  return DIALECTS[highlight ?? ""] ?? StandardSQL;
}

/** The SQL dialect whose keywords complete offline; null for a command language. */
export function keywordDialectOf(highlight: string | null | undefined): SQLDialect | null {
  return COMMAND_HIGHLIGHTERS[highlight ?? ""] === undefined ? dialectOf(highlight) : null;
}

/** The editor's language for the manifest's `highlight`: a command language, else a SQL dialect. */
export function highlighterOf(highlight: string | null | undefined): Extension {
  return COMMAND_HIGHLIGHTERS[highlight ?? ""] ?? sql({ dialect: dialectOf(highlight), upperCaseKeywords: true });
}

function placeholderText(): string {
  const shortcut = registry.get(ACTION_IDS.run)?.shortcut;
  const chord = shortcut === undefined ? "" : ` ${formatChord(shortcut, currentPlatform())}`;
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
  const datasource = useConsoleDatasource(consoleId);
  const highlight = useDatasources((state) => pluginOf(state.plugins, datasource?.pluginId ?? "")?.highlight);
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
  const dialectRef = useRef(keywordDialectOf(highlight));

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const store = useConsoles.getState();
    const datasourceId = () => useConsoles.getState().consoles[consoleId]?.datasourceId;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: store.consoles[consoleId]?.sql ?? "",
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
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
          }),
          highlightSelectionMatches(),
          search({ top: false }),
          placeholder(placeholderText()),
          languageRef.current.of(highlighterOf(highlight)),
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
            }
          }),
          EditorView.domEventHandlers({
            drop(event, target) {
              const object = parseDraggedObject(event.dataTransfer?.getData(DRAG_OBJECT_TYPE) ?? "");
              if (object === null) return false;
              event.preventDefault();
              const at = target.posAtCoords({ x: event.clientX, y: event.clientY }) ?? target.state.selection.main.head;
              void insertQualifiedName(target, object, at);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    const untrack = trackEditor(consoleId, view);
    // Each tab mounts its own console, so focus follows the tab the user just chose.
    view.focus();
    return () => {
      untrack();
      view.destroy();
      viewRef.current = null;
    };
    // The dialect is reconfigured below; remounting on it would drop the undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consoleId]);

  useEffect(() => {
    dialectRef.current = keywordDialectOf(highlight);
    viewRef.current?.dispatch({ effects: languageRef.current.reconfigure(highlighterOf(highlight)) });
  }, [highlight]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current !== text) view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
  }, [text]);

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
    view.dispatch(insertionAt(view.state, insertion.text));
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
    const anchor = Math.min(jump.from, view.state.doc.length);
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    view.focus();
  }, [jump]);

  return <div ref={hostRef} data-testid="sql-editor" className="h-full min-h-0 overflow-hidden" />;
}
