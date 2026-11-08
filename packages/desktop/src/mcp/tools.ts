import { z } from "@table-craft/plugin-api";
import { EngineCallError } from "@table-craft/desktop/mcp/engines.js";
import {
  describeTable,
  getDdl,
  listDatasources,
  listSchemas,
  listTables,
} from "@table-craft/desktop/mcp/catalogTools.js";
import { createQueryTools } from "@table-craft/desktop/mcp/queryTools.js";
import { getKey, scanKeys } from "@table-craft/desktop/mcp/keyTools.js";
import {
  checkSql,
  editConsole,
  getActiveContext,
  listConsoles,
  openInConsole,
  readConsole,
} from "@table-craft/desktop/mcp/consoleTools.js";
import { openTableFor, revealInExplorer } from "@table-craft/desktop/mcp/windowTools.js";
import type { AgentEdit } from "@table-craft/desktop/settings/mcp.js";
import { KEY_TYPES } from "@table-craft/desktop/engine/protocol.js";
import {
  ToolFailure,
  type Caller,
  type ToolAnswer,
  type ToolContext,
  type ToolResult,
} from "@table-craft/desktop/mcp/toolKit.js";

const REASON_CHARS = 500;
const SQL_CHARS = 100_000;
const MAX_ROW_LIMIT = 1_000;
const DEFAULT_SCAN_LIMIT = 100;
const MAX_SCAN_LIMIT = 1_000;
const MATCH_ALL = "*";
const TITLE_CHARS = 64;
const MAX_EDITS = 50;

const datasource = z.string().min(1).describe("The datasource id from list_datasources.");
const schema = z.string().min(1).describe("The schema as list_schemas names it, such as public or shop.");
const table = z.string().min(1).describe("The table or view name.");
const sql = z.string().min(1).max(SQL_CHARS);
const database = z.number().int().min(0).optional().describe("The database number; the connection's own when absent.");
const reason = z
  .string()
  .max(REASON_CHARS)
  .optional()
  .describe("Why you need it; the user reads this when the call waits for approval.");
const focus = z
  .boolean()
  .optional()
  .describe("Bring TableCraft's window forward too; the user can turn this off. The tab is shown either way.");
const consoleHandle = z.string().min(1).describe("The console handle open_in_console returned.");

const TOOL_ARGUMENTS = {
  list_datasources: z.strictObject({}),
  list_schemas: z.strictObject({ datasource }),
  list_tables: z.strictObject({ datasource, schema }),
  describe_table: z.strictObject({ datasource, schema, table }),
  get_ddl: z.strictObject({ datasource, schema, table }),
  run_query: z.strictObject({
    datasource,
    sql: sql.describe("Exactly one statement, or one command, in the datasource's language."),
    reason,
  }),
  fetch_rows: z.strictObject({
    handle: z.string().min(1).describe("The handle run_query returned."),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional(),
  }),
  close_result: z.strictObject({ handle: z.string().min(1) }),
  explain: z.strictObject({ datasource, sql: sql.describe("One statement to explain; it is not run.") }),
  format_sql: z.strictObject({ datasource, sql }),
  check_sql: z.strictObject({ datasource, sql: sql.describe("The text to check; it is not run.") }),
  scan_keys: z.strictObject({
    datasource,
    pattern: z.string().min(1).optional().describe("A glob such as user:*; every key when absent."),
    database,
    type: z.enum(KEY_TYPES).optional(),
    cursor: z.string().min(1).optional().describe("The cursor a previous scan_keys returned, to continue."),
    limit: z.number().int().min(1).max(MAX_SCAN_LIMIT).optional(),
  }),
  get_key: z.strictObject({ datasource, key: z.string().min(1), database, reason }),
  open_in_console: z.strictObject({
    datasource,
    sql: sql.describe("The text to put in a new console; the user decides whether to run it."),
    schema: z.string().min(1).optional().describe("The schema the console works in, as list_schemas names it."),
    title: z
      .string()
      .min(1)
      .max(TITLE_CHARS)
      .optional()
      .describe("A name for the console's tab, such as add_orders_index."),
    focus,
  }),
  get_active_context: z.strictObject({}),
  edit_console: z
    .strictObject({
      console: consoleHandle,
      edits: z
        .array(
          z.strictObject({
            oldText: z.string().min(1).describe("Text that occurs exactly once in the console."),
            newText: z.string().max(SQL_CHARS),
          }),
        )
        .min(1)
        .max(MAX_EDITS)
        .optional()
        .describe("Applied in order, each to the text the previous one left. Any miss changes nothing."),
      text: sql.optional().describe("The whole new text, instead of edits; needs revision."),
      revision: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("The revision the whole text replaces, from open_in_console, edit_console or read_console."),
      select: z.string().min(1).optional().describe("Text that occurs once in the result, to select and scroll to."),
      focus,
    })
    .refine((args) => (args.edits === undefined) !== (args.text === undefined), {
      message: "Give either edits or text.",
    })
    .refine((args) => args.text === undefined || args.revision !== undefined, {
      message: "Replacing the whole text needs revision.",
    }),
  read_console: z.strictObject({ console: consoleHandle }),
  list_consoles: z.strictObject({}),
  open_table: z.strictObject({
    datasource,
    schema,
    table,
    where: z.string().min(1).max(SQL_CHARS).optional().describe("A condition for the WHERE bar, without WHERE."),
    orderBy: z.string().min(1).max(SQL_CHARS).optional().describe("A list for the ORDER BY bar, without ORDER BY."),
    focus,
  }),
  reveal_in_explorer: z
    .strictObject({
      datasource,
      schema,
      table: table.optional(),
      column: z.string().min(1).optional().describe("A column of table."),
      focus,
    })
    .refine((args) => args.column === undefined || args.table !== undefined, { message: "A column needs its table." }),
} as const;

