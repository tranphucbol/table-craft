import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { Button, CONTENT_CLASS, OVERLAY_CLASS, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
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
      <Dialog.Description className="text-ink-muted">
        {request.datasource.name} does not keep its{" "}
        {request.fields.map((field) => inSentence(field.label)).join(" or ")}. It is used for this connection only.
      </Dialog.Description>
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

/** Asks for secrets kept Never, or lost from the keychain, when a datasource connects (decision 020). */
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
