import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button, CONTENT_CLASS, OVERLAY_CLASS, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import type { SecretMode } from "@table-craft/desktop/preload/bridge.js";
import type { SecretRequest } from "@table-craft/desktop/renderer/state/datasources.js";
import { useSecretPrompt } from "@table-craft/desktop/renderer/state/secretPrompt.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const ACRONYM = /^[A-Z]{2,}$/;

/** A field label inside a sentence: lower case, except words such as SSH that are acronyms. */
export function inSentence(label: string): string {
  return label
    .split(" ")
    .map((word) => (ACRONYM.test(word) ? word : word.toLowerCase()))
    .join(" ");
}

const MODE_ORDER: readonly SecretMode[] = ["forever", "untilRestart", "never"];

function keptSentence(name: string, mode: SecretMode, fields: string): string {
  if (mode === "forever") return `TableCraft saves the ${fields} in the system keychain.`;
  if (mode === "untilRestart") return `TableCraft keeps the ${fields} until it quits.`;
  return `${name} does not keep its ${fields}. It is used for this connection only.`;
}

/** What happens to each asked-for secret once the connection works, in the datasource's save modes. */
export function promptDescription(request: SecretRequest): string {
  return MODE_ORDER.flatMap((mode) => {
    const labels = request.fields
      .filter((field) => (request.datasource.secretModes[field.key] ?? "never") === mode)
      .map((field) => inSentence(field.label));
    return labels.length === 0 ? [] : [keptSentence(request.datasource.name, mode, labels.join(" and "))];
  }).join(" ");
}

function Body({ request }: { readonly request: SecretRequest }) {
  const answer = useSecretPrompt((state) => state.answer);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});

  return (
    <form
      className="flex flex-col gap-gap p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        const typed: Record<string, string> = {};
        for (const field of request.fields) typed[field.key] = values[field.key] ?? "";
        answer(typed);
      }}
    >
      <Dialog.Title className="font-semibold">Connect to {request.datasource.name}</Dialog.Title>
      <Dialog.Description className="text-ink-muted">{promptDescription(request)}</Dialog.Description>
      {request.fields.map((field, index) => (
        <label key={field.key} className="flex flex-col gap-1">
          <span className="text-ink-muted">{field.label}</span>
          <TextInput
            autoFocus={index === 0}
            type="password"
            aria-label={field.label}
            value={values[field.key] ?? ""}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
          />
        </label>
      ))}
      <div className="flex justify-end gap-gap">
        <Button onClick={() => answer(null)}>Cancel</Button>
        <Button type="submit" variant="primary">
          Connect
        </Button>
      </div>
    </form>
  );
}

/**
 * Asks for the secrets a datasource has no value for when it connects: kept Never, not saved yet,
 * or lost from the keychain (decision 020). A typed one is kept in its mode once the connection works.
 */
export function SecretPrompt() {
  const pending = useSecretPrompt((state) => state.pending);
  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) useSecretPrompt.getState().answer(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content className={cn(CONTENT_CLASS, "w-96 max-w-[90vw]")}>
          {pending === null ? null : <Body key={pending.request.datasource.id} request={pending.request} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