export type ToolName = keyof typeof TOOL_ARGUMENTS;

interface ToolSpec {
  readonly title: string;
  readonly description: string;
  readonly readOnly: boolean;
}

const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>> = {
  list_datasources: {
    title: "List datasources",
    description:
      "The TableCraft datasources the user exposed to agents, with their access: ask before reads, read only, or ask before writes.",
    readOnly: true,
  },
  list_schemas: { title: "List schemas", description: "The databases or schemas of a datasource.", readOnly: true },
  list_tables: { title: "List tables", description: "The tables and views in a schema.", readOnly: true },
  describe_table: {
    title: "Describe table",
    description: "Columns, types, keys, foreign keys and indexes of a table or view.",
    readOnly: true,
  },
  get_ddl: {
    title: "Get DDL",
    description: "The CREATE statement of a table or view, read from the database.",
    readOnly: true,
  },
  run_query: {
    title: "Run query",
    description:
      "Runs one SQL statement, or one command on a datasource such as Redis. Reads run on a read-only session and return at most the user's row cap, with a handle for fetch_rows when there are more. A statement that changes data or schema waits until the user approves it in TableCraft, and is refused on a read-only datasource. On an ask-before-reads datasource every read waits until the user approves it, and changes are refused. The user sees reason while deciding. Transaction statements are refused; each approved statement commits on its own. Integers beyond ±2^53 come back as strings holding the exact value; compare or add them in SQL, not after parsing them as numbers.",
    readOnly: false,
  },
  fetch_rows: {
    title: "Fetch rows",
    description:
      "More rows of a result run_query kept open. Integers beyond ±2^53 come back as strings holding the exact value, as in run_query.",
    readOnly: true,
  },
  close_result: { title: "Close result", description: "Releases a result run_query kept open.", readOnly: true },
  explain: {
    title: "Explain",
    description: "The execution plan of one statement, without running it.",
    readOnly: true,
  },
  format_sql: { title: "Format SQL", description: "Formats SQL in the datasource's dialect.", readOnly: true },
  check_sql: {
    title: "Check SQL",
    description:
      "Runs TableCraft's inspections over SQL or commands without running them: syntax errors, unknown names, risky statements.",
    readOnly: true,
  },
  scan_keys: {
    title: "Scan keys",
    description:
      "Lists keys of a key-value datasource such as Redis that match a glob, with their types and expiry; continue with the cursor it returns.",
    readOnly: true,
  },
  get_key: {
    title: "Get key",
    description:
      "The type, expiry and value of one key; the elements of a hash, list, set or sorted set, up to the row cap. On an ask-before-reads datasource it waits until the user approves it; the user sees reason while deciding.",
    readOnly: true,
  },
  open_in_console: {
    title: "Open in console",
    description:
      "Opens a new TableCraft console with the text for the user to review and run, and answers its handle and revision. Nothing runs; use it to hand over a statement the user should run themselves. schema sets where the console works, title names its tab, and focus brings the window forward unless the user turned that off. Change the console later with edit_console instead of opening another.",
    readOnly: true,
  },
  get_active_context: {
    title: "Get active context",
    description:
      "The console the user has focused in TableCraft: its datasource, schema, text and selection. Refused when that datasource is not exposed to agents.",
    readOnly: true,
  },
  edit_console: {
    title: "Edit console",
    description:
      "Changes a console you opened with open_in_console, as one undo step for the user; nothing runs. Pass edits, each an oldText that occurs exactly once and its newText, or the whole text with the revision you last saw. A missing or repeated oldText, or a revision the user has moved past, changes nothing. select picks text to select in the result. Only your own consoles can be edited.",
    readOnly: true,
  },
  read_console: {
    title: "Read console",
    description:
      "The text, selection and revision of a console you opened, including what the user changed in it since.",
    readOnly: true,
  },
  list_consoles: {
    title: "List consoles",
    description:
      "The consoles you opened that are still open: handle, title, datasource, revision, and whether it is the user's active tab. The user's own consoles are not listed.",
    readOnly: true,
  },
  open_table: {
    title: "Open table",
    description:
      "Opens a table or view in the user's data editor, with where and orderBy in its filter bars. The rows are read in the user's session and are not returned; use run_query to read them yourself. The filter must form one read. On an ask-before-reads datasource the filter is only filled in, and the user applies it.",
    readOnly: true,
  },
  reveal_in_explorer: {
    title: "Reveal in explorer",
    description:
      "Selects a schema, table, view or column in the user's Database pane, to point the user at it. Answers found: false when there is no such object.",
    readOnly: true,
  },
};

