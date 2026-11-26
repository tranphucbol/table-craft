import type { Namespace, NamespaceCatalog, OpenedSession } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";

export type MysqlCopyMode = "schema-data" | "schema-only" | "data-only";

export interface MysqlCopyRequest {
  readonly source: EngineClient;
  readonly destination: EngineClient;
  readonly sourcePath: readonly string[];
  readonly destinationPath: readonly string[];
  readonly mode: MysqlCopyMode;
  /** Table names to transfer; omitted means every table. */
  readonly selectedTables?: readonly string[];
  readonly onProgress?: (progress: {
    readonly completed: number;
    readonly total: number;
    readonly current: string;
  }) => void;
}

export interface MysqlCopyReport {
  readonly skippedObjects: {
    readonly routines: number;
    readonly triggers: number;
    readonly events: number;
  };
}

export type MysqlVerificationStatus = "match" | "missing" | "extra" | "changed" | "mismatch" | "unverifiable";
export interface MysqlVerificationFinding {
  readonly object: string;
  readonly status: MysqlVerificationStatus;
  readonly detail: string;
}

const PAGE_ROWS = 1_000;
const INSERT_ROWS = 64;
const SYSTEM_DATABASES = new Set(["information_schema", "mysql", "performance_schema", "sys", "metrics_schema"]);

interface WireTag {
  readonly kind: "bigint" | "date" | "json" | "bytes";
  readonly value?: string;
  readonly iso?: string;
  readonly text?: string;
}

function quoteIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function qualifiedName(path: readonly string[], name: string): string {
  return [...path.slice(-1), name].map(quoteIdentifier).join(".");
}

function normalizeAutoIncrement(sql: string): string {
  const open = sql.indexOf("(");
  if (open < 0) return sql;
  let depth = 0;
  let quote = "";
  for (let index = open; index < sql.length; index++) {
    const char = sql[index] ?? "";
    if (quote !== "") {
      if (char === "\\") index++;
      else if (char === quote && sql[index + 1] === quote) index++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) {
      const head = sql.slice(0, index + 1);
      const tail = sql.slice(index + 1).replace(/\bAUTO_INCREMENT\s*=\s*\d+/gi, "AUTO_INCREMENT=0");
      return head + tail;
    }
  }
  return sql;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function orderViewDefinitions(
  definitions: readonly { readonly name: string; readonly sql: string }[],
): readonly { readonly name: string; readonly sql: string }[] {
  const names = new Set(definitions.map(({ name }) => name));
  const pending = new Map<string, Set<string>>();
  for (const view of definitions) {
    const dependencies = new Set<string>();
    for (const candidate of names) {
      if (candidate === view.name) continue;
      const name = regexEscape(candidate);
      const pattern = new RegExp("\\b(?:FROM|JOIN)\\s+(?:`(?:``|[^`])+`\\s*\\.\\s*)?`" + name + "`", "i");
      if (pattern.test(view.sql)) dependencies.add(candidate);
    }
    pending.set(view.name, dependencies);
  }
  const ordered: (typeof definitions)[number][] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) throw new Error("Circular view dependencies prevent a safe copy.");
    for (const name of ready) {
      const definition = definitions.find((item) => item.name === name);
      if (definition !== undefined) ordered.push(definition);
      pending.delete(name);
      for (const dependencies of pending.values()) dependencies.delete(name);
    }
  }
  return ordered;
}

