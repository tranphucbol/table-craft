import { z } from "@table-craft/plugin-api";
import type { McpActiveConsole, McpConsoleView, McpUiAnswer } from "@table-craft/desktop/settings/mcp.js";

/** A console's text crosses to the MCP host only up to this; the tools cut it further. */
const MAX_CONSOLE_CHARS = 1_000_000;
/** More consoles than one agent could open in a session; a window never reports more. */
const MAX_CONSOLES = 1_000;
const HANDLE_CHARS = 32;
const TITLE_CHARS = 256;

const offset = z.number().int().nonnegative();
const namespace = z.array(z.string()).readonly().nullable();

const activeConsole = z.strictObject({
  datasourceId: z.string().min(1),
  sql: z.string().max(MAX_CONSOLE_CHARS),
  selectionFrom: offset,
  selectionTo: offset,
  namespace,
}) satisfies z.ZodType<McpActiveConsole>;

const consoleView = z.strictObject({
  handle: z.string().min(1).max(HANDLE_CHARS),
  title: z.string().max(TITLE_CHARS),
  datasourceId: z.string().min(1),
  namespace,
  sql: z.string().max(MAX_CONSOLE_CHARS),
  selectionFrom: offset,
  selectionTo: offset,
  revision: offset,
  active: z.boolean(),
}) satisfies z.ZodType<McpConsoleView>;

/** A window's answer to an agent's UI request (plan 156), checked before it reaches the MCP host. */
export const mcpUiAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("opened"),
    console: consoleView,
    schema: z.enum(["applied", "unsupported", "unknown"]).nullable(),
  }),
  z.strictObject({ kind: z.literal("context"), context: activeConsole.nullable() }),
  z.strictObject({
    kind: z.literal("edited"),
    console: consoleView.nullable(),
    refusal: z
      .strictObject({
        reason: z.enum(["notFound", "ambiguous", "stale", "selectNotFound"]),
        index: offset.nullable(),
        matches: offset,
      })
      .nullable(),
  }),
  z.strictObject({ kind: z.literal("consoles"), consoles: z.array(consoleView).max(MAX_CONSOLES).readonly() }),
  z.strictObject({ kind: z.literal("done") }),
]) satisfies z.ZodType<McpUiAnswer>;
