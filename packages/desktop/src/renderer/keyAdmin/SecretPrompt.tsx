import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { create } from "zustand";
import { Button, CONTENT_CLASS, OVERLAY_CLASS, TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";

interface SecretRequest {
  readonly user: string;
  readonly kind: "createUser" | "changePassword";
  readonly resolve: (secret: string | null) => void;
}
export const useAdminSecret = create<{
  readonly pending: SecretRequest | null;
  readonly ask: (user: string, kind: SecretRequest["kind"]) => Promise<string | null>;
  readonly answer: (secret: string | null) => void;
}>()((set, get) => ({
  pending: null,
  ask(user, kind) {
    get().pending?.resolve(null);
    return new Promise((resolve) => set({ pending: { user, kind, resolve } }));
  },
  answer(secret) {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(secret);
  },
}));
function Body({ request }: { readonly request: SecretRequest }) {
  const [password, setPassword] = useState("");
  return (
    <form
      className="flex flex-col gap-gap p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        const secret = password;
        setPassword("");
        useAdminSecret.getState().answer(secret);
      }}
    >
      <Dialog.Title className="font-semibold">
        {request.kind === "createUser" ? "Create user" : "Change password"}: {request.user}
      </Dialog.Title>
      <Dialog.Description className="text-ink-muted">
        Cluster-global. The password is sent once through a private write-only channel, never through a console or
        action arguments.
      </Dialog.Description>
      <label className="flex flex-col gap-cell">
        New password
        <TextInput
          autoFocus
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <div className="flex justify-end gap-gap">
        <Button
          onClick={() => {
            setPassword("");
            useAdminSecret.getState().answer(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={password.length === 0}>
          Apply Password
        </Button>
      </div>
    </form>
  );
}
export function AdminSecretPrompt() {
  const pending = useAdminSecret((state) => state.pending);
  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) useAdminSecret.getState().answer(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content className={`${CONTENT_CLASS} w-dialog max-w-[90vw]`}>
          {pending === null ? null : <Body key={`${pending.kind}-${pending.user}`} request={pending} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