/** Repoints quoted database-qualified identifiers in catalog DDL without changing strings or comments. */
function rewriteQualifiedDatabase(sql: string, source: string, destination: string): string {
  if (source === destination) return sql;
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'" || char === '"') {
      const quote = char;
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === "\\") {
          index = Math.min(index + 2, sql.length);
        } else if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
        } else if (sql[index] === quote) {
          index++;
          break;
        } else {
          index++;
        }
      }
      output += sql.slice(start, index);
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      const after = end === -1 ? sql.length : end + 2;
      output += sql.slice(index, after);
      index = after;
      continue;
    }
    if (char === "#" || (char === "-" && next === "-" && /\s/.test(sql[index + 2] ?? ""))) {
      const start = index;
      while (index < sql.length && sql[index] !== "\n") index++;
      output += sql.slice(start, index);
      continue;
    }
    if (char === "`") {
      const start = index++;
      let identifier = "";
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "`" && sql[index + 1] === "`") {
          identifier += "`";
          index += 2;
        } else if (sql[index] === "`") {
          index++;
          closed = true;
          break;
        } else {
          identifier += sql[index];
          index++;
        }
      }
      if (closed && identifier === source && /\b(?:FROM|JOIN|REFERENCES)\s*$/i.test(output)) {
        let afterIdentifier = index;
        while (/\s/.test(sql[afterIdentifier] ?? "")) afterIdentifier++;
        if (sql[afterIdentifier] === ".") {
          output += `${quoteIdentifier(destination)}${sql.slice(index, afterIdentifier)}`;
          index = afterIdentifier;
          continue;
        }
      }
      output += sql.slice(start, index);
      continue;
    }
    output += char ?? "";
    index++;
  }
  return output;
}

function scalarText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  ) {
    return String(value);
  }
  if (typeof value === "object" && value !== null && "kind" in value) {
    const tagged = value as WireTag;
    if (tagged.kind === "bigint" && typeof tagged.value === "string") return tagged.value;
    if (tagged.kind === "date" && typeof tagged.iso === "string") return tagged.iso;
    if (tagged.kind === "json" && typeof tagged.text === "string") return tagged.text;
  }
  throw new Error("This value cannot be preserved safely through MySQL parameters.");
}

function isCanonicalValue(value: unknown): boolean {
  try {
    scalarText(value);
    return true;
  } catch {
    return false;
  }
}

async function queryRows(
  client: EngineClient,
  sessionId: string,
  sql: string,
  values: readonly (string | null)[] = [],
) {
  const parameters = Object.fromEntries(values.map((value, index) => [`?${index + 1}`, value]));
  const rows: (readonly unknown[])[] = [];
  for (let offset = 0; ; offset += PAGE_ROWS) {
    const pagedSql = `${sql} LIMIT ${PAGE_ROWS} OFFSET ${offset}`;
    const result = await client.call<"statement.execute">("statement.execute", {
      sessionId,
      sql: pagedSql,
      ...(values.length === 0 ? {} : { parameters }),
      pageRows: PAGE_ROWS,
      fetchAllCap: PAGE_ROWS,
    });
    rows.push(...result.firstWindow.rows);
    await client.call<"result.release">("result.release", { handle: result.handle }).catch(() => undefined);
    if (result.firstWindow.rows.length < PAGE_ROWS) return rows;
  }
}

async function describe(client: EngineClient, path: readonly string[]): Promise<NamespaceCatalog> {
  return (await client.call<"catalog.describe">("catalog.describe", { path, refresh: true })).catalog;
}

async function namespaces(client: EngineClient): Promise<readonly Namespace[]> {
  return client.call<"catalog.namespaces">("catalog.namespaces", { refresh: true });
}

function hasNamespace(list: readonly Namespace[], path: readonly string[]): boolean {
  return list.some((item) => item.path.length === path.length && item.path.every((part, i) => part === path[i]));
}

