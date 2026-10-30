import { z, type CommandLanguage } from "@table-craft/plugin-api";
import {
  COMMAND_ADMIT_MAX_LABEL,
  COMMAND_INTENTS,
  type CommandAdmission,
  type CommandIntent,
  type CommandIntentArguments,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineFailure } from "@table-craft/desktop/engine/failures.js";

/** Says nothing about the command it refused: its text may hold a password (plan 110). */
export const NOT_ADMITTED_MESSAGE =
  "This command cannot run in the console. Nothing ran and its text was not recorded.";
export const NOT_ADMITTED_HINT =
  "Open the matching manager, such as Users & Roles to set a password, or run a plain command.";

const EXECUTE: CommandAdmission = { admit: "execute", safeLabel: "" };
const REJECTED: CommandAdmission = { admit: "reject", safeLabel: "" };
const DECIMAL_MAX_LENGTH = 20;
const USER_MAX_LENGTH = 256;

const label = z.string().max(COMMAND_ADMIT_MAX_LABEL);
const bytes = z.strictObject({
  text: z.string(),
  hex: z
    .string()
    .regex(/^(?:[0-9a-f]{2})*$/)
    .nullable(),
});
const range = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("key"), key: bytes }),
  z.strictObject({ kind: z.literal("prefix"), prefix: bytes }),
  z.strictObject({ kind: z.literal("range"), from: bytes, to: bytes }),
  z.strictObject({ kind: z.literal("all") }),
]);
const leaseId = z
  .string()
  .regex(/^-?[1-9][0-9]*$/)
  .max(DECIMAL_MAX_LENGTH + 1);
const intentArguments = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("watch"),
    request: z.strictObject({
      database: z.number().int().nonnegative(),
      range,
      from: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("now") }),
        z.strictObject({
          kind: z.literal("revision"),
          revision: z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .max(DECIMAL_MAX_LENGTH),
        }),
      ]),
    }),
  }),
  z.strictObject({
    kind: z.literal("credentials"),
    change: z.enum(["createUser", "changePassword"]),
    user: z.string().min(1).max(USER_MAX_LENGTH),
  }),
  z.strictObject({ kind: z.literal("keepAlive"), leaseId }),
  z.strictObject({ kind: z.literal("leaseRevoke"), leaseId }),
  z.strictObject({ kind: z.literal("none") }),
]);
/** The plugin's answer, checked as strictly as a request: what is not exactly this is a reject. */
const admission = z.discriminatedUnion("admit", [
  z.strictObject({ admit: z.enum(["execute", "omitHistory", "reject"]), safeLabel: label }),
  z.strictObject({
    admit: z.literal("managed"),
    intent: z.enum(COMMAND_INTENTS),
    arguments: intentArguments,
    safeLabel: label,
  }),
]);

/** Which arguments each intent may carry; anything else would let one manager run another's preset. */
const ARGUMENTS_OF: Readonly<Record<CommandIntent, CommandIntentArguments["kind"]>> = {
  watch: "watch",
  credentials: "credentials",
  keepAlive: "keepAlive",
  leaseRevoke: "leaseRevoke",
  leaseGrant: "none",
  snapshot: "none",
  access: "none",
  cluster: "none",
  admin: "none",
};

function admitOne(language: CommandLanguage, command: string): CommandAdmission {
  try {
    const parsed = admission.safeParse(language.admit?.(command));
    if (!parsed.success) return REJECTED;
    const value = parsed.data;
    if (value.admit === "reject") return REJECTED;
    if (value.admit === "managed" && ARGUMENTS_OF[value.intent] !== value.arguments.kind) return REJECTED;
    return value;
  } catch {
    // The plugin's message may quote the command; nothing of it is kept or logged.
    return REJECTED;
  }
}

/**
 * Each command's admission (plan 110). A plugin without `admit` executes everything as before;
 * one that throws or answers outside the contract rejects that command. Never logs the text.
 */
export function admitCommands(language: CommandLanguage | null, commands: readonly string[]): CommandAdmission[] {
  if (language?.admit === undefined) return commands.map(() => EXECUTE);
  return commands.map((command) => admitOne(language, command));
}

/**
 * Refuses to run as an ordinary statement what the console would not admit, for any caller that
 * reaches `statement.execute` without asking first. The refusal is fixed text.
 */
export function assertExecutable(language: CommandLanguage | null, sql: string): void {
  const [verdict] = admitCommands(language, [sql]);
  if (verdict?.admit === "execute" || verdict?.admit === "omitHistory") return;
  throw notAdmitted();
}

/**
 * Refuses an engine-side script run on a datasource whose plugin admits its commands. Each
 * statement of a script would have to be admitted on its own, and a script's failure keeps a
 * preview of the statement, so a file that may hold a password never starts. Fixed text.
 */
export function assertScriptable(language: CommandLanguage | null): void {
  if (language?.admit !== undefined) throw notAdmitted();
}

function notAdmitted(): EngineFailure {
  return new EngineFailure({ code: "statementFailed", message: NOT_ADMITTED_MESSAGE, hint: NOT_ADMITTED_HINT });
}
