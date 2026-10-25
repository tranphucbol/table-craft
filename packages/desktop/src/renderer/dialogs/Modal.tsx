import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { LOG_ACTION_IDS } from "@table-craft/desktop/renderer/actions/logActions.js";
import { Button, CONTENT_CLASS, OVERLAY_CLASS, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { useModal, type ModalItem, type ModalRequest } from "@table-craft/desktop/renderer/state/modal.js";
import { ExecuteRoutine } from "@table-craft/desktop/renderer/dialogs/ExecuteRoutine.js";
import { ExportData } from "@table-craft/desktop/renderer/dialogs/ExportData.js";
import { ImportData } from "@table-craft/desktop/renderer/dialogs/ImportData.js";
import { ObjectChange } from "@table-craft/desktop/renderer/dialogs/ObjectChange.js";
import { OpenClosedConsole } from "@table-craft/desktop/renderer/dialogs/OpenClosedConsole.js";
import { Pick } from "@table-craft/desktop/renderer/dialogs/Pick.js";
import { ParametersDialog } from "@table-craft/desktop/renderer/dialogs/ParametersDialog.js";
import { QueryHistory } from "@table-craft/desktop/renderer/dialogs/QueryHistory.js";
import { SqlGenerator } from "@table-craft/desktop/renderer/dialogs/SqlGenerator.js";
import { TableDesigner } from "@table-craft/desktop/renderer/dialogs/TableDesigner.js";
import { PreviewStatements } from "@table-craft/desktop/renderer/table/PreviewDialog.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const MODAL_WIDTHS: Readonly<Record<ModalRequest["kind"], string>> = {
  confirm: "w-96",
  text: "w-96",
  notice: "w-96",
  choice: "w-96",
  statements: "w-[40rem]",
  generator: "w-generator",
  history: "w-picker",
  closedConsoles: "w-picker",
  pick: "w-picker",
  parameters: "w-[40rem]",
  export: "w-generator",
  import: "w-dialog",
  tableDesign: "w-dialog",
  objectChange: "w-[40rem]",
  routine: "w-[40rem]",
};

type PickerKind =
  | "generator"
  | "history"
  | "closedConsoles"
  | "pick"
  | "parameters"
  | "export"
  | "import"
  | "tableDesign"
  | "objectChange"
  | "routine";

function Items({ items }: { readonly items: readonly ModalItem[] }) {
  return (
    <ul className="flex max-h-60 flex-col gap-1 overflow-auto rounded border border-line bg-canvas p-cell">
      {items.map((item, index) => (
        <li key={index} className="flex min-w-0 flex-col">
          <code className="truncate font-editor text-editor" title={item.label}>
            {item.label}
          </code>
          {item.detail === "" ? null : (
            <span className={item.tone === "info" ? "text-ink-muted" : "text-danger"}>{item.detail}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Body({ request }: { readonly request: Exclude<ModalRequest, { kind: PickerKind }> }) {
  const answer = useModal((state) => state.answer);
  const [text, setText] = useState(request.kind === "text" ? request.initial : "");
  const typed = request.kind === "confirm" ? request.typed : undefined;
  const blocked = typed !== undefined && text !== typed;

  return (
    <form
      className="flex flex-col gap-gap p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        if (request.kind === "choice") answer(request.choices[0]?.id ?? null);
        else answer(request.kind === "text" ? text : "");
      }}
    >
      <Dialog.Title className="font-semibold">{request.title}</Dialog.Title>
      {request.kind === "text" ? (
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">{request.label}</span>
          <TextInput
            autoFocus
            aria-label={request.label}
            placeholder={request.placeholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      ) : (
        <Dialog.Description className={cn(request.kind === "notice" && request.tone !== "info" && "text-danger")}>
          {request.message}
          {request.kind === "notice" ? <span className="block text-ink-muted">{request.hint}</span> : null}
        </Dialog.Description>
      )}
      {(request.kind === "confirm" || request.kind === "choice") && request.items !== undefined ? (
        <Items items={request.items} />
      ) : null}
      {typed === undefined ? null : (
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">
            Type <code className="font-editor text-editor">{typed}</code> to confirm
          </span>
          <TextInput
            autoFocus
            aria-label={`Type ${typed} to confirm`}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
      )}
      {request.kind === "statements" ? (
        <PreviewStatements statements={request.statements} terminator={request.terminator ?? ";"} />
      ) : null}
      <div className="flex justify-end gap-gap">
        {request.kind === "notice" ? (
          request.tone === "info" ? null : (
            <Button
              onClick={() => {
                answer(null);
                void invoke(LOG_ACTION_IDS.showFor, { requestId: request.requestId ?? null, message: request.message });
              }}
            >
              Show in Log
            </Button>
          )
        ) : (
          <Button onClick={() => answer(null)}>Cancel</Button>
        )}
        {request.kind === "choice" ? (
          request.choices.map((choice, index) => (
            <Button
              key={choice.id}
              type={index === 0 ? "submit" : "button"}
              autoFocus={index === 0}
              variant={choice.variant ?? "secondary"}
              onClick={index === 0 ? undefined : () => answer(choice.id)}
            >
              {choice.label}
            </Button>
          ))
        ) : (
          <Button
            type="submit"
            autoFocus={request.kind !== "text" && typed === undefined}
            disabled={blocked}
            variant={request.kind === "confirm" && request.destructive === true ? "danger" : "primary"}
          >
            {request.kind === "notice" ? "OK" : request.confirm}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Confirmations, choices, one-line prompts and notices; actions ask through `useModal`. */
export function Modal() {
  const pending = useModal((state) => state.pending);
  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) useModal.getState().answer(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(CONTENT_CLASS, MODAL_WIDTHS[pending?.request.kind ?? "confirm"], "max-w-[90vw]")}
        >
          {pending === null ? null : pending.request.kind === "generator" ? (
            <SqlGenerator request={pending.request} />
          ) : pending.request.kind === "history" ? (
            <QueryHistory request={pending.request} />
          ) : pending.request.kind === "closedConsoles" ? (
            <OpenClosedConsole request={pending.request} />
          ) : pending.request.kind === "pick" ? (
            <Pick request={pending.request} />
          ) : pending.request.kind === "parameters" ? (
            <ParametersDialog request={pending.request} />
          ) : pending.request.kind === "export" ? (
            <ExportData request={pending.request} />
          ) : pending.request.kind === "import" ? (
            <ImportData request={pending.request} />
          ) : pending.request.kind === "tableDesign" ? (
            <TableDesigner request={pending.request} />
          ) : pending.request.kind === "objectChange" ? (
            <ObjectChange request={pending.request} />
          ) : pending.request.kind === "routine" ? (
            <ExecuteRoutine request={pending.request} />
          ) : (
            <Body request={pending.request} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
