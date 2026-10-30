import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import type { InvokeResult } from "@table-craft/desktop/preload/bridge.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useAdminSecret } from "./SecretPrompt.js";

export type AdminFileOperation = "cluster.snapshot" | "transfer.export" | "transfer.import" | "watch.export";
export interface AdminHostHooks {
  readonly chooseFile: (datasourceId: string, operation: AdminFileOperation) => Promise<string | null>;
  readonly applySecret: (datasourceId: string, user: string, kind: "createUser" | "changePassword") => Promise<void>;
}
let hooks: AdminHostHooks | null = null;
export function installAdminHostHooks(value: AdminHostHooks): () => void {
  hooks = value;
  return () => {
    if (hooks === value) hooks = null;
  };
}
export function adminHost(): AdminHostHooks {
  if (hooks === null)
    throw new Error(
      "The authorized file and credential channel is not available. Reopen TableCraft after its host integration has been installed.",
    );
  return hooks;
}
function checked<T>(answer: InvokeResult<T>): T {
  if (!answer.ok)
    throw new Error(
      "The private operation could not be confirmed. Check access and choose the file or enter the password again.",
    );
  return answer.value;
}
export function installDesktopAdminHost(): () => void {
  return installAdminHostHooks({
    async chooseFile(id, operation) {
      return checked(await bridge().chooseOperationFile(id, operation));
    },
    async applySecret(id, user, kind) {
      let password = await useAdminSecret.getState().ask(user, kind);
      if (password === null) return;
      const client = await useDatasources.getState().connect(id);
      const session = await client.call("session.open", {});
      try {
        const request = bridge().applyAccessSecret({
          datasourceId: id,
          sessionId: session.sessionId,
          user,
          action: kind === "createUser" ? "create" : "password",
          password,
        });
        password = "";
        checked(await request);
      } catch {
        throw new Error(
          "The password change could not be confirmed. Check the user's access before entering it again.",
        );
      } finally {
        await client.call("session.close", { sessionId: session.sessionId });
      }
    },
  });
}
