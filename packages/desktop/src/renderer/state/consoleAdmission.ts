import {
  COMMAND_ADMIT_MAX_COMMANDS,
  COMMAND_ADMIT_MAX_LABEL,
  COMMAND_INTENTS,
  type CommandAdmission,
  type CommandIntent,
  type CommandIntentArguments,
  type EngineError,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";

/**
 * The console's admission of what it is about to run (plan 110): asked of the engine before the
 * console records history, starts a Services row, writes Output or opens a result, so a command
 * whose text may hold a password never reaches any of them.
 */

/** Fixed: a refusal never repeats the command it refused. */
export const ADMISSION_REJECTED: EngineError = {
  code: "statementFailed",
  message:
    "This command cannot run in the console. Nothing ran. The editor text and undo history were cleared for privacy.",
  hint: "Set passwords in Users & Roles, which never shows or records them; other commands run as typed.",
};

export const ADMISSION_FAILED: EngineError = {
  code: "statementFailed",
  message: "Could not check the command before running it. Nothing ran and its text was not recorded.",
  hint: "Run it again; if this repeats, reconnect the data source.",
};

export const MANAGED_ALONE: EngineError = {
  code: "statementFailed",
  message: "A command that opens a manager runs on its own. Nothing ran.",
  hint: "Select only that command and run it, or run the others without it.",
};

export const MANAGER_UNAVAILABLE: EngineError = {
  code: "statementFailed",
  message: "This command opens a manager that is not available here. Nothing ran.",
  hint: "Open the manager from the Database menu instead.",
};

/** Shown when the secret prompt a console command opened could not confirm the change. */
export const CREDENTIAL_UNCONFIRMED = {
  title: "Password change could not be confirmed",
  message: "The password was not shown, recorded or logged. Check the user in Users & Roles.",
  hint: "Open Users & Roles to inspect the user before entering the password again.",
} as const;

/** Output's line once a managed command's manager opened in its place. */
export const MANAGED_OPENED = "Opened in its manager; nothing ran in the console.";

/** What the console shows for a statement admitted as `omitHistory` in place of its text. */
export const PRIVATE_STATEMENT_LABEL = "Private command";
export const PRIVATE_FAILED: Pick<EngineError, "message" | "hint"> = {
  message: "The private command failed. Its text and the server's message were not recorded.",
  hint: "Check the command and run it again.",
};

/** Where a managed command goes: its manager, the datasource it runs on, and the plugin-parsed arguments. */
export interface ConsoleIntentRoute {
  readonly datasourceId: string;
  readonly intent: CommandIntent;
  readonly arguments: CommandIntentArguments;
}

/**
 * What a route does: invoke a manager action, or open the write-only credential prompt for a
 * user name the plugin parsed. Neither carries console text.
 */
export type IntentAction =
  | { readonly kind: "action"; readonly actionId: string; readonly args: unknown }
  | {
      readonly kind: "secret";
      readonly datasourceId: string;
      readonly user: string;
      readonly change: "createUser" | "changePassword";
    };

/**
 * des-13's managed-intent action and its inspection namespace (`keyAdmin/consoleIntents.ts`),
 * repeated here so the console store does not load the manager UI; a test keeps them equal.
 */
export const MANAGED_INTENT_ACTION = "console.openManagedIntent";
export const MANAGED_INTENT_INSPECTION_PREFIX = "EtcdConsoleIntent.";
/** Registered by `watch/actions.ts`; takes the plugin's normalized range and start. */
export const WATCH_START_ACTION = "watch.start";
/** Registered by `keyAdmin/actions.ts`; takes `{ datasourceId, leaseId }` and focuses that lease. */
export const ADMIN_LEASES_ACTION = "keyAdmin.leases";

/**
 * Where each intent goes. Watch and lease commands open their manager preset with the plugin's
 * arguments (a lease grant opens Leases with none); credentials open the secret prompt for the parsed user; the rest open des-13's
 * managed-intent action. Every write keeps its manager's own confirmation.
 */
export function intentAction(route: ConsoleIntentRoute): IntentAction | null {
  const { datasourceId, intent, arguments: args } = route;
  switch (intent) {
    case "watch":
      if (args.kind !== "watch") return null;
      return {
        kind: "action",
        actionId: WATCH_START_ACTION,
        args: { datasourceId, database: args.request.database, range: args.request.range, from: args.request.from },
      };
    case "credentials":
      if (args.kind !== "credentials") return null;
      return { kind: "secret", datasourceId, user: args.user, change: args.change };
    case "keepAlive":
    case "leaseRevoke":
      if ((args.kind !== "keepAlive" && args.kind !== "leaseRevoke") || args.kind !== intent) return null;
      return { kind: "action", actionId: ADMIN_LEASES_ACTION, args: { datasourceId, leaseId: args.leaseId } };
    case "leaseGrant":
      if (args.kind !== "none") return null;
      return { kind: "action", actionId: ADMIN_LEASES_ACTION, args: { datasourceId } };
    // Compaction and member changes open their Server view without the revision or member id:
    // `keyAdmin.cluster` takes only a view, and the intent's arguments carry neither.
    case "access":
    case "snapshot":
    case "cluster":
    case "admin":
      if (args.kind !== "none") return null;
      return {
        kind: "action",
        actionId: MANAGED_INTENT_ACTION,
        args: { datasourceId, inspection: `${MANAGED_INTENT_INSPECTION_PREFIX}${intent}` },
      };
  }
}

/** What the app gives the router: the registry's `invoke` and the admin host's credential prompt. */
export interface ConsoleIntentHost {
  /** The registry's `InvokeOutcome`, kept structural to avoid importing the registry. */
  readonly invoke: (actionId: string, args: unknown) => "ran" | "disabled" | "unknown";
  /** `adminHost().applySecret`: asks for the password itself and sends it to main, never here. */
  readonly applySecret: (datasourceId: string, user: string, change: "createUser" | "changePassword") => Promise<void>;
  /** Says the credential change could not be confirmed, in fixed words. */
  readonly secretFailed: () => void;
}

let host: ConsoleIntentHost | null = null;

/** Installs the app's router for managed commands; returns the uninstall. */
export function installConsoleIntentRouter(value: ConsoleIntentHost): () => void {
  host = value;
  return () => {
    if (host === value) host = null;
  };
}

/** Opens the route's manager or prompt; false when none is installed or the action did not run. */
export function routeConsoleIntent(route: ConsoleIntentRoute): boolean {
  const action = intentAction(route);
  const current = host;
  if (action === null || current === null) return false;
  if (action.kind === "action") return current.invoke(action.actionId, action.args) === "ran";
  void current.applySecret(action.datasourceId, action.user, action.change).catch(() => current.secretFailed());
  return true;
}

const VERDICTS: ReadonlySet<string> = new Set(["execute", "omitHistory", "managed", "reject"]);
const INTENTS: ReadonlySet<string> = new Set(COMMAND_INTENTS);

function isAdmission(value: unknown): value is CommandAdmission {
  if (typeof value !== "object" || value === null) return false;
  const answer = value as Record<string, unknown>;
  if (typeof answer.admit !== "string" || !VERDICTS.has(answer.admit)) return false;
  if (typeof answer.safeLabel !== "string" || answer.safeLabel.length > COMMAND_ADMIT_MAX_LABEL) return false;
  if (answer.admit !== "managed") return true;
  const args = answer.arguments as Record<string, unknown> | null | undefined;
  return typeof answer.intent === "string" && INTENTS.has(answer.intent) && typeof args?.kind === "string";
}

/**
 * Each command's admission, asked in batches the engine accepts; null when any answer is missing
 * or malformed, which the console treats as a refusal of the whole run.
 */
export async function admissionsOf(
  client: EngineClient,
  commands: readonly string[],
): Promise<readonly CommandAdmission[] | null> {
  const answers: CommandAdmission[] = [];
  try {
    for (let from = 0; from < commands.length; from += COMMAND_ADMIT_MAX_COMMANDS) {
      const batch = commands.slice(from, from + COMMAND_ADMIT_MAX_COMMANDS);
      const answered: unknown = await client.call("commands.admit", { commands: batch });
      if (!Array.isArray(answered) || answered.length !== batch.length) return null;
      for (const answer of answered as unknown[]) {
        if (!isAdmission(answer)) return null;
        answers.push(answer);
      }
    }
  } catch {
    // The engine's error may describe the request; the console says only that it could not check.
    return null;
  }
  return answers;
}
