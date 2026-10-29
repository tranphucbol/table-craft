import { describeTable, listSchemas, listTables } from "@table-craft/desktop/mcp/catalogTools.js";
import { INVALID_PARAMS, RpcError } from "@table-craft/desktop/mcp/jsonrpc.js";
import { ToolFailure, type ToolContext, type ToolResult } from "@table-craft/desktop/mcp/toolKit.js";
import { EngineCallError } from "@table-craft/desktop/mcp/engines.js";
import { AGENT_ACCESS_LABELS } from "@table-craft/desktop/settings/mcp.js";

export const RESOURCE_SCHEME = "tablecraft://";
/** MCP's code for a resource that does not exist (2025-06-18 server/resources). */
export const RESOURCE_NOT_FOUND = -32002;
const TEXT = "text/plain";
const SEPARATOR = "/";
const MAX_SEGMENTS = 3;

export function resourceUri(...segments: readonly string[]): string {
  return `${RESOURCE_SCHEME}${segments.map((segment) => encodeURIComponent(segment)).join(SEPARATOR)}`;
}

/** The datasource, schema and table a `tablecraft://` URI names; null when it is not one. */
export function parseResourceUri(uri: string): readonly string[] | null {
  if (!uri.startsWith(RESOURCE_SCHEME)) return null;
  const segments = uri.slice(RESOURCE_SCHEME.length).split(SEPARATOR);
  if (segments.length > MAX_SEGMENTS || segments.some((segment) => segment === "")) return null;
  try {
    return segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: `${RESOURCE_SCHEME}{datasource}/{schema}`,
    name: "schema",
    title: "Schema",
    description: "The tables and views of one schema.",
    mimeType: TEXT,
  },
  {
    uriTemplate: `${RESOURCE_SCHEME}{datasource}/{schema}/{table}`,
    name: "table",
    title: "Table",
    description: "Columns, keys and indexes of one table or view.",
    mimeType: TEXT,
  },
] as const;

export function listResources(context: ToolContext): unknown {
  return {
    resources: context
      .datasources()
      .filter((datasource) => datasource.access !== "off")
      .map((datasource) => ({
        uri: resourceUri(datasource.id),
        name: datasource.id,
        title: datasource.name,
        description: `The schemas of ${datasource.name} (${datasource.pluginId}, ${AGENT_ACCESS_LABELS[datasource.access]}).`,
        mimeType: TEXT,
      })),
  };
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

export async function readResource(context: ToolContext, uri: string): Promise<unknown> {
  const segments = parseResourceUri(uri);
  if (segments === null) throw new RpcError(RESOURCE_NOT_FOUND, `Not a TableCraft resource: ${uri}`);
  const [datasource = "", schema, table] = segments;
  try {
    const result =
      schema === undefined
        ? await listSchemas(context, datasource)
        : table === undefined
          ? await listTables(context, datasource, schema)
          : await describeTable(context, datasource, schema, table);
    return { contents: [{ uri, mimeType: TEXT, text: textOf(result) }] };
  } catch (cause) {
    if (cause instanceof ToolFailure || cause instanceof EngineCallError)
      throw new RpcError(RESOURCE_NOT_FOUND, cause.message);
    throw cause;
  }
}

interface PromptArgument {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
}

interface PromptSpec {
  readonly title: string;
  readonly description: string;
  readonly arguments: readonly PromptArgument[];
  readonly text: (args: Readonly<Record<string, string>>) => string;
}

const DATASOURCE_ARGUMENT: PromptArgument = {
  name: "datasource",
  description: "The datasource id from list_datasources.",
  required: true,
};

const PROMPTS: Readonly<Record<string, PromptSpec>> = {
  explore_datasource: {
    title: "Explore a datasource",
    description: "Map a datasource's schemas and main tables before working with it.",
    arguments: [DATASOURCE_ARGUMENT],
    text: ({ datasource = "" }) =>
      `Explore the TableCraft datasource ${datasource}. Call list_schemas, then list_tables for the schemas that matter, and describe_table for the central tables. Summarise what the data is about, the main tables and how they relate through foreign keys. Read only; do not change anything.`,
  },
  write_query: {
    title: "Write a query",
    description: "Answer a question about the data with one read-only query.",
    arguments: [DATASOURCE_ARGUMENT, { name: "question", description: "What to find out.", required: true }],
    text: ({ datasource = "", question = "" }) =>
      `Using the TableCraft datasource ${datasource}, answer: ${question}\nFirst find the tables involved with list_tables and describe_table, write one SELECT in the datasource's dialect, check it with check_sql, then run it with run_query. Show the query and explain the result.`,
  },
};

export function listPrompts(): unknown {
  return {
    prompts: Object.entries(PROMPTS).map(([name, prompt]) => ({
      name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  };
}

export function getPrompt(name: string, args: Readonly<Record<string, unknown>>): unknown {
  const prompt = Object.hasOwn(PROMPTS, name) ? PROMPTS[name] : undefined;
  if (prompt === undefined) throw new RpcError(INVALID_PARAMS, `Unknown prompt: ${name}.`);
  const values: Record<string, string> = {};
  for (const argument of prompt.arguments) {
    const value = args[argument.name];
    if (typeof value !== "string" || value === "") {
      if (argument.required) throw new RpcError(INVALID_PARAMS, `The prompt needs the ${argument.name} argument.`);
      continue;
    }
    values[argument.name] = value;
  }
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text: prompt.text(values) } }],
  };
}
