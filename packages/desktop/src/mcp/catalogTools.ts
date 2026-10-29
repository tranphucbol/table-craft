import type { Namespace, Relation } from "@table-craft/desktop/engine/protocol.js";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import type { AgentEngine } from "@table-craft/desktop/mcp/engines.js";
import {
  engineWith,
  exposedDatasource,
  shown,
  textResult,
  ToolFailure,
  type ToolContext,
  type ToolResult,
} from "@table-craft/desktop/mcp/toolKit.js";
import { AGENT_ACCESS_LABELS } from "@table-craft/desktop/settings/mcp.js";

const PATH_SEPARATOR = ".";

function pathText(path: readonly string[]): string {
  return path.join(PATH_SEPARATOR);
}

export function listDatasources(context: ToolContext): ToolResult {
  const exposed = context.datasources().filter((datasource) => datasource.access !== "off");
  if (exposed.length === 0) {
    return textResult(
      "No datasource is exposed to agents. The user turns access on in TableCraft: Settings › MCP Server.",
      { datasources: [] },
    );
  }
  const datasources = exposed.map((datasource) => ({
    id: datasource.id,
    name: datasource.name,
    plugin: datasource.pluginId,
    access: datasource.access,
    comment: datasource.comment,
  }));
  const lines = exposed.map(
    (datasource) =>
      `- ${datasource.id}: ${datasource.name} (${datasource.pluginId}, ${AGENT_ACCESS_LABELS[datasource.access]})${datasource.comment === null ? "" : ` — ${datasource.comment}`}`,
  );
  return textResult(lines.join("\n"), { datasources });
}

async function shownNamespaces(engine: AgentEngine, datasource: AgentDatasource): Promise<readonly Namespace[]> {
  const namespaces = await engine.call("catalog.namespaces", {});
  return namespaces.filter((namespace) => shown(datasource, namespace.path));
}

export async function listSchemas(context: ToolContext, named: string): Promise<ToolResult> {
  const datasource = exposedDatasource(context, named);
  const engine = await engineWith(context, datasource, ["schemaTree"]);
  const namespaces = await shownNamespaces(engine, datasource);
  const schemas = namespaces.map((namespace) => ({
    schema: pathText(namespace.path),
    kind: namespace.kind,
    system: namespace.system,
    current: namespace.current,
  }));
  const lines = schemas.map(
    (schema) =>
      `- ${schema.schema} (${schema.kind}${schema.current ? ", current" : ""}${schema.system ? ", system" : ""})`,
  );
  return textResult(lines.length === 0 ? "No schemas are shown for this datasource." : lines.join("\n"), { schemas });
}

async function resolvePath(
  engine: AgentEngine,
  datasource: AgentDatasource,
  schema: string,
): Promise<readonly string[]> {
  const namespaces = await shownNamespaces(engine, datasource);
  const exact = namespaces.find((namespace) => pathText(namespace.path) === schema);
  if (exact !== undefined) return exact.path;
  const byName = namespaces.filter((namespace) => namespace.name === schema);
  const [only] = byName;
  if (byName.length === 1 && only !== undefined) return only.path;
  throw new ToolFailure(
    `No schema "${schema}" is shown for ${datasource.name}. Call list_schemas for the ones that are.`,
  );
}

async function relationsOf(
  context: ToolContext,
  named: string,
  schema: string,
): Promise<{
  readonly engine: AgentEngine;
  readonly path: readonly string[];
  readonly relations: readonly Relation[];
}> {
  const datasource = exposedDatasource(context, named);
  const engine = await engineWith(context, datasource, ["schemaTree"]);
  const path = await resolvePath(engine, datasource, schema);
  const described = await engine.call("catalog.describe", { path });
  return { engine, path, relations: described.catalog.relations };
}

export async function listTables(context: ToolContext, named: string, schema: string): Promise<ToolResult> {
  const { path, relations } = await relationsOf(context, named, schema);
  const tables = relations.map((relation) => ({
    name: relation.name,
    kind: relation.kind,
    columns: relation.columns.length,
    comment: relation.comment,
  }));
  const lines = tables.map(
    (table) =>
      `- ${table.name} (${table.kind}, ${String(table.columns)} columns)${table.comment === null ? "" : ` — ${table.comment}`}`,
  );
  return textResult(lines.length === 0 ? `${pathText(path)} has no tables or views.` : lines.join("\n"), {
    schema: pathText(path),
    tables,
  });
}

function relationNamed(relations: readonly Relation[], table: string, schema: string): Relation {
  const relation = relations.find((candidate) => candidate.name === table);
  if (relation === undefined) throw new ToolFailure(`No table or view "${table}" in ${schema}. Call list_tables.`);
  return relation;
}

export async function describeTable(
  context: ToolContext,
  named: string,
  schema: string,
  table: string,
): Promise<ToolResult> {
  const { path, relations } = await relationsOf(context, named, schema);
  const relation = relationNamed(relations, table, pathText(path));
  const columns = relation.columns.map(
    (column) =>
      `  ${column.name} ${column.type}${column.nullable ? "" : " NOT NULL"}${column.default === null ? "" : ` DEFAULT ${column.default}`}${column.autoIncrement ? " AUTO_INCREMENT" : ""}${column.comment === null ? "" : ` -- ${column.comment}`}`,
  );
  const keys = [
    ...(relation.primaryKey === null ? [] : [`  PRIMARY KEY (${relation.primaryKey.columns.join(", ")})`]),
    ...relation.uniqueKeys.map((key) => `  UNIQUE ${key.name} (${key.columns.join(", ")})`),
    ...relation.foreignKeys.map(
      (key) =>
        `  FOREIGN KEY ${key.name} (${key.columns.join(", ")}) REFERENCES ${pathText([...key.target.path, key.target.relation])} (${key.target.columns.join(", ")})`,
    ),
    ...relation.indexes
      .filter((index) => !index.primary)
      .map((index) => `  ${index.unique ? "UNIQUE INDEX" : "INDEX"} ${index.name} (${index.columns.join(", ")})`),
  ];
  const text = [
    `${relation.kind} ${pathText([...path, relation.name])}${relation.comment === null ? "" : ` -- ${relation.comment}`}`,
    "Columns:",
    ...columns,
    ...(keys.length === 0 ? [] : ["Keys:", ...keys]),
  ].join("\n");
  return textResult(text, { schema: pathText(path), table: relation as unknown as Readonly<Record<string, unknown>> });
}

export async function getDdl(context: ToolContext, named: string, schema: string, table: string): Promise<ToolResult> {
  const datasource = exposedDatasource(context, named);
  const engine = await engineWith(context, datasource, ["schemaTree", "ddl"]);
  const path = await resolvePath(engine, datasource, schema);
  const ddl = await engine.call("catalog.definition", { path, name: table });
  return textResult(ddl, { ddl });
}
