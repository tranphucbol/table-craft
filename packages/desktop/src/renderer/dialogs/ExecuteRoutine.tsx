import * as Dialog from "@radix-ui/react-dialog";
import { useId, useMemo, useState } from "react";
import type { RoutineArgument, RoutineCall, RoutineParameter } from "@table-craft/desktop/engine/protocol.js";
import { useScriptPreview } from "@table-craft/desktop/renderer/dialogs/ObjectChange.js";
import { Button, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { initialArguments, ROUTINE_CHOICES, routineAnswer } from "@table-craft/desktop/renderer/model/routineCall.js";
import { useModal, type ModalRequest } from "@table-craft/desktop/renderer/state/modal.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";

type RoutineRequest = Extract<ModalRequest, { kind: "routine" }>;

const NULL_LABEL = "NULL";
const DEFAULT_LABEL = "DEFAULT";
/** Long enough that typing a value asks the engine once per pause, not once per key. */
const PREVIEW_DELAY_MS = 150;

/** What one argument row holds: the typed text survives a NULL or DEFAULT toggle. */
interface Row {
  readonly text: string;
  readonly isNull: boolean;
  readonly isDefault: boolean;
}

function parameterLabel(parameter: RoutineParameter, index: number): string {
  return parameter.name ?? `$${String(index + 1)}`;
}

function typeLabel(parameter: RoutineParameter): string {
  return parameter.mode === "in" ? parameter.type : `${parameter.mode.toUpperCase()} ${parameter.type}`;
}

function argumentOf(row: Row): RoutineArgument {
  if (row.isDefault) return { kind: "default" };
  return { kind: "value", value: row.isNull ? null : row.text };
}

function ArgumentRow({
  label,
  parameter,
  row,
  onChange,
  autoFocus,
}: {
  readonly label: string;
  readonly parameter: RoutineParameter;
  readonly row: Row;
  readonly onChange: (row: Row) => void;
  readonly autoFocus: boolean;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id} className="flex h-row items-center justify-end font-editor text-editor">
        {label}
      </label>
      <span className="flex h-row items-center font-editor text-editor text-ink-muted">{typeLabel(parameter)}</span>
      <div className="flex min-w-0 items-center gap-gap">
        <TextInput
          id={id}
          autoFocus={autoFocus}
          className="min-w-0 flex-1 font-editor text-editor"
          aria-label={`Value of ${label}`}
          disabled={row.isNull || row.isDefault}
          value={row.isNull || row.isDefault ? "" : row.text}
          onChange={(event) => onChange({ ...row, text: event.target.value })}
        />
        <label className="flex shrink-0 items-center gap-cell">
          <input
            type="checkbox"
            aria-label={`${label} is NULL`}
            checked={row.isNull}
            onChange={(event) => onChange({ ...row, isNull: event.target.checked, isDefault: false })}
          />
          {NULL_LABEL}
        </label>
        {parameter.hasDefault ? (
          <label className="flex shrink-0 items-center gap-cell">
            <input
              type="checkbox"
              aria-label={`${label} is DEFAULT`}
              checked={row.isDefault}
              onChange={(event) => onChange({ ...row, isDefault: event.target.checked, isNull: false })}
            />
            {DEFAULT_LABEL}
          </label>
        ) : null}
      </div>
    </>
  );
}

/**
 * Execute Routine (plan 046 decision 3): a row per argument, what comes back, and the call the
 * plugin writes for them. Run (Enter) runs it in a new console; Open in Console only opens it.
 */
export function ExecuteRoutine({ request }: { readonly request: RoutineRequest }) {
  const answer = useModal((state) => state.answer);
  const { routine } = request;
  const [rows, setRows] = useState<readonly Row[]>(() =>
    initialArguments(routine).map((argument) => ({
      text: argument.kind === "value" ? (argument.value ?? "") : "",
      isNull: argument.kind === "value" && argument.value === null,
      isDefault: argument.kind === "default",
    })),
  );
  const args = useMemo(() => rows.map(argumentOf), [rows]);
  const shown = useScriptPreview<readonly RoutineArgument[], RoutineCall>(args, request.preview, PREVIEW_DELAY_MS);
  const call = shown?.key === args ? shown.script : null;
  const error = shown?.key === args ? shown.error : null;
  const choose = (choice: (typeof ROUTINE_CHOICES)[keyof typeof ROUTINE_CHOICES]) => {
    if (call !== null) answer(routineAnswer({ choice, call }));
  };
  const inputs = routine.parameters.flatMap((parameter, index) => (parameter.mode === "out" ? [] : [index]));
  return (
    <form
      className="flex flex-col gap-gap p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        choose(ROUTINE_CHOICES.run);
      }}
    >
      <Dialog.Title className="font-semibold">{request.title}</Dialog.Title>
      <Dialog.Description className="break-words">{request.note}</Dialog.Description>
      {inputs.length === 0 ? (
        <p className="text-ink-muted">It takes no arguments.</p>
      ) : (
        <div role="group" aria-label="Arguments" className="grid grid-cols-[auto_auto_1fr] gap-x-gap gap-y-1">
          {inputs.map((index, position) => {
            const parameter = routine.parameters[index];
            const row = rows[index];
            if (parameter === undefined || row === undefined) return null;
            return (
              <ArgumentRow
                key={index}
                label={parameterLabel(parameter, index)}
                parameter={parameter}
                row={row}
                autoFocus={position === 0}
                onChange={(next) => setRows((current) => current.map((old, at) => (at === index ? next : old)))}
              />
            );
          })}
        </div>
      )}
      {error === null ? null : (
        <p role="alert" data-testid="routine-error" className="break-words text-danger">
          {error}
        </p>
      )}
      <SqlView
        text={call?.sql ?? ""}
        highlight={request.highlight}
        label="SQL preview"
        testId="routine-sql"
        className="h-24 rounded border border-line bg-canvas"
      />
      {request.warnings.map((warning) => (
        <p key={warning} role="note" className="break-words text-warning">
          {warning}
        </p>
      ))}
      <div className="flex justify-end gap-gap">
        <Button onClick={() => answer(null)}>Cancel</Button>
        <Button disabled={call === null} onClick={() => choose(ROUTINE_CHOICES.console)}>
          Open in Console
        </Button>
        <Button type="submit" variant="primary" disabled={call === null}>
          Run
        </Button>
      </div>
    </form>
  );
}
