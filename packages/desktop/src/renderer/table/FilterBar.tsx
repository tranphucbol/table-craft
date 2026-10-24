import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { CompletionScope } from "@table-craft/desktop/engine/protocol.js";
import { completion, connectedEngine } from "@table-craft/desktop/renderer/console/completionSource.js";
import { dialectOf } from "@table-craft/desktop/renderer/console/Editor.js";
import { EDITOR_THEME } from "@table-craft/desktop/renderer/console/editorTheme.js";
import { connectedSignature } from "@table-craft/desktop/renderer/console/signatureHint.js";

/** Chords CodeMirror would take that belong to the registry here: ⌘↵ is Submit. */
const REGISTRY_KEYS = new Set(["Mod-Enter"]);

export interface FilterBarProps {
  /** `WHERE` or `ORDER BY`, shown before the field and naming it. */
  readonly label: string;
  readonly value: string;
  readonly placeholderText: string;
  /** The plugin's highlight dialect name. */
  readonly highlight: string | null | undefined;
  readonly invalid: boolean;
  /** The datasource and relation the bar filters; completion offers that relation's columns. */
  readonly datasourceId: string;
  readonly scope: CompletionScope;
  readonly onChange: (text: string) => void;
  readonly onApply: () => void;
  readonly onRevert: () => void;
}

/**
 * One line of SQL sent verbatim after `WHERE` or `ORDER BY` (plan 008 decision 4): Enter applies,
 * Escape puts back what the rows were read with. While the completion popup is open, Enter, Tab
 * and Escape are its own.
 */
export function FilterBar({
  label,
  value,
  placeholderText,
  highlight,
  invalid,
  datasourceId,
  scope,
  onChange,
  onApply,
  onRevert,
}: FilterBarProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onApply, onRevert });
  useEffect(() => {
    handlers.current = { onChange, onApply, onRevert };
  });
  const { path, relation } = scope;
  const pathKey = JSON.stringify(path);

  useEffect(() => {
    if (host.current === null) return;
    const dialect = dialectOf(highlight);
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: "",
        extensions: [
          EDITOR_THEME,
          history(),
          sql({ dialect, upperCaseKeywords: true }),
          completion({
            dialect: () => dialect,
            engine: connectedEngine(() => datasourceId),
            signature: connectedSignature(() => datasourceId),
            scope: { path: JSON.parse(pathKey) as readonly string[], relation },
          }),
          placeholder(placeholderText),
          // One line: the clause is pasted into a single SELECT, and Enter applies it.
          EditorState.transactionFilter.of((transaction) => (transaction.newDoc.lines > 1 ? [] : transaction)),
          keymap.of([
            { key: "Enter", run: () => (handlers.current.onApply(), true) },
            { key: "Escape", run: () => (handlers.current.onRevert(), true) },
            ...defaultKeymap.filter((binding) => binding.key === undefined || !REGISTRY_KEYS.has(binding.key)),
            ...historyKeymap,
          ]),
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [highlight, label, placeholderText, datasourceId, pathKey, relation]);

  useEffect(() => {
    const current = view.current;
    if (current === null || current.state.doc.toString() === value) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value, highlight, datasourceId, pathKey, relation]);

  return (
    <div
      data-invalid={invalid}
      data-testid={`filter-${label.toLowerCase().replace(" ", "-")}`}
      className="flex min-w-0 flex-1 items-center gap-cell rounded border border-line bg-canvas px-cell data-[invalid=true]:border-danger"
    >
      <span className="shrink-0 font-editor text-editor text-ink-muted">{label}</span>
      <div ref={host} className="min-w-0 flex-1" />
    </div>
  );
}
