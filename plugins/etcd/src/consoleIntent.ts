import {
  PluginError,
  type CommandAdmission,
  type CommandIntentArguments,
  type KeyWatchRequest,
} from "@table-craft/plugin-api";
import { argumentsOf, type Arguments } from "./args.js";
import { consoleLeaseId } from "./consoleNumbers.js";
import { commandOf, type CommandDoc } from "./docs.js";
import { tokenize } from "./tokens.js";
import { kvOpOf } from "./ops.js";
import { keyBytesOf } from "./keyBytes.js";
import { NO_END } from "./scan.js";

export interface ConsoleIntent {
  readonly command: string;
  readonly action: NonNullable<CommandDoc["action"]> | "leaseGrant" | "admin";
  readonly arguments: Arguments;
  readonly requiresUi: boolean;
  readonly global: boolean;
  readonly history: "allow" | "omit";
  readonly watchRequest?: KeyWatchRequest;
}

export const CONSOLE_INTENT_INSPECTION = "EtcdConsoleIntent";
export const CONSOLE_CREDENTIAL_INSPECTION = `${CONSOLE_INTENT_INSPECTION}.credentials`;

/** Admission must happen before recording text, including malformed credential commands. */
export function consoleHistoryPolicy(text: string): "allow" | "omit" {
  for (const line of text.split(/\r?\n/)) {
    const words = tokenize(line.trim().replace(/^(?:then:|else:)\s*/i, "")).map((token) => token.text);
    if (commandOf(words)?.doc.action === "credentials") return "omit";
  }
  return "allow";
}

/** Shown for a refused credential command: the refusal must not repeat any part of its text. */
const CREDENTIAL_LABEL = "credential command";
const USER_NAME_LIMIT = 256;
const CONTROL = /\p{Cc}/u;
const NO_LEASE = "0";
/** Lease commands whose manager is Leases, not Server maintenance. */
const DOC_ACTIONS: Readonly<Partial<Record<string, "leaseRevoke" | "leaseGrant">>> = {
  "lease revoke": "leaseRevoke",
  "lease grant": "leaseGrant",
};

const REJECTED_CREDENTIALS: CommandAdmission = { admit: "reject", safeLabel: CREDENTIAL_LABEL };

/**
 * The host's admission of one console command (plan 110): a credential command with only a user
 * name opens the write-only credential dialog, any other credential text is rejected, and
 * resource or global administrative commands open their manager with plugin-parsed arguments.
 */
export function admitConsoleCommand(command: string): CommandAdmission {
  try {
    return admissionOf(command);
  } catch {
    return REJECTED_CREDENTIALS;
  }
}

function admissionOf(command: string): CommandAdmission {
  if (consoleHistoryPolicy(command) === "omit") return credentialAdmission(command);
  let intent: ConsoleIntent | null;
  try {
    intent = detectConsoleIntent(command);
  } catch {
    // Malformed non-credential text runs so the session reports its own syntax error.
    return { admit: "execute", safeLabel: "" };
  }
  if (intent === null || !intent.requiresUi) return { admit: "execute", safeLabel: intent?.command ?? "" };
  let args: CommandIntentArguments;
  try {
    args = managedArguments(intent);
  } catch {
    // Not a valid preset: refused, not opened with a guess and not run as a unary command.
    return { admit: "reject", safeLabel: intent.command };
  }
  return { admit: "managed", intent: intent.action, arguments: args, safeLabel: intent.command };
}

function credentialAdmission(command: string): CommandAdmission {
  let intent: ConsoleIntent | null;
  try {
    intent = detectConsoleIntent(command);
  } catch {
    return REJECTED_CREDENTIALS;
  }
  const [user, ...extra] = intent?.arguments.positional ?? [];
  if (
    intent?.action !== "credentials" ||
    user === undefined ||
    extra.length > 0 ||
    intent.arguments.flags.size > 0 ||
    !user.closed ||
    user.text === "" ||
    user.text.length > USER_NAME_LIMIT ||
    user.text.includes(":") ||
    CONTROL.test(user.text)
  )
    return REJECTED_CREDENTIALS;
  return {
    admit: "managed",
    intent: "credentials",
    arguments: {
      kind: "credentials",
      change: intent.command === "user add" ? "createUser" : "changePassword",
      user: user.text,
    },
    safeLabel: intent.command,
  };
}

function managedArguments(intent: ConsoleIntent): CommandIntentArguments {
  switch (intent.action) {
    case "watch":
      if (intent.watchRequest === undefined) throw new PluginError("statementFailed", "Invalid Watch range.");
      return { kind: "watch", request: intent.watchRequest };
    case "keepAlive":
    case "leaseRevoke": {
      const leaseId = consoleLeaseId(intent.arguments.positional[0]?.text ?? "");
      if (leaseId === NO_LEASE) throw new PluginError("statementFailed", "Lease 0 is not a lease.");
      return { kind: intent.action, leaseId };
    }
    default:
      return { kind: "none" };
  }
}

/** Validated semantic intent for a host bridge; credential-bearing syntax is never an intent. */
export function detectConsoleIntent(text: string): ConsoleIntent | null {
  const tokens = tokenize(text);
  const found = commandOf(tokens.map((token) => token.text));
  if (found === null || ["get", "put", "del", "txn"].includes(found.doc.name)) return null;
  if (tokens.some((token) => !token.closed) || /[\r\n]/.test(text))
    throw new PluginError("statementFailed", "Use one complete command line.");
  const args = argumentsOf(found.doc, tokens.slice(found.length));
  const action = found.doc.action ?? DOC_ACTIONS[found.doc.name] ?? "admin";
  if (action === "credentials" && args.positional.some((token) => token.text.includes(":"))) {
    throw new PluginError(
      "statementFailed",
      "Passwords are not accepted in console text. Use the secure credential dialog.",
    );
  }
  let watchRequest: KeyWatchRequest | undefined;
  if (action === "watch") {
    const op = kvOpOf(tokenize(`get ${text.slice(tokens[0]?.to ?? 0)}`));
    if (op.kind !== "get") throw new PluginError("statementFailed", "Invalid Watch range.");
    const range =
      op.rangeEnd === null
        ? { kind: "key" as const, key: keyBytesOf(op.key) }
        : op.key.equals(NO_END) && op.rangeEnd.equals(NO_END)
          ? { kind: "all" as const }
          : args.flags.has("prefix")
            ? { kind: "prefix" as const, prefix: keyBytesOf(args.positional[0]?.bytes ?? Buffer.alloc(0)) }
            : { kind: "range" as const, from: keyBytesOf(op.key), to: keyBytesOf(op.rangeEnd) };
    // The all-remaining sentinel is an internal raw range, not a public finite KeyRange end.
    if (args.flags.has("from-key") && range.kind !== "all")
      throw new PluginError(
        "statementFailed",
        "Watch --from-key requires the all-key start; use a finite range or --prefix for a bounded Watch.",
      );
    watchRequest = {
      database: 0,
      range,
      from: String(op.revision) === "0" ? { kind: "now" } : { kind: "revision", revision: String(op.revision) },
    };
  }
  return {
    command: found.doc.name,
    action,
    arguments: args,
    requiresUi:
      ["watch", "snapshot", "credentials", "access", "cluster", "leaseRevoke", "leaseGrant"].includes(action) ||
      (action === "keepAlive" && !args.flags.has("once")) ||
      (found.doc.kind === "write" && action === "admin"),
    global: action !== "watch",
    history: action === "credentials" ? "omit" : "allow",
    ...(watchRequest === undefined ? {} : { watchRequest }),
  };
}
