import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { SNIPPET_ACTION_IDS } from "@table-craft/desktop/renderer/actions/snippetActions.js";
import {
  Button,
  CONTENT_CLASS,
  FieldRow,
  INPUT_CLASS,
  OVERLAY_CLASS,
  TextInput,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import { focusRegion } from "@table-craft/desktop/renderer/shell/focus.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useSnippets } from "@table-craft/desktop/renderer/state/snippets.js";
import {
  snippetDraftDirty,
  snippetScopeLabel,
  snippetScopeOptions,
  snippetScopeValue,
  useSnippetsDialog,
} from "@table-craft/desktop/renderer/state/snippetsDialog.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

const PLACEHOLDER_HELP =
  "Use ${name} for an editable placeholder. Repeated names stay linked. ${cursor} marks the final stop. After insertion, Tab and Shift+Tab move between placeholders.";

function change(patch: Partial<Pick<TextSnippet, "name" | "prefix" | "scope" | "body">>): void {
  invoke(SNIPPET_ACTION_IDS.change, patch);
}

function SnippetForm({
  draft,
  disabled,
  isNew,
}: {
  readonly draft: TextSnippet;
  readonly disabled: boolean;
  readonly isNew: boolean;
}) {
  const plugins = useDatasources((state) => state.plugins);
  const name = useRef<HTMLInputElement>(null);
  const scopes = snippetScopeOptions(plugins, draft.scope);
  useEffect(() => {
    if (isNew) name.current?.focus();
  }, [draft.id, isNew]);

  return (
    <fieldset disabled={disabled} className="flex min-h-0 min-w-0 flex-1 flex-col gap-gap overflow-y-auto p-gap">
      <div className="grid grid-cols-[6rem_1fr] items-center gap-x-gap gap-y-1">
        <FieldRow label="Name" htmlFor="snippet-name">
          <input
            ref={name}
            id="snippet-name"
            className={cn(INPUT_CLASS, "flex-1")}
            value={draft.name}
            spellCheck={false}
            onChange={(event) => change({ name: event.target.value })}
          />
        </FieldRow>
        <FieldRow label="Prefix" htmlFor="snippet-prefix">
          <TextInput
            id="snippet-prefix"
            className="flex-1 font-editor"
            value={draft.prefix}
            placeholder="e.g. my_snippet"
            aria-describedby="snippet-prefix-help"
            onChange={(event) => change({ prefix: event.target.value })}
          />
        </FieldRow>
        <p id="snippet-prefix-help" className="col-start-2 text-ink-muted">
          Type this prefix in a matching text console to find the snippet in completion.
        </p>
        <FieldRow label="Applies to" htmlFor="snippet-scope">
          <select
            id="snippet-scope"
            className={cn(INPUT_CLASS, "flex-1")}
            value={snippetScopeValue(draft.scope)}
            onChange={(event) => {
              const selected = scopes.find((option) => option.value === event.target.value);
              if (selected !== undefined) change({ scope: selected.scope });
            }}
          >
            {scopes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FieldRow>
      </div>
      <label htmlFor="snippet-body" className="font-semibold text-ink-muted">
        Snippet body
      </label>
      <textarea
        id="snippet-body"
        className="min-h-24 flex-1 resize-y rounded border border-line bg-canvas p-cell font-editor text-editor text-ink outline-none focus:border-accent disabled:opacity-60"
        rows={5}
        spellCheck={false}
        value={draft.body}
        aria-describedby="snippet-placeholder-help"
        onChange={(event) => change({ body: event.target.value })}
      />
      <p id="snippet-placeholder-help" className="text-ink-muted">
        {PLACEHOLDER_HELP}
      </p>
      <section aria-label="Snippet preview" className="flex min-h-0 flex-col gap-1">
        <h3 className="border-b border-line pb-1 font-semibold text-ink-muted">Preview</h3>
        <pre
          aria-label="Snippet preview"
          tabIndex={0}
          data-testid="snippet-preview"
          className="h-24 shrink-0 overflow-auto rounded border border-line bg-canvas p-cell font-editor text-editor whitespace-pre-wrap"
        >
          {draft.body}
        </pre>
      </section>
    </fieldset>
  );
}

function SnippetsEditor() {
  const plugins = useDatasources((state) => state.plugins);
  const { draft, original, query, working, problem } = useSnippetsDialog();
  const { snippets, busy, loaded, error } = useSnippets();
  const disabled = working || busy;
  const dirty = snippetDraftDirty({ draft, original });
  const needle = query.trim().toLocaleLowerCase();
  const listed = snippets.map((snippet) => (snippet.id === draft?.id ? draft : snippet));
  if (draft !== null && original === null) listed.push(draft);
  const matches = listed.filter((snippet) =>
    [snippet.name, snippet.prefix, snippet.body, snippetScopeLabel(snippet.scope, plugins)].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    ),
  );
  const message = problem ?? error;

  return (
    <>
      <Dialog.Title className="shrink-0 border-b border-line px-gap py-cell font-semibold">Snippets</Dialog.Title>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Snippet library" className="flex w-dialog-list shrink-0 flex-col border-r border-line">
          <div className="flex flex-col gap-gap p-gap">
            <TextInput
              autoFocus
              aria-label="Search snippets"
              placeholder="Search snippets"
              value={query}
              disabled={disabled}
              onChange={(event) => invoke(SNIPPET_ACTION_IDS.search, event.target.value)}
            />
            <Button disabled={disabled || !loaded} onClick={() => invoke(SNIPPET_ACTION_IDS.new)}>
              New Snippet
            </Button>
          </div>
          <nav aria-label="Snippets" className="min-h-0 flex-1 overflow-y-auto p-1">
            {matches.map((snippet) => (
              <button
                key={snippet.id}
                type="button"
                aria-current={snippet.id === draft?.id ? "true" : undefined}
                disabled={disabled}
                className={cn(
                  "flex w-full flex-col rounded px-cell py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60",
                  snippet.id === draft?.id ? "bg-selection" : "hover:bg-raised",
                )}
                onClick={() => invoke(SNIPPET_ACTION_IDS.select, snippet.id)}
              >
                <span className="w-full truncate">
                  {snippet.name || "Untitled snippet"}
                  {snippet.id === draft?.id && dirty ? " *" : ""}
                </span>
                <span className="w-full truncate font-editor text-ink-muted">{snippet.prefix || "No prefix yet"}</span>
              </button>
            ))}
            {matches.length === 0 ? (
              <p className="p-cell text-ink-muted">
                {disabled && !loaded
                  ? "Loading snippets…"
                  : needle !== ""
                    ? "No matching snippets."
                    : "No snippets yet."}
              </p>
            ) : null}
          </nav>
          <p className="border-t border-line px-gap py-cell text-ink-muted">
            {listed.length} {listed.length === 1 ? "snippet" : "snippets"}
          </p>
        </aside>
        {draft === null ? (
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-gap p-gap text-center">
            <h3 className="font-semibold">Your text, ready to reuse</h3>
            <p className="max-w-popover text-ink-muted">
              Save text with a short prefix, then insert it from completion in any matching text console.
            </p>
            <p className="text-ink-muted">Choose a snippet or select New Snippet to get started.</p>
          </div>
        ) : (
          <SnippetForm draft={draft} disabled={disabled} isNew={original === null} />
        )}
      </div>
      {message === null ? null : (
        <div className="flex shrink-0 items-center gap-gap border-t border-line px-gap py-cell">
          <p role="alert" className="min-w-0 flex-1 text-danger">
            {message}
          </p>
          {error !== null ? (
            <Button disabled={disabled} onClick={() => invoke(SNIPPET_ACTION_IDS.reload)}>
              Retry Load
            </Button>
          ) : null}
          <Button disabled={disabled} onClick={() => invoke(SNIPPET_ACTION_IDS.dismissError)}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-gap border-t border-line p-gap">
        <Button
          variant="danger"
          disabled={disabled || draft === null}
          onClick={() => invoke(SNIPPET_ACTION_IDS.delete)}
        >
          Delete…
        </Button>
        <span role="status" aria-live="polite" className="min-w-0 flex-1 text-ink-muted">
          {disabled ? "Please wait…" : dirty ? "Unsaved changes" : "Saved in this TableCraft profile."}
        </span>
        <Button variant="primary" disabled={disabled || !dirty} onClick={() => invoke(SNIPPET_ACTION_IDS.save)}>
          Save
        </Button>
        <Button disabled={disabled} onClick={() => invoke(SNIPPET_ACTION_IDS.close)}>
          Close
        </Button>
      </div>
    </>
  );
}

export function SnippetsDialog() {
  const open = useSnippetsDialog((state) => state.open);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) invoke(SNIPPET_ACTION_IDS.close);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            CONTENT_CLASS,
            "flex h-dialog-height max-h-[95vh] w-dialog max-w-[95vw] flex-col overflow-hidden",
          )}
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = useSnippetsDialog.getState().returnFocus;
            if (target?.isConnected) target.focus();
            else focusRegion("editor");
          }}
        >
          {open ? <SnippetsEditor /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