function dataLayout(relation: NamespaceCatalog["relations"][number]): string {
  return JSON.stringify({
    columns: relation.columns,
    primaryKey: relation.primaryKey?.columns ?? null,
    uniqueKeys: relation.uniqueKeys
      .map(({ columns }) => columns)
      .sort((a, b) => a.join("\0").localeCompare(b.join("\0"))),
    foreignKeys: relation.foreignKeys
      .map(({ columns, target, onDelete, onUpdate }) => ({
        columns,
        target: { relation: target.relation, columns: target.columns },
        onDelete,
        onUpdate,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}

function assertSafeSource(
  catalog: NamespaceCatalog,
  db: string,
  metadata: { routines: number; triggers: number; events: number; generated: string[]; engines: Map<string, string> },
  options: { allowOmittedObjects?: boolean } = {},
): readonly NamespaceCatalog["relations"][number][] {
  if (!options.allowOmittedObjects && (metadata.routines > 0 || metadata.triggers > 0 || metadata.events > 0)) {
    throw new Error("Copy supports tables and views only. Routines, triggers, and events must be migrated separately.");
  }
  if (metadata.generated.length > 0) {
    throw new Error(`Generated columns are not supported: ${metadata.generated.join(", ")}.`);
  }
  const tables = catalog.relations.filter(({ kind }) => kind === "table");
  const byName = new Set(tables.map(({ name }) => name));
  const pending = new Map<string, Set<string>>();
  for (const table of tables) {
    const engine = metadata.engines.get(table.name)?.toLowerCase();
    if (engine !== "innodb")
      throw new Error(`Table ${table.name} uses ${engine ?? "an unknown engine"}; only InnoDB tables can be copied.`);
    const dependencies = new Set<string>();
    for (const foreignKey of table.foreignKeys) {
      if (foreignKey.target.path.length !== 1 || foreignKey.target.path[0] !== db) {
        throw new Error(`Table ${table.name} has a cross-database foreign key; safe copy order cannot be guaranteed.`);
      }
      if (foreignKey.target.relation === table.name)
        throw new Error(`Table ${table.name} has a self-referencing foreign key that is not supported.`);
      if (byName.has(foreignKey.target.relation)) dependencies.add(foreignKey.target.relation);
    }
    pending.set(table.name, dependencies);
  }
  const ordered: (typeof tables)[number][] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) throw new Error("Circular foreign-key dependencies prevent a safe copy.");
    for (const name of ready) {
      const table = tables.find((item) => item.name === name);
      if (table !== undefined) ordered.push(table);
      pending.delete(name);
      for (const deps of pending.values()) deps.delete(name);
    }
  }
  return ordered;
}

async function readMetadata(client: EngineClient, sessionId: string, db: string, tableNames?: readonly string[]) {
  const [routines, triggers, events] =
    tableNames === undefined
      ? await Promise.all([
          queryRows(
            client,
            sessionId,
            "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
            [db],
          ),
          queryRows(
            client,
            sessionId,
            "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?",
            [db],
          ),
          queryRows(client, sessionId, "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?", [db]),
        ])
      : [[], [], []];
  const filter = tableNames === undefined ? "" : ` AND TABLE_NAME IN (${tableNames.map(() => "?").join(", ")})`;
  const parameters = tableNames === undefined ? [db] : [db, ...tableNames];
  const [columns, tables] =
    tableNames !== undefined && tableNames.length === 0
      ? [[], []]
      : await Promise.all([
          queryRows(
            client,
            sessionId,
            `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND GENERATION_EXPRESSION IS NOT NULL AND GENERATION_EXPRESSION <> ''${filter}`,
            parameters,
          ),
          queryRows(
            client,
            sessionId,
            `SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'${filter}`,
            parameters,
          ),
        ]);
  const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  };
  return {
    routines: routines.length,
    triggers: triggers.length,
    events: events.length,
    generated: columns.map((row) => `${text(row[0])}.${text(row[1])}`),
    engines: new Map(tables.map((row) => [text(row[0]), text(row[1])])),
  };
}

async function transferTable(
  source: EngineClient,
  destination: EngineClient,
  sourceSession: string,
  destinationSession: string,
  sourcePath: readonly string[],
  destinationPath: readonly string[],
  relation: NamespaceCatalog["relations"][number],
  onRows: (count: number) => void,
): Promise<number> {
  let copied = 0;
  const columns = relation.columns.map(({ name }) => name);
  const projection = relation.columns
    .map(({ name, type }) =>
      /^(?:tinyint\s*\(\s*1\s*\)(?:\s+unsigned)?|bool|boolean)$/i.test(type.trim())
        ? `CAST(${quoteIdentifier(name)} AS SIGNED) AS ${quoteIdentifier(name)}`
        : quoteIdentifier(name),
    )
    .join(", ");
  for (let offset = 0; ; offset += PAGE_ROWS) {
    const query = await source.call<"statement.execute">("statement.execute", {
      sessionId: sourceSession,
      sql: `SELECT ${projection} FROM ${qualifiedName(sourcePath, relation.name)} LIMIT ${PAGE_ROWS} OFFSET ${offset}`,
      pageRows: PAGE_ROWS,
      fetchAllCap: PAGE_ROWS,
    });
    const rows = query.firstWindow.rows;
    await source.call<"result.release">("result.release", { handle: query.handle }).catch(() => undefined);
    if (rows.length === 0) return copied;
    const columnCount = Math.max(relation.columns.length, 1);
    const batchSize = Math.max(1, Math.min(INSERT_ROWS, Math.floor(60_000 / columnCount)));
    for (let start = 0; start < rows.length; start += batchSize) {
      const batch = rows.slice(start, start + batchSize);
      const values = batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
      const parameters = Object.fromEntries(
        batch.flatMap((row, rowIndex) =>
          row.map((value, columnIndex) => {
            try {
              return [`?${rowIndex * columns.length + columnIndex + 1}`, scalarText(value)];
            } catch {
              throw new Error(`Table ${relation.name} contains a value that cannot be copied safely.`);
            }
          }),
        ),
      );
      await destination.call<"statement.execute">("statement.execute", {
        sessionId: destinationSession,
        sql: `INSERT INTO ${qualifiedName(destinationPath, relation.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES ${values}`,
        parameters,
        redactError: true,
        pageRows: PAGE_ROWS,
        fetchAllCap: PAGE_ROWS,
      });
      copied += batch.length;
      onRows(copied);
    }
    if (rows.length < PAGE_ROWS) return copied;
  }
}

async function tableDigest(
  client: EngineClient,
  path: readonly string[],
  relation: NamespaceCatalog["relations"][number],
): Promise<{ rows: number; digest: string }> {
  const opened = await client.call<"session.open">("session.open", { readOnly: true });
  try {
    const encoder = new TextEncoder();
    const modulus = 1n << 256n;
    let checksum = 0n;
    let rows = 0;
    const projection = relation.columns
      .map(({ name, type }) =>
        /^(?:tinyint\s*\(\s*1\s*\)(?:\s+unsigned)?|bool|boolean)$/i.test(type.trim())
          ? `CAST(${quoteIdentifier(name)} AS SIGNED) AS ${quoteIdentifier(name)}`
          : quoteIdentifier(name),
      )
      .join(", ");
    for (let offset = 0; ; offset += PAGE_ROWS) {
      const query = await client.call<"statement.execute">("statement.execute", {
        sessionId: opened.sessionId,
        sql: `SELECT ${projection} FROM ${qualifiedName(path, relation.name)} LIMIT ${PAGE_ROWS} OFFSET ${offset}`,
        pageRows: PAGE_ROWS,
        fetchAllCap: PAGE_ROWS,
      });
      const pageRows = query.firstWindow.rows;
      await client.call<"result.release">("result.release", { handle: query.handle }).catch(() => undefined);
      for (const row of pageRows) {
        if (row.length !== relation.columns.length || row.some((value) => !isCanonicalValue(value)))
          throw new Error("unsupported value");
        const canonical = JSON.stringify(
          row.map((value, i) => [relation.columns[i]?.type ?? "unknown", scalarText(value)]),
        );
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)));
        let number = 0n;
        for (const byte of hash) number = (number << 8n) | BigInt(byte);
        checksum = (checksum + number) % modulus;
        rows++;
      }
      if (pageRows.length < PAGE_ROWS) return { rows, digest: checksum.toString(16).padStart(64, "0") };
    }
  } finally {
    await client.call<"session.close">("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
  }
}