export interface ToolDefinition {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: { readonly readOnlyHint: boolean; readonly openWorldHint: false };
}

function inputSchema(name: ToolName): Readonly<Record<string, unknown>> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(TOOL_ARGUMENTS[name]);
  return rest;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = (Object.keys(TOOL_SPECS) as ToolName[]).map((name) => ({
  name,
  title: TOOL_SPECS[name].title,
  description: TOOL_SPECS[name].description,
  inputSchema: inputSchema(name),
  annotations: { readOnlyHint: TOOL_SPECS[name].readOnly, openWorldHint: false },
}));

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_ARGUMENTS, name);
}

export interface Tools {
  call(name: ToolName, args: unknown, caller: Caller): Promise<ToolAnswer>;
}

function failed(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function datasourceOf(args: unknown): string | null {
  const named = (args as { datasource?: unknown } | null)?.datasource;
  return typeof named === "string" ? named : null;
}

/** What Agent Activity names a call by: its statement, its key, or its table. */
function targetOf(args: unknown): string | null {
  const given = (args ?? {}) as Readonly<Record<string, unknown>>;
  for (const key of ["sql", "key", "handle", "console"] as const) {
    const value = given[key];
    if (typeof value === "string") return value;
  }
  const schema = typeof given.schema === "string" ? given.schema : null;
  const table = typeof given.table === "string" ? given.table : null;
  if (schema !== null && table !== null) return `${schema}.${table}`;
  return schema;
}

function rowCountOf(structured: Readonly<Record<string, unknown>>): number | null {
  const counted = structured.rowsAffected ?? structured.rowCount;
  if (typeof counted === "number") return counted;
  return Array.isArray(structured.rows) ? structured.rows.length : null;
}

export function createTools(context: ToolContext): Tools {
  const queries = createQueryTools(context);

  function run(name: ToolName, args: unknown, caller: Caller): Promise<ToolResult> | ToolResult {
    switch (name) {
      case "list_datasources":
        TOOL_ARGUMENTS.list_datasources.parse(args);
        return listDatasources(context);
      case "list_schemas":
        return listSchemas(context, TOOL_ARGUMENTS.list_schemas.parse(args).datasource);
      case "list_tables": {
        const parsed = TOOL_ARGUMENTS.list_tables.parse(args);
        return listTables(context, parsed.datasource, parsed.schema);
      }
      case "describe_table": {
        const parsed = TOOL_ARGUMENTS.describe_table.parse(args);
        return describeTable(context, parsed.datasource, parsed.schema, parsed.table);
      }
      case "get_ddl": {
        const parsed = TOOL_ARGUMENTS.get_ddl.parse(args);
        return getDdl(context, parsed.datasource, parsed.schema, parsed.table);
      }
      case "run_query": {
        const parsed = TOOL_ARGUMENTS.run_query.parse(args);
        return queries.runQuery(caller, parsed.datasource, parsed.sql, parsed.reason ?? null);
      }
      case "fetch_rows": {
        const parsed = TOOL_ARGUMENTS.fetch_rows.parse(args);
        return queries.fetchRows(parsed.handle, parsed.offset, parsed.limit);
      }
      case "close_result":
        return queries.closeResult(TOOL_ARGUMENTS.close_result.parse(args).handle);
      case "explain": {
        const parsed = TOOL_ARGUMENTS.explain.parse(args);
        return queries.explain(caller, parsed.datasource, parsed.sql);
      }
      case "format_sql": {
        const parsed = TOOL_ARGUMENTS.format_sql.parse(args);
        return queries.formatSql(parsed.datasource, parsed.sql);
      }
      case "check_sql": {
        const parsed = TOOL_ARGUMENTS.check_sql.parse(args);
        return checkSql(context, parsed.datasource, parsed.sql);
      }
      case "scan_keys": {
        const parsed = TOOL_ARGUMENTS.scan_keys.parse(args);
        return scanKeys(context, parsed.datasource, {
          pattern: parsed.pattern ?? MATCH_ALL,
          database: parsed.database,
          type: parsed.type,
          cursor: parsed.cursor,
          limit: parsed.limit ?? DEFAULT_SCAN_LIMIT,
        });
      }
      case "get_key": {
        const parsed = TOOL_ARGUMENTS.get_key.parse(args);
        return getKey(context, caller, parsed.datasource, parsed.key, parsed.database, parsed.reason ?? null);
      }
      case "open_in_console":
        return openInConsole(context, caller, TOOL_ARGUMENTS.open_in_console.parse(args));
      case "get_active_context":
        TOOL_ARGUMENTS.get_active_context.parse(args);
        return getActiveContext(context);
      case "edit_console": {
        const parsed = TOOL_ARGUMENTS.edit_console.parse(args);
        const edit: AgentEdit =
          parsed.text === undefined
            ? { kind: "replace", edits: parsed.edits ?? [] }
            : { kind: "whole", text: parsed.text, revision: parsed.revision ?? 0 };
        return editConsole(context, caller, {
          console: parsed.console,
          edit,
          select: parsed.select,
          focus: parsed.focus,
        });
      }
      case "read_console":
        return readConsole(context, caller, TOOL_ARGUMENTS.read_console.parse(args).console);
      case "list_consoles":
        TOOL_ARGUMENTS.list_consoles.parse(args);
        return listConsoles(context, caller);
      case "open_table":
        return openTableFor(context, TOOL_ARGUMENTS.open_table.parse(args));
      case "reveal_in_explorer":
        return revealInExplorer(context, TOOL_ARGUMENTS.reveal_in_explorer.parse(args));
    }
  }

  return {
    async call(name, args, caller) {
      const named = datasourceOf(args);
      const datasourceId =
        named === null ? null : (context.datasources().find((ds) => ds.id === named || ds.name === named)?.id ?? null);
      const target = targetOf(args);
      const refused = (message: string, outcome: Exclude<ToolAnswer["outcome"], "ok" | "capped">): ToolAnswer => ({
        result: failed(message),
        outcome,
        datasourceId,
        target,
        rowCount: null,
        message,
      });
      try {
        const result = await run(name, args ?? {}, caller);
        const structured = result.structuredContent ?? {};
        const capped = typeof structured.handle === "string";
        return {
          result,
          outcome: capped ? "capped" : "ok",
          datasourceId,
          target,
          rowCount: rowCountOf(structured),
          message: null,
        };
      } catch (cause) {
        if (cause instanceof ToolFailure)
          return refused(cause.message, cause.outcome === "capped" ? "error" : cause.outcome);
        if (cause instanceof EngineCallError)
          return refused(cause.hint === null ? cause.message : `${cause.message}\n${cause.hint}`, "error");
        if (cause instanceof z.ZodError) return refused(`Invalid arguments: ${z.prettifyError(cause)}`, "error");
        throw cause;
      }
    },
  };
}
