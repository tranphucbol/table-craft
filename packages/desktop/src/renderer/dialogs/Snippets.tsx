import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { SNIPPET_ACTION_IDS } from "@table-craft/desktop/renderer/actions/snippetActions.js";
import {
  Button,
  CONTENT_CLASS,
  INPUT_CLASS,
  OVERLAY_CLASS,
  TextInput,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import { focusRegion } from "@table-craft/desktop/renderer/shell/focus.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useSnippets } from "@table-craft/desktop/renderer/state/snippets.js";
import {
  snippetDraftDirty,
  snippetFieldProblems,
  snippetScopeLabel,
  snippetScopeOptions,
  snippetScopeValue,
  useSnippetsDialog,
} from "@table-craft/desktop/renderer/state/snippetsDialog.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";
import { snippetPreview } from "@table-craft/desktop/renderer/console/snippetCompletion.js";

const PLACEHOLDER_HELP =
  "Use ${name} for an editable placeholder. Repeated names stay linked. ${cursor} marks the final stop. After insertion, Tab and Shift+Tab move between placeholders.";

function change(patch: Partial<Pick<TextSnippet, "name" | "prefix" | "scope" | "body">>): void {
  invoke(SNIPPET_ACTION_IDS.change, patch);
}

function SnippetForm({
  draft,
  disabled,
  isNew,
  compact = false,
}: {
  readonly draft: TextSnippet;
  readonly disabled: boolean;
  readonly isNew: boolean;
  readonly compact?: boolean;
}) {
  const plugins = useDatasources((state) => state.plugins);
  const name = useRef<HTMLInputElement>(null);
  const scopes = snippetScopeOptions(plugins, draft.scope);
  const validated = useSnippetsDialog((state) => state.validated);
  const snippets = useSnippets((state) => state.snippets);
  const problems = validated ? snippetFieldProblems(draft, snippets) : {};
  useEffect(() => {
    if (isNew && !disabled) name.current?.focus();
  }, [draft.id, isNew, disabled]);

  return (
    <fieldset
      disabled={disabled}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-gap overflow-y-auto bg-canvas p-gap"
    >
      <div className="flex flex-col gap-gap">
        <label className="flex flex-col gap-1 text-ink-muted" htmlFor="snippet-name">
          Name
          <input
            ref={name}
            id="snippet-name"
            className={cn(INPUT_CLASS, "bg-raised")}
            value={draft.name}
            placeholder="Snippet name"
            aria-invalid={problems.name !== undefined}
            spellCheck={false}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
        <div className={cn("grid min-w-0 gap-gap", !compact && "grid-cols-2")}>
          <label className="flex min-w-0 flex-col gap-1 text-ink-muted" htmlFor="snippet-prefix">
            Prefix
            <TextInput
              id="snippet-prefix"
              className="bg-raised font-editor"
              value={draft.prefix}
              placeholder="e.g. my_snippet"
              aria-invalid={problems.prefix !== undefined}
              onChange={(event) => change({ prefix: event.target.value })}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-ink-muted" htmlFor="snippet-scope">
            Applies to
            <Dropdown
              id="snippet-scope"
              label="Applies to"
              variant="field"
              className="bg-raised"
              value={snippetScopeValue(draft.scope)}
              invalid={problems.scope !== undefined}
              options={scopes}
              onChange={(value) => {
                const selected = scopes.find((option) => option.value === value);
                if (selected !== undefined) change({ scope: selected.scope });
              }}
            />
          </label>
        </div>
      </div>
      <label htmlFor="snippet-body" className="font-semibold text-ink-muted">
        Snippet body
      </label>
      <textarea
        id="snippet-body"
        className={cn(
          "min-h-24 resize-y rounded border border-line bg-raised p-cell font-editor text-editor text-ink outline-none focus:border-accent disabled:opacity-60 aria-invalid:border-danger",
          !compact && "flex-1",
        )}
        rows={5}
        spellCheck={false}
        value={draft.body}
        placeholder="Type snippet body with ${placeholders}…"
        aria-invalid={problems.body !== undefined}
        aria-describedby="snippet-placeholder-help"
        onChange={(event) => change({ body: event.target.value })}
      />
      <span id="snippet-placeholder-help" className="sr-only">
        {PLACEHOLDER_HELP}
      </span>
      <section aria-label="Snippet preview" className="flex min-h-0 flex-col gap-1">
        <h3 className="font-semibold text-ink-muted">Preview</h3>
        <pre
          aria-label="Snippet preview"
          tabIndex={0}
          data-testid="snippet-preview"
          className="min-h-8 max-h-24 shrink-0 overflow-auto rounded border border-line bg-raised p-cell font-editor text-editor whitespace-pre-wrap text-ink-muted"
        >
          {snippetPreview(draft.body) || "(empty)"}
        </pre>
      </section>
    </fieldset>
  );
}

function SnippetsEditor() {
  const plugins = useDatasources((state) => state.plugins);
  const { draft, original, query, working, problem, validated, errorDismissed, importConsoleId } = useSnippetsDialog();
  const { snippets, busy, loaded, error } = useSnippets();
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (loaded && importConsoleId === null) search.current?.focus();
  }, [loaded, importConsoleId]);
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
  const invalid = draft === null ? {} : snippetFieldProblems(draft, snippets);
  const message = (!errorDismissed && validated ? Object.values(invalid)[0] : null) ?? problem ?? error;
  const saveDisabled = disabled || !loaded || !dirty || (validated && Object.keys(invalid).length > 0);

  if (importConsoleId !== null && draft !== null)
    return (
      <>
        <Dialog.Title className="px-gap pt-gap font-semibold">Import into Snippet</Dialog.Title>
        <SnippetForm draft={draft} disabled={disabled} isNew compact />
        {message === null ? null : (
          <div className="flex items-center gap-gap border-t border-danger bg-danger/10 px-gap py-cell">
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
        <div className="flex shrink-0 justify-end gap-gap p-gap">
          <Button disabled={disabled} onClick={() => invoke(SNIPPET_ACTION_IDS.cancelImport)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saveDisabled} onClick={() => invoke(SNIPPET_ACTION_IDS.save)}>
            Create Snippet
          </Button>
        </div>
      </>
    );

  return (
    <>
      <Dialog.Title className="shrink-0 border-b border-line px-gap py-cell text-center font-semibold text-ink-muted">
        Snippets
      </Dialog.Title>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Snippet library" className="flex w-dialog-list shrink-0 flex-col border-r border-line">
          <div className="border-b border-line p-cell">
            <input
              ref={search}
              autoFocus
              aria-label="Search snippets"
              placeholder="Search snippets"
              value={query}
              disabled={disabled || listed.length === 0}
              onChange={(event) => invoke(SNIPPET_ACTION_IDS.search, event.target.value)}
              className={cn(INPUT_CLASS, "w-full bg-raised")}
              spellCheck={false}
            />
          </div>
          <div className="border-b border-line p-cell">
            <Button
              variant="primary"
              aria-label="New Snippet"
              className="w-full"
              disabled={disabled || !loaded}
              onClick={() => invoke(SNIPPET_ACTION_IDS.new)}
            >
              + New Snippet
            </Button>
          </div>
          <div className="flex gap-cell border-b border-line p-cell">
            <Button className="flex-1 bg-raised" disabled={disabled} onClick={() => invoke(SNIPPET_ACTION_IDS.import)}>
              Import…
            </Button>
            <Button
              className="flex-1 bg-raised"
              disabled={disabled || snippets.length === 0}
              onClick={() => invoke(SNIPPET_ACTION_IDS.export)}
            >
              Export…
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
                <span className="w-full truncate font-medium">
                  {snippet.name || "Untitled snippet"}
                  {snippet.id === draft?.id && dirty ? <span className="text-danger"> *</span> : null}
                </span>
                <span className="w-full truncate font-editor text-ink-muted">{snippet.prefix || "—"}</span>
                <span className="w-full truncate text-accent">{snippetScopeLabel(snippet.scope, plugins)}</span>
              </button>
            ))}
            {matches.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-1 p-cell text-center text-ink-muted">
                <p>
                  {disabled && !loaded
                    ? "Loading snippets…"
                    : needle !== ""
                      ? "No matching snippets."
                      : "No snippets yet."}
                </p>
                {!disabled && needle === "" ? <p>Create one or import from file</p> : null}
              </div>
            ) : null}
          </nav>
        </aside>
        {draft === null ? (
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-gap bg-canvas p-gap text-center text-ink-muted">
            <p>Select a snippet or create a new one</p>
            <p>Prefix activates completion in matching consoles</p>
          </div>
        ) : (
          <SnippetForm draft={draft} disabled={disabled} isNew={original === null} />
        )}
      </div>
      {message === null ? null : (
        <div className="flex shrink-0 items-center gap-gap border-t border-danger bg-danger/10 px-gap py-cell">
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
        <span
          role="status"
          aria-live="polite"
          className={cn("min-w-0 flex-1", dirty ? "text-danger" : "text-ink-muted")}
        >
          {disabled ? "Please wait…" : dirty ? "Unsaved changes" : "Saved in this TableCraft profile."}
        </span>
        <Button
          variant="dangerOutline"
          disabled={disabled || original === null}
          onClick={() => invoke(SNIPPET_ACTION_IDS.delete)}
        >
          Delete…
        </Button>
        <Button
          variant={dirty ? "primary" : "secondary"}
          disabled={saveDisabled}
          onClick={() => invoke(SNIPPET_ACTION_IDS.save)}
        >
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
  const importing = useSnippetsDialog((state) => state.importConsoleId !== null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) invoke(importing ? SNIPPET_ACTION_IDS.cancelImport : SNIPPET_ACTION_IDS.close);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            CONTENT_CLASS,
            "flex max-h-[95vh] max-w-[95vw] flex-col overflow-hidden",
            importing ? "w-popover" : "h-dialog-height w-dialog",
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