/** Copies supported MySQL objects and selected rows into an existing destination database. */
export async function copyMysqlDatabase(request: MysqlCopyRequest): Promise<MysqlCopyReport> {
  const sourceDatabase = request.sourcePath[0];
  const destinationDatabase = request.destinationPath[0];
  if (
    request.sourcePath.length !== 1 ||
    sourceDatabase === undefined ||
    SYSTEM_DATABASES.has(sourceDatabase.toLowerCase())
  )
    throw new Error("Select a non-system MySQL database to copy.");
  if (
    request.destinationPath.length !== 1 ||
    destinationDatabase === undefined ||
    SYSTEM_DATABASES.has(destinationDatabase.toLowerCase())
  )
    throw new Error("Choose an existing non-system MySQL destination database.");
  if (request.source === request.destination && sourceDatabase === destinationDatabase)
    throw new Error("Choose a destination database other than the selected source database.");
  const sourceOpened = await request.source.call<"session.open">("session.open", { readOnly: true });
  let destinationOpened: OpenedSession;
  try {
    destinationOpened = await request.destination.call<"session.open">("session.open", {});
  } catch (cause) {
    await request.source
      .call<"session.close">("session.close", { sessionId: sourceOpened.sessionId })
      .catch(() => undefined);
    throw cause;
  }
  try {
    request.onProgress?.({ completed: 0, total: 0, current: "Inspecting selected tables" });
    const sourceCatalog = await describe(request.source, [sourceDatabase]);
    const chosenNames = request.selectedTables === undefined ? null : new Set(request.selectedTables);
    const candidateTables = sourceCatalog.relations.filter(
      ({ kind, name }) => kind === "table" && (chosenNames === null || chosenNames.has(name)),
    );
    const sourceMetadata = await readMetadata(
      request.source,
      sourceOpened.sessionId,
      sourceDatabase,
      request.mode === "data-only" ? candidateTables.map(({ name }) => name) : undefined,
    );
    const sourceCheckCatalog =
      request.mode === "data-only" ? { ...sourceCatalog, relations: candidateTables } : sourceCatalog;
    const sourceCheckMetadata =
      request.mode === "data-only"
        ? {
            ...sourceMetadata,
            routines: 0,
            triggers: 0,
            events: 0,
            generated: sourceMetadata.generated,
            engines: sourceMetadata.engines,
          }
        : sourceMetadata;
    const allOrdered = assertSafeSource(sourceCheckCatalog, sourceDatabase, sourceCheckMetadata, {
      allowOmittedObjects: request.mode !== "data-only",
    });
    const ordered =
      request.mode === "data-only" || chosenNames === null
        ? allOrdered
        : allOrdered.filter(({ name }) => chosenNames.has(name));
    const destinationNamespaces = await namespaces(request.destination);
    if (!hasNamespace(destinationNamespaces, request.destinationPath))
      throw new Error(`Destination database ${destinationDatabase} does not exist.`);
    const destinationCatalog = await describe(request.destination, request.destinationPath);
    if (request.mode === "data-only") {
      const destinationMetadata = await readMetadata(
        request.destination,
        destinationOpened.sessionId,
        destinationDatabase,
        ordered.map(({ name }) => name),
      );
      const destinationCheckCatalog = {
        ...destinationCatalog,
        relations: destinationCatalog.relations.filter(
          ({ kind, name }) => kind === "table" && (chosenNames === null || chosenNames.has(name)),
        ),
      };
      const destinationCheckMetadata = {
        ...destinationMetadata,
        routines: 0,
        triggers: 0,
        events: 0,
        generated: destinationMetadata.generated,
        engines: destinationMetadata.engines,
      };
      assertSafeSource(destinationCheckCatalog, destinationDatabase, destinationCheckMetadata);
      const targetNames = new Set(
        destinationCatalog.relations.filter(({ kind }) => kind === "table").map(({ name }) => name),
      );
      for (const table of ordered) {
        if (!targetNames.has(table.name)) throw new Error(`Destination database is missing table ${table.name}.`);
        const target = destinationCatalog.relations.find(({ name }) => name === table.name);
        if (target === undefined || dataLayout(target) !== dataLayout(table))
          throw new Error(`Destination table ${table.name} has a different column layout.`);
        const rows = await queryRows(
          request.destination,
          destinationOpened.sessionId,
          `SELECT COUNT(*) FROM ${qualifiedName(request.destinationPath, table.name)}`,
        );
        const count = rows[0]?.[0];
        if (count !== 0 && count !== "0") throw new Error(`Destination table ${table.name} already contains data.`);
      }
    } else {
      const collisions = sourceCatalog.relations.filter(({ name }) =>
        destinationCatalog.relations.some((item) => item.name === name),
      );
      if (collisions.length > 0)
        throw new Error(`Destination already contains: ${collisions.map(({ name }) => name).join(", ")}`);
    }

    let schemaStatements: string[] = [];
    if (request.mode !== "data-only") {
      const schemaRelations = [...allOrdered, ...sourceCatalog.relations.filter(({ kind }) => kind !== "table")];
      const definitions = await Promise.all(
        schemaRelations.map(async (relation) => ({
          relation,
          definition: await request.source.call<"catalog.definition">("catalog.definition", {
            path: request.sourcePath,
            name: relation.name,
          }),
        })),
      );
      const tableDefinitions = definitions.filter(({ relation }) => relation.kind === "table");
      const viewDefinitions = orderViewDefinitions(
        definitions
          .filter(({ relation }) => relation.kind !== "table")
          .map(({ relation, definition }) => ({ name: relation.name, sql: definition })),
      ).map(({ name }) => definitions.find((item) => item.relation.name === name)!);
      schemaStatements = await Promise.all(
        [...tableDefinitions, ...viewDefinitions].map(async ({ relation, definition }) => {
          const normalized = rewriteQualifiedDatabase(
            normalizeAutoIncrement(definition),
            sourceDatabase,
            destinationDatabase,
          );
          const targetName = quoteIdentifier(relation.name);
          const objectName =
            /\b(TABLE|VIEW)\s+((?:`(?:``|[^`])+`|"(?:""|[^"])+"|[^\s]+)(?:\s*\.\s*(?:`(?:``|[^`])+`|"(?:""|[^"])+"|[^\s]+))?)/i;
          if (!objectName.test(normalized))
            throw new Error(`Could not safely rewrite the definition for ${relation.name}.`);
          const rewritten = normalized.replace(objectName, (_match, kind: string) => `${kind} ${targetName}`);
          if (sourceDatabase !== destinationDatabase) {
            const escapedDatabase = regexEscape(sourceDatabase);
            const unresolvedSourceQualifier = new RegExp(
              "(`" + escapedDatabase + "`|\\b" + escapedDatabase + "\\b)\\s*\\.",
              "i",
            );
            if (unresolvedSourceQualifier.test(rewritten))
              throw new Error(`The definition for ${relation.name} contains an ambiguous source-database reference.`);
          }
          const split = await request.destination.call<"script.split">("script.split", { text: rewritten });
          if (split.length !== 1)
            throw new Error(`The definition for ${relation.name} did not split into one statement.`);
          return rewritten;
        }),
      );
    }

    const schemaSplitStatements = await Promise.all(
      schemaStatements.map(async (text) => {
        const split = await request.destination.call<"script.split">("script.split", { text });
        if (split.length !== 1) throw new Error("A MySQL schema object did not split into one statement.");
        return split[0]?.sql ?? text;
      }),
    );
    const total =
      (request.mode === "data-only" ? 0 : schemaSplitStatements.length) +
      (request.mode === "schema-only" ? 0 : ordered.length);
    let completed = 0;

    if (request.mode !== "data-only") {
      await request.destination.call<"statement.execute">("statement.execute", {
        sessionId: destinationOpened.sessionId,
        sql: `USE ${quoteIdentifier(destinationDatabase)}`,
        pageRows: PAGE_ROWS,
        fetchAllCap: PAGE_ROWS,
      });
      for (const [index, rewritten] of schemaSplitStatements.entries()) {
        await request.destination.call<"statement.execute">("statement.execute", {
          sessionId: destinationOpened.sessionId,
          sql: rewritten,
          redactError: true,
          pageRows: PAGE_ROWS,
          fetchAllCap: PAGE_ROWS,
        });
        completed++;
        request.onProgress?.({
          completed,
          total,
          current: `Schema object ${index + 1} of ${schemaSplitStatements.length}`,
        });
      }
    }

    if (request.mode !== "schema-only") {
      const targetCatalog =
        request.mode === "data-only"
          ? destinationCatalog
          : await describe(request.destination, request.destinationPath);
      const targetTables = new Set(
        targetCatalog.relations.filter(({ kind }) => kind === "table").map(({ name }) => name),
      );
      for (const relation of ordered) {
        if (!targetTables.has(relation.name)) throw new Error(`Destination table ${relation.name} is missing.`);
        await request.destination.call<"statement.execute">("statement.execute", {
          sessionId: destinationOpened.sessionId,
          sql: "START TRANSACTION",
          pageRows: PAGE_ROWS,
          fetchAllCap: PAGE_ROWS,
        });
        try {
          const emptyCheck = await request.destination.call<"statement.execute">("statement.execute", {
            sessionId: destinationOpened.sessionId,
            sql: `SELECT 1 FROM ${qualifiedName(request.destinationPath, relation.name)} LIMIT 1 FOR UPDATE`,
            pageRows: PAGE_ROWS,
            fetchAllCap: PAGE_ROWS,
          });
          const targetHasRows = emptyCheck.firstWindow.rows.length > 0;
          await request.destination
            .call<"result.release">("result.release", { handle: emptyCheck.handle })
            .catch(() => undefined);
          if (targetHasRows) throw new Error("Destination table is no longer empty; copy stopped to protect its data.");
          const count = await transferTable(
            request.source,
            request.destination,
            sourceOpened.sessionId,
            destinationOpened.sessionId,
            request.sourcePath,
            request.destinationPath,
            relation,
            (rows) => request.onProgress?.({ completed, total, current: `${relation.name}: ${rows} rows` }),
          );
          await request.destination.call<"statement.execute">("statement.execute", {
            sessionId: destinationOpened.sessionId,
            sql: "COMMIT",
            pageRows: PAGE_ROWS,
            fetchAllCap: PAGE_ROWS,
          });
          completed++;
          request.onProgress?.({ completed, total, current: `${relation.name}: ${count} rows copied` });
        } catch (cause) {
          await request.destination
            .call<"statement.execute">("statement.execute", {
              sessionId: destinationOpened.sessionId,
              sql: "ROLLBACK",
              pageRows: PAGE_ROWS,
              fetchAllCap: PAGE_ROWS,
            })
            .catch(() => undefined);
          throw new Error(`${relation.name}: table copy failed; its current transaction was rolled back.`, { cause });
        }
      }
    }
    return {
      skippedObjects:
        request.mode === "data-only"
          ? { routines: 0, triggers: 0, events: 0 }
          : {
              routines: sourceMetadata.routines,
              triggers: sourceMetadata.triggers,
              events: sourceMetadata.events,
            },
    };
  } finally {
    await Promise.allSettled([
      request.source.call<"session.close">("session.close", { sessionId: sourceOpened.sessionId }),
      request.destination.call<"session.close">("session.close", { sessionId: destinationOpened.sessionId }),
    ]);
  }
}

