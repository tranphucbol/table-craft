import * as Dialog from "@radix-ui/react-dialog";
import { SEGMENT, SEGMENT_GROUP } from "@table-craft/desktop/renderer/ui/Segmented.js";
import { useEffect, useState } from "react";
import { Button, DialogFooter } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  generatorAnswer,
  steppedStatement,
  useModal,
  type ModalRequest,
} from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";

type GeneratorRequest = Extract<ModalRequest, { kind: "generator" }>;

interface Preview {
  readonly statement: string;
  readonly text: string | null;
  readonly error: string | null;
}

/**
 * The SQL Generator's body (plan 010 decision 13): a segmented choice of statement, its text
 * read-only, and the buttons that answer the modal. Every switch asks the engine anew.
 */
export function SqlGenerator({ request }: { readonly request: GeneratorRequest }) {
  const answer = useModal((state) => state.answer);
  const [statement, setStatement] = useState(request.initial);
  const [preview, setPreview] = useState<Preview | null>(null);

  useEffect(() => {
    let current = true;
    request.generate(statement).then(
      (text) => {
        if (current) setPreview({ statement, text, error: null });
      },
      (cause: unknown) => {
        if (current) setPreview({ statement, text: null, error: toError(cause).message });
      },
    );
    return () => {
      current = false;
    };
  }, [request, statement]);

  const ready = preview?.statement === statement && preview.text !== null;
  return (
    <div className="flex flex-col gap-gap p-gap">
      <Dialog.Title className="font-semibold">{request.title}</Dialog.Title>
      <div
        role="radiogroup"
        aria-label="Statement"
        className={SEGMENT_GROUP}
        onKeyDown={(event) => {
          const ids = request.statements.map((choice) => choice.id);
          const next = steppedStatement(ids, statement, event.key);
          if (next === null) return;
          event.preventDefault();
          setStatement(next);
          event.currentTarget.querySelector<HTMLElement>(`[data-statement="${next}"]`)?.focus();
        }}
      >
        {request.statements.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            data-statement={choice.id}
            aria-checked={choice.id === statement}
            autoFocus={choice.id === request.initial}
            tabIndex={choice.id === statement ? 0 : -1}
            className={SEGMENT}
            onClick={() => setStatement(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {preview?.error != null && preview.statement === statement ? (
        <p role="alert" data-testid="generator-error" className="break-words text-danger">
          {preview.error}
        </p>
      ) : null}
      <SqlView
        text={preview?.statement === statement ? (preview.text ?? "") : ""}
        highlight={request.highlight}
        label="Generated SQL"
        testId="generator-preview"
        className="h-60 rounded border border-line bg-canvas"
      />
      <DialogFooter>
        <Button onClick={() => answer(null)}>Close</Button>
        {request.choices.map((choice) => (
          <Button
            key={choice.id}
            disabled={!ready}
            variant={choice.variant ?? "secondary"}
            onClick={() => answer(generatorAnswer(choice.id, statement))}
          >
            {choice.label}
          </Button>
        ))}
      </DialogFooter>
    </div>
  );
}
