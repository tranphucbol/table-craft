import * as Dialog from "@radix-ui/react-dialog";
import { DEFAULT_SSH_PORT, type HostKeyPrompt as Prompt } from "@table-craft/desktop/preload/bridge.js";
import { Button, CONTENT_CLASS, OVERLAY_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { useHostKeyPrompt } from "@table-craft/desktop/renderer/state/hostKeyPrompt.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/** `bastion` on port 22, `bastion:2204` otherwise, as `ssh` names the server. */
export function sshServerName(host: string, port: number): string {
  return port === DEFAULT_SSH_PORT ? host : `${host}:${String(port)}`;
}

function Body({ prompt }: { readonly prompt: Prompt }) {
  const answer = useHostKeyPrompt((state) => state.answer);
  const { offer } = prompt;
  return (
    <div className="flex flex-col gap-gap p-gap">
      <Dialog.Title className="font-semibold">Unknown SSH host key</Dialog.Title>
      <Dialog.Description className="text-ink-muted">
        This is the first connection to {sshServerName(offer.host, offer.port)}. Check the fingerprint with the
        server&apos;s administrator before trusting it; TableCraft remembers it and refuses the server if it ever
        changes.
      </Dialog.Description>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-gap gap-y-1">
        <dt className="text-ink-muted">Server</dt>
        <dd data-testid="host-key-server">{sshServerName(offer.host, offer.port)}</dd>
        <dt className="text-ink-muted">Key type</dt>
        <dd>{offer.algorithm}</dd>
        <dt className="text-ink-muted">Fingerprint</dt>
        <dd data-testid="host-key-fingerprint" className="font-grid break-all select-text">
          {offer.fingerprint}
        </dd>
      </dl>
      <div className="flex justify-end gap-gap">
        <Button onClick={() => answer(prompt.requestId, false)}>Cancel</Button>
        <Button variant="primary" onClick={() => answer(prompt.requestId, true)}>
          Trust
        </Button>
      </div>
    </div>
  );
}

/** Asks before a tunnel trusts an SSH server it has not met (decision 071); closing it declines. */
export function HostKeyPrompt() {
  const prompt = useHostKeyPrompt((state) => state.queue[0] ?? null);
  return (
    <Dialog.Root
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open && prompt !== null) useHostKeyPrompt.getState().answer(prompt.requestId, false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content className={cn(CONTENT_CLASS, "w-96 max-w-[90vw]")}>
          {prompt === null ? null : <Body key={prompt.requestId} prompt={prompt} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