/** Compares MySQL table/view definitions and reports unsupported routines separately. */
export async function verifyMysqlSchema(
  source: EngineClient,
  destination: EngineClient,
  sourcePath: readonly string[],
  destinationPath: readonly string[],
): Promise<readonly MysqlVerificationFinding[]> {
  const db = sourcePath[0];
  if (sourcePath.length !== 1 || db === undefined) throw new Error("Select a MySQL database.");
  const targetPath = destinationPath.length === 1 ? destinationPath : [db];
  if (!hasNamespace(await namespaces(destination), targetPath))
    return [{ object: db, status: "missing", detail: "Destination database is missing." }];
  const [left, right] = await Promise.all([describe(source, sourcePath), describe(destination, targetPath)]);
  const rightByName = new Map(right.relations.map((item) => [item.name, item]));
  const leftNames = new Set(left.relations.map((item) => item.name));
  const findings: MysqlVerificationFinding[] = [];
  for (const relation of left.relations) {
    const target = rightByName.get(relation.name);
    if (target === undefined) {
      findings.push({ object: relation.name, status: "missing", detail: "Destination object is missing." });
      continue;
    }
    try {
      const [a, b] = await Promise.all([
        source.call<"catalog.definition">("catalog.definition", { path: sourcePath, name: relation.name }),
        destination.call<"catalog.definition">("catalog.definition", { path: targetPath, name: relation.name }),
      ]);
      const normalize = (value: string, database: string) =>
        rewriteQualifiedDatabase(normalizeAutoIncrement(value), database, "__database__").trim();
      const same = normalize(a, sourcePath[0] ?? "") === normalize(b, targetPath[0] ?? "");
      findings.push({
        object: relation.name,
        status: same ? "match" : "changed",
        detail: same ? "Definitions match." : "Definitions differ.",
      });
    } catch {
      findings.push({ object: relation.name, status: "unverifiable", detail: "Definition could not be read." });
    }
  }
  for (const relation of right.relations)
    if (!leftNames.has(relation.name))
      findings.push({ object: relation.name, status: "extra", detail: "Destination has an extra object." });
  for (const routine of left.routines)
    findings.push({
      object: routine.name,
      status: "unverifiable",
      detail: "Routine definitions are outside the supported comparison set.",
    });
  return findings;
}

