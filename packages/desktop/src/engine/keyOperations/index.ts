import { z } from "@table-craft/plugin-api";
import type { EngineContext } from "@table-craft/desktop/engine/context.js";
import { EngineFailure } from "@table-craft/desktop/engine/failures.js";
import { KeyOperationScope, serviceMethod } from "./scope.js";
import { KeyWatches } from "./watches.js";
import { KeyRenewals } from "./renewals.js";
import { KeyTasks } from "./tasks.js";
import { maintenanceOperations } from "./maintenance.js";
import { keyTransferOperations } from "./transfers.js";
import { watchExportOperations } from "./watchExport.js";

const MAX_SECRET_BYTES = 16_384;
const secretChange = z.strictObject({
  kind: z.enum(["createUser", "changePassword"]),
  user: z.string().min(1).max(1_024),
  password: z.string().max(MAX_SECRET_BYTES),
});

export function keyOperations(context: EngineContext) {
  const scope = new KeyOperationScope(context);
  const tasks = new KeyTasks(scope);
  const watches = new KeyWatches(scope);
  return {
    scope,
    tasks,
    watches,
    watchExport: watchExportOperations(watches, tasks, context.options.operationFiles),
    renewals: new KeyRenewals(scope),
    maintenance: maintenanceOperations(tasks, context.options.operationFiles),
    transfer: keyTransferOperations(scope, tasks, context.options.operationFiles),
  };
}

/** Main-only credential control; never enter the ordinary request/logging path. */
export async function applyAccessSecret(scope: KeyOperationScope, input: unknown): Promise<void> {
  try {
    const change = secretChange.parse(input);
    if (Buffer.byteLength(change.password) > MAX_SECRET_BYTES) throw new Error();
    await scope.run("access", true, (session) => serviceMethod(session.access, "applySecret")(change));
  } catch {
    throw new EngineFailure({
      code: "statementFailed",
      message: "The credential change could not be confirmed.",
      hint: "Check administrator access and inspect the user before trying again.",
    });
  }
}
