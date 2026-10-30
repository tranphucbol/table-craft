import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { admissionsOf } from "@table-craft/desktop/renderer/state/consoleAdmission.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { connectionOf, pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

export const PERSISTENCE_UNCHECKED =
  "The console was not saved because its text could not be checked. Connect its data source and save again.";
export const PERSISTENCE_REJECTED =
  "The console was not saved. Its text and undo history were cleared because it may contain private information. Set passwords in Users & Roles.";
export const PERSISTENCE_HINT = "Connect the data source to check console text. Enter passwords only in Users & Roles.";

export class ConsolePersistenceFailure extends Error {
  readonly hint = PERSISTENCE_HINT;
}

export interface ConsolePersistenceContext {
  readonly capabilities: readonly string[] | null;
  readonly client: () => Promise<EngineClient | null>;
  readonly scrub: () => void;
}

export async function checkConsolePersistence(text: string, context: ConsolePersistenceContext): Promise<void> {
  if (text.trim() === "") return;
  if (context.capabilities?.includes("sql") === true && !context.capabilities.includes("commands")) return;
  if (context.capabilities?.includes("commands") !== true) throw new ConsolePersistenceFailure(PERSISTENCE_UNCHECKED);
  let client: EngineClient | null;
  try {
    client = await context.client();
  } catch {
    throw new ConsolePersistenceFailure(PERSISTENCE_UNCHECKED);
  }
  if (client === null) throw new ConsolePersistenceFailure(PERSISTENCE_UNCHECKED);
  // Check the original document, not reconstructed statements: a splitter can omit incomplete text.
  const answers = await admissionsOf(client, [text]);
  const answer = answers?.[0];
  if (answer === undefined) throw new ConsolePersistenceFailure(PERSISTENCE_UNCHECKED);
  if (answer.admit === "execute" || answer.admit === "managed") return;
  context.scrub();
  throw new ConsolePersistenceFailure(PERSISTENCE_REJECTED);
}

export async function assertConsoleTextPersistable(datasourceId: string, text: string): Promise<void> {
  const state = useDatasources.getState();
  const source = state.datasources.find((item) => item.id === datasourceId);
  const plugin = pluginOf(state.plugins, source?.pluginId ?? "");
  const targets = Object.entries(useConsoles.getState().consoles)
    .filter(([, session]) => session.datasourceId === datasourceId && session.sql === text)
    .map(([id]) => id);
  await checkConsolePersistence(text, {
    capabilities: plugin?.capabilities ?? null,
    client: () =>
      connectionOf(useDatasources.getState(), datasourceId).status === "connected"
        ? useDatasources.getState().connect(datasourceId)
        : Promise.resolve(null),
    scrub: () => {
      for (const id of targets) {
        if (useConsoles.getState().consoles[id]?.datasourceId === datasourceId) useConsoles.getState().scrub(id);
      }
    },
  });
}
