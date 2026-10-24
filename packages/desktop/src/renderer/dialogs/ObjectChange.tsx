import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type { DdlScript } from "@table-craft/desktop/engine/protocol.js";
import { Button, Check } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { scriptNotes, scriptText } from "@table-craft/desktop/renderer/model/tableDesign.js";
import {
  OBJECT_CHOICES,
  objectAnswer,
  useModal,
  type ModalItem,
  type ModalRequest,
} from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";

type ObjectChangeRequest = Extract<ModalRequest, { kind: "objectChange" }>;

/** A script as the plugin wrote it for one input, or why it could not. */
export interface ScriptPreview<K, S = DdlScript> {
  readonly key: K;
  readonly script: S | null;
  readonly error: string | null;
}

/**
 * Asks for the script whenever `key` changes, `delayMs` after it last did; stale answers are
 * dropped. A modified table's script re-reads the table, so typing waits for a pause.
 */
export function useScriptPreview<K, S = DdlScript>(
  key: K | null,
  preview: (key: K) => Promise<S>,
  delayMs = 0,
): ScriptPreview<K, S> | null {
  const [shown, setShown] = useState<ScriptPreview<K, S> | null>(null);
  useEffect(() => {
    if (key === null) return;
    let current = true;
    const timer = setTimeout(() => {
      preview(key).then(
        (script) => {
          if (current) setShown({ key, script, error: null });
        },
        (cause: unknown) => {
          if (current) setShown({ key, script: null, error: toError(cause).message });
        },
      );
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, preview, delayMs]);
  return shown;
}

/** The read-only script, what the plugin says about it, or why there is none. */
export function ScriptView({
  script,
  error,
  highlight,
  className,
}: {
  readonly script: DdlScript | null;
  readonly error: string | null;
  readonly highlight: string | null | undefined;
  readonly className: string;
}) {
  return (
    <>
      {error === null ? null : (
        <p role="alert" data-testid="object-error" className="break-words text-danger">
          {error}
        </p>
      )}
      <SqlView
        text={script === null ? "" : scriptText(script)}
        highlight={highlight}
        label="DDL preview"
        testId="object-ddl"
        className={className}
      />
      {script === null ? null : (
        <ul data-testid="object-notes" className="flex flex-col gap-1 text-ink-muted">
          {scriptNotes(script).map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Items({ items }: { readonly items: readonly ModalItem[] }) {
  return (
    <ul className="flex flex-col gap-1 rounded border border-line bg-canvas p-cell">
      {items.map((item, index) => (
        <li key={index} className="flex min-w-0 justify-between gap-gap">
          <code className="truncate font-editor text-editor" title={item.label}>
            {item.label}
          </code>
          <span className="shrink-0 text-ink-muted">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Rename, Truncate, Drop and New Schema (plan 024): what changes, Cascade where it applies and the
 * script that will run. Apply is red when the change destroys data, and waits for the script.
 */
export function ObjectChange({ request }: { readonly request: ObjectChangeRequest }) {
  const answer = useModal((state) => state.answer);
  const [cascade, setCascade] = useState(request.cascade ?? false);
  const shown = useScriptPreview(cascade, request.preview);
  const script = shown?.key === cascade ? shown.script : null;
  const ready = script !== null && script.statements.length > 0;
  const choose = (choice: (typeof OBJECT_CHOICES)[keyof typeof OBJECT_CHOICES]) => {
    if (script !== null) answer(objectAnswer({ choice, script, design: null, cascade }));
  };
  return (
    <form
      className="flex flex-col gap-gap p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) choose(OBJECT_CHOICES.apply);
      }}
    >
      <Dialog.Title className="font-semibold">{request.title}</Dialog.Title>
      <Dialog.Description className={request.destructive ? "text-danger" : undefined}>
        {request.message}
      </Dialog.Description>
      {request.items === undefined ? null : <Items items={request.items} />}
      {request.cascade === null ? null : (
        <Check
          label="Cascade: also drop or empty what depends on it"
          checked={cascade}
          onChange={(checked) => setCascade(checked)}
        />
      )}
      <ScriptView
        script={script}
        error={shown?.key === cascade ? shown.error : null}
        highlight={request.highlight}
        className="h-32 rounded border border-line bg-canvas"
      />
      <div className="flex justify-end gap-gap">
        <Button onClick={() => answer(null)}>Cancel</Button>
        <Button disabled={!ready} onClick={() => choose(OBJECT_CHOICES.console)}>
          Open in Console
        </Button>
        <Button type="submit" autoFocus disabled={!ready} variant={request.destructive ? "danger" : "primary"}>
          {request.confirm}
        </Button>
      </div>
    </form>
  );
}