/** Compares row counts and order-independent row digests for MySQL tables. */
export async function verifyMysqlData(
  source: EngineClient,
  destination: EngineClient,
  sourcePath: readonly string[],
  destinationPath: readonly string[],
): Promise<readonly MysqlVerificationFinding[]> {
  const db = sourcePath[0];
  if (sourcePath.length !== 1 || db === undefined) throw new Error("Select a MySQL database.");
  const targetPath = destinationPath.length === 1 ? destinationPath : [db];
  if (!hasNamespace(await namespaces(destination), targetPath))
    return [{ object: db, status: "missing", detail: "Destination database is missing." }];
  const [left, right] = await Promise.all([describe(source, sourcePath), describe(destination, targetPath)]);
  const targets = new Map(
    right.relations.filter(({ kind }) => kind === "table").map((relation) => [relation.name, relation]),
  );
  const findings: MysqlVerificationFinding[] = [];
  for (const relation of left.relations.filter(({ kind }) => kind === "table")) {
    const target = targets.get(relation.name);
    if (target === undefined) {
      findings.push({ object: relation.name, status: "missing", detail: "Destination table is missing." });
      continue;
    }
    try {
      const [a, b] = await Promise.all([
        tableDigest(source, sourcePath, relation),
        tableDigest(destination, targetPath, target),
      ]);
      const same = a.rows === b.rows && a.digest === b.digest;
      findings.push({
        object: relation.name,
        status: same ? "match" : "mismatch",
        detail: same ? `${a.rows} rows match.` : `Row count or content differs (${a.rows} vs ${b.rows} rows).`,
      });
    } catch {
      findings.push({
        object: relation.name,
        status: "unverifiable",
        detail: "One or more values cannot be compared safely.",
      });
    }
  }
  for (const [name] of targets)
    if (!left.relations.some((item) => item.name === name && item.kind === "table"))
      findings.push({ object: name, status: "extra", detail: "Destination has an extra table." });
  return findings;
}
