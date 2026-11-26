import type { Namespace, NamespaceCatalog, OpenedSession, ResultWindow } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";

export type PostgresCopyMode = "schema-data" | "schema-only" | "data-only";

export interface PostgresCopyProgress {
  readonly completed: number;
  readonly total: number;
  readonly current: string;
}

export interface PostgresCopyRequest {
  readonly source: EngineClient;
  readonly destination: EngineClient;
  readonly sourcePath: readonly string[];
  readonly destinationPath: readonly string[];
  readonly mode: PostgresCopyMode;
  /** JSON encoded [table] or [schema, table] identities; omitted means every table. */
  readonly selectedTables?: readonly string[];
  readonly onProgress?: (progress: PostgresCopyProgress) => void;
}

function schemaTableId(name: string): string {
  return JSON.stringify([name]);
}

function databaseTableId(schema: string, name: string): string {
  return JSON.stringify([schema, name]);
}

function schemaSelectionFor(
  selectedTables: readonly string[] | undefined,
  schema: string,
): readonly string[] | undefined {
  if (selectedTables === undefined) return undefined;
  return selectedTables.flatMap((id) => {
    try {
      const tuple: unknown = JSON.parse(id);
      return Array.isArray(tuple) && tuple.length === 2 && tuple[0] === schema && typeof tuple[1] === "string"
        ? [schemaTableId(tuple[1])]
        : [];
    } catch {
      return [];
    }
  });
}

export type VerificationStatus = "match" | "missing" | "extra" | "changed" | "mismatch" | "unverifiable";

export interface PostgresVerificationFinding {
  readonly object: string;
  readonly status: VerificationStatus;
  readonly detail: string;
}

const PAGE_ROWS = 256;
const INSERT_ROWS = 64;

function isSafeScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)))
  );
}

function parameterText(value: unknown): string | null {
  if (!isSafeScalar(value)) throw new Error("This value cannot be preserved safely as a SQL parameter.");
  return value === null ? null : String(value);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedName(path: readonly string[], name: string): string {
  return [...path.slice(-1), name].map(quoteIdentifier).join(".");
}

interface FetchState {
  readonly rowCount: number;
  readonly complete: boolean;
}

function assertUniqueObjects(source: NamespaceCatalog, destination: NamespaceCatalog, mode: PostgresCopyMode): void {
  if (mode === "data-only") return;
  const targetNames = new Set([
    ...destination.relations.map(({ name }) => name),
    ...destination.routines.map(({ name }) => name),
    ...destination.sequences.map(({ name }) => name),
  ]);
  const sourceNames = [
    ...source.relations.map(({ name }) => name),
    ...source.routines.map(({ name }) => name),
    ...source.sequences.map(({ name }) => name),
  ];
  const conflicts = sourceNames.filter((name) => targetNames.has(name));
  if (conflicts.length > 0) {
    throw new Error(`Destination already contains: ${conflicts.join(", ")}`);
  }
}

function hasStandaloneSequences(catalog: NamespaceCatalog): boolean {
  const generated = catalog.relations.reduce(
    (count, relation) => count + relation.columns.filter(({ autoIncrement }) => autoIncrement).length,
    0,
  );
  return catalog.sequences.length > generated;
}

function orderedTables(
  catalog: NamespaceCatalog,
  path: readonly string[],
): readonly NamespaceCatalog["relations"][number][] {
  const tables = catalog.relations.filter(({ kind }) => kind === "table");
  const byName = new Map(tables.map((relation) => [relation.name, relation]));
  const pending = new Map<string, Set<string>>();
  for (const table of tables) {
    const dependencies = new Set<string>();
    for (const foreignKey of table.foreignKeys) {
      if (
        foreignKey.target.path.length !== path.length ||
        foreignKey.target.path.some((part, index) => part !== path[index])
      ) {
        throw new Error(`Table ${table.name} references another schema; cross-schema data ordering is not supported.`);
      }
      if (foreignKey.target.relation === table.name) {
        throw new Error(
          `Table ${table.name} has a self-referencing foreign key; safe copy order cannot be guaranteed.`,
        );
      }
      if (byName.has(foreignKey.target.relation)) dependencies.add(foreignKey.target.relation);
    }
    pending.set(table.name, dependencies);
  }
  const ordered: (typeof tables)[number][] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) throw new Error("Circular foreign-key dependencies prevent a safe data copy.");
    for (const name of ready) {
      const relation = byName.get(name);
      if (relation !== undefined) ordered.push(relation);
      pending.delete(name);
      for (const dependencies of pending.values()) dependencies.delete(name);
    }
  }
  return ordered;
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

async function tableDigest(
  client: EngineClient,
  path: readonly string[],
  relation: NamespaceCatalog["relations"][number],
): Promise<{ readonly rows: number; readonly digest: string }> {
  const opened = await client.call<"session.open">("session.open", { readOnly: true });
  try {
    const query = await client.call<"statement.execute">("statement.execute", {
      sessionId: opened.sessionId,
      sql: `SELECT * FROM ${qualifiedName(path, relation.name)}`,
      pageRows: PAGE_ROWS,
      fetchAllCap: PAGE_ROWS,
    });
    const encoder = new TextEncoder();
    const modulus = 1n << 256n;
    let checksum = 0n;
    let rows = 0;
    let offset = 0;
    let state: FetchState = query;
    try {
      while (true) {
        while (offset < state.rowCount) {
          const page = await fetchPage(client, query.handle, offset);
          if (page.rows.length === 0) break;
          for (const row of page.rows) {
            if (row.length !== relation.columns.length || row.some((value) => !isSafeScalar(value))) {
              throw new Error("This table has values the local verifier cannot canonicalize safely.");
            }
            const canonical = JSON.stringify(
              row.map((value, index) => [relation.columns[index]?.type ?? "unknown", parameterText(value)]),
            );
            const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)));
            let value = 0n;
            for (const byte of hashed) value = (value << 8n) | BigInt(byte);
            checksum = (checksum + value) % modulus;
            rows++;
          }
          offset += page.rows.length;
        }
        if (state.complete) break;
        state = await client.call<"result.fetchMore">("result.fetchMore", {
          handle: query.handle,
          all: false,
          pageRows: PAGE_ROWS,
          fetchAllCap: PAGE_ROWS,
        });
      }
      return { rows, digest: checksum.toString(16).padStart(64, "0") };
    } finally {
      await client.call<"result.release">("result.release", { handle: query.handle }).catch(() => undefined);
    }
  } finally {
    await client.call<"session.close">("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
  }
}

async function describe(client: EngineClient, path: readonly string[]): Promise<NamespaceCatalog> {
  const result = await client.call<"catalog.describe">("catalog.describe", { path, refresh: true });
  return result.catalog;
}

async function hasSchema(client: EngineClient, path: readonly string[]): Promise<boolean> {
  const namespaces = await client.call<"catalog.namespaces">("catalog.namespaces", {});
  return namespaces.some(
    (candidate) => candidate.path.length === path.length && candidate.path.every((part, index) => part === path[index]),
  );
}

async function destinationPathFor(client: EngineClient, schema: string | undefined): Promise<readonly string[]> {
  if (schema === undefined) throw new Error("Schema name is missing.");
  const opened = await client.call<"session.open">("session.open", { readOnly: true });
  try {
    const database = opened.namespace?.[0];
    if (database === undefined) throw new Error("Could not identify the destination database.");
    return [database, schema];
  } finally {
    await client.call<"session.close">("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
  }
}

async function fetchPage(client: EngineClient, handle: string, offset: number): Promise<ResultWindow> {
  return client.call<"result.window">("result.window", { handle, offset, limit: PAGE_ROWS });
}

async function transferTable(
  source: EngineClient,
  destination: EngineClient,
  sourceSession: string,
  destinationSession: string,
  sourcePath: readonly string[],
  destinationPath: readonly string[],
  relation: NamespaceCatalog["relations"][number],
  onRows: (rows: number) => void,
): Promise<number> {
  const sourceName = qualifiedName(sourcePath, relation.name);
  const destinationName = qualifiedName(destinationPath, relation.name);
  const query = await source.call<"statement.execute">("statement.execute", {
    sessionId: sourceSession,
    sql: `SELECT * FROM ${sourceName}`,
    pageRows: PAGE_ROWS,
    fetchAllCap: PAGE_ROWS,
  });

  let offset = 0;
  let copied = 0;
  let state: FetchState = query;
  try {
    while (true) {
      while (offset < state.rowCount) {
        const page = await fetchPage(source, query.handle, offset);
        if (page.rows.length === 0) break;
        for (let start = 0; start < page.rows.length; start += INSERT_ROWS) {
          const batch = page.rows.slice(start, start + INSERT_ROWS);
          const columnNames = relation.columns.map(({ name }) => name);
          const columns = columnNames.map(quoteIdentifier).join(", ");
          const values = batch
            .map(
              (_, rowIndex) =>
                `(${columnNames.map((__, columnIndex) => `$${rowIndex * columnNames.length + columnIndex + 1}`).join(", ")})`,
            )
            .join(", ");
          const parameters = Object.fromEntries(
            batch.flatMap((row, rowIndex) =>
              [...row].map((value, columnIndex) => {
                if (!isSafeScalar(value)) {
                  throw new Error(
                    `Table ${relation.name} contains a value that cannot be copied safely through SQL parameters.`,
                  );
                }
                return [`$${rowIndex * columnNames.length + columnIndex + 1}`, parameterText(value)];
              }),
            ),
          );
          await destination.call<"statement.execute">("statement.execute", {
            sessionId: destinationSession,
            sql: `INSERT INTO ${destinationName} (${columns}) OVERRIDING SYSTEM VALUE VALUES ${values}`,
            parameters,
            redactError: true,
            pageRows: PAGE_ROWS,
            fetchAllCap: PAGE_ROWS,
          });
          copied += batch.length;
          onRows(copied);
        }
        offset += page.rows.length;
      }
      if (state.complete) break;
      state = await source.call<"result.fetchMore">("result.fetchMore", {
        handle: query.handle,
        all: false,
        pageRows: PAGE_ROWS,
        fetchAllCap: PAGE_ROWS,
      });
    }
    return copied;
  } finally {
    await source.call<"result.release">("result.release", { handle: query.handle }).catch(() => undefined);
  }
}

/** Copies one PostgreSQL schema over two local engine clients. */
export async function copyPostgresSchema(request: PostgresCopyRequest): Promise<void> {
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
  const { sessionId: sourceSession } = sourceOpened;
  const { sessionId: destinationSession } = destinationOpened;

  try {
    const sourceCatalog = await describe(request.source, request.sourcePath);
    if (request.mode !== "data-only" && sourceCatalog.routines.length > 0) {
      throw new Error(
        "Schema copy currently supports tables and views; this schema contains routines that need a separate migration.",
      );
    }
    if (request.mode !== "data-only" && hasStandaloneSequences(sourceCatalog)) {
      throw new Error("Schema copy cannot create standalone sequences yet.");
    }
    const schemaScript =
      request.mode === "data-only"
        ? null
        : await request.source.call<"catalog.script">("catalog.script", {
            path: request.sourcePath,
            kinds: ["table", "view", "materializedView"],
            title: "Copy PostgreSQL schema",
          });
    if (schemaScript !== null && schemaScript.failed > 0) {
      throw new Error(`PostgreSQL could not describe ${schemaScript.failed} schema objects.`);
    }
    const schemaName = request.sourcePath.at(-1);
    const destinationDatabase = destinationOpened.namespace?.[0];
    if (schemaName === undefined || destinationDatabase === undefined) {
      throw new Error("Could not identify the destination database and schema.");
    }
    if (request.destinationPath.at(-1) !== schemaName) {
      throw new Error("PostgreSQL schema copy requires the destination schema to use the source schema name.");
    }
    const destinationPath = [destinationDatabase, schemaName];
    const destinationSchemaExists = await hasSchema(request.destination, destinationPath);
    const hasSelectedTables =
      request.selectedTables === undefined ||
      sourceCatalog.relations.some(
        ({ kind, name }) => kind === "table" && request.selectedTables?.includes(schemaTableId(name)),
      );
    if (!destinationSchemaExists && request.mode === "data-only" && hasSelectedTables)
      throw new Error("Destination schema does not exist.");
    let destinationCatalog: NamespaceCatalog;
    const destinationSchemaMissing = !destinationSchemaExists;
    if (destinationSchemaExists) {
      destinationCatalog = await describe(request.destination, destinationPath);
    } else {
      destinationCatalog = { path: destinationPath, relations: [], routines: [], sequences: [] };
    }

    assertUniqueObjects(sourceCatalog, destinationCatalog, request.mode);
    const schemaRelations = sourceCatalog.relations;
    const selectedTables = request.selectedTables === undefined ? null : new Set(request.selectedTables);
    const dataCatalog =
      selectedTables === null
        ? sourceCatalog
        : {
            ...sourceCatalog,
            relations: sourceCatalog.relations.filter(
              ({ kind, name }) => kind === "table" && selectedTables.has(schemaTableId(name)),
            ),
          };
    const dataRelations = request.mode === "schema-only" ? [] : orderedTables(dataCatalog, request.sourcePath);
    const relations = request.mode === "data-only" ? dataRelations : schemaRelations;
    if (request.mode === "data-only") {
      const missing = relations.filter(
        ({ name }) => !destinationCatalog.relations.some((relation) => relation.name === name),
      );
      if (missing.length > 0)
        throw new Error(`Destination is missing tables: ${missing.map(({ name }) => name).join(", ")}`);
      for (const relation of relations) {
        const destinationRelation = destinationCatalog.relations.find(({ name }) => name === relation.name);
        if (destinationRelation === undefined || dataLayout(destinationRelation) !== dataLayout(relation))
          throw new Error(`Destination table ${relation.name} has a different column layout.`);
        const count = await request.destination.call<"statement.execute">("statement.execute", {
          sessionId: destinationSession,
          sql: `SELECT COUNT(*) AS count FROM ${qualifiedName(destinationPath, relation.name)}`,
          pageRows: 1,
          fetchAllCap: 1,
        });
        const countRow = count.firstWindow.rows[0];
        if (countRow?.[0] !== 0 && countRow?.[0] !== "0") {
          await request.destination
            .call<"result.release">("result.release", { handle: count.handle })
            .catch(() => undefined);
          throw new Error(`Destination table ${relation.name} already contains data.`);
        }
        await request.destination
          .call<"result.release">("result.release", { handle: count.handle })
          .catch(() => undefined);
      }
    }
    const schemaStatements =
      schemaScript === null || schemaScript.text.trim() === ""
        ? []
        : (await request.source.call<"script.split">("script.split", { text: schemaScript.text })).map(
            ({ sql }) => sql,
          );
    const total =
      (request.mode === "data-only" ? 0 : schemaStatements.length + Number(destinationSchemaMissing)) +
      (request.mode === "schema-only"
        ? 0
        : dataRelations.length + schemaRelations.filter(({ kind }) => kind === "materializedView").length);
    let completed = 0;

    if (request.mode !== "data-only") {
      await request.destination.call<"statement.execute">("statement.execute", {
        sessionId: destinationSession,
        sql: "BEGIN",
        pageRows: PAGE_ROWS,
        fetchAllCap: PAGE_ROWS,
      });
      try {
        if (destinationSchemaMissing) {
          await request.destination.call<"statement.execute">("statement.execute", {
            sessionId: destinationSession,
            sql: `CREATE SCHEMA ${quoteIdentifier(schemaName)}`,
            pageRows: PAGE_ROWS,
            fetchAllCap: PAGE_ROWS,
          });
          completed++;
          request.onProgress?.({ completed, total, current: `Create schema ${schemaName}` });
        }
        for (const [index, statement] of schemaStatements.entries()) {
          await request.destination.call<"statement.execute">("statement.execute", {
            sessionId: destinationSession,
            sql: statement,
            pageRows: PAGE_ROWS,
            fetchAllCap: PAGE_ROWS,
          });
          completed++;
          request.onProgress?.({
            completed,
            total,
            current: `Schema statement ${index + 1} of ${schemaStatements.length}`,
          });
        }
        await request.destination.call<"statement.execute">("statement.execute", {
          sessionId: destinationSession,
          sql: "COMMIT",
          pageRows: PAGE_ROWS,
          fetchAllCap: PAGE_ROWS,
        });
      } catch (cause) {
        await request.destination
          .call<"statement.execute">("statement.execute", {
            sessionId: destinationSession,
            sql: "ROLLBACK",
            pageRows: PAGE_ROWS,
            fetchAllCap: PAGE_ROWS,
          })
          .catch(() => undefined);
        throw cause;
      }
    }

    if (request.mode !== "schema-only") {
      const existing =
        request.mode === "data-only" ? new Set(destinationCatalog.relations.map(({ name }) => name)) : null;
      for (const relation of dataRelations) {
        if (existing !== null && !existing.has(relation.name)) {
          throw new Error(`Destination table ${relation.name} does not exist.`);
        }
        await request.destination.call<"statement.execute">("statement.execute", {
          sessionId: destinationSession,
          sql: "BEGIN",
          pageRows: PAGE_ROWS,
          fetchAllCap: PAGE_ROWS,
        });
        let count: number;
        try {
          count = await transferTable(
            request.source,
            request.destination,
            sourceSession,
            destinationSession,
            request.sourcePath,
            destinationPath,
            relation,
            (rows) => request.onProgress?.({ completed, total, current: `${relation.name}: ${rows} rows` }),
          );
          await request.destination.call<"statement.execute">("statement.execute", {
            sessionId: destinationSession,
            sql: "COMMIT",
            pageRows: PAGE_ROWS,
            fetchAllCap: PAGE_ROWS,
          });
        } catch (cause) {
          await request.destination
            .call<"statement.execute">("statement.execute", {
              sessionId: destinationSession,
              sql: "ROLLBACK",
              pageRows: PAGE_ROWS,
              fetchAllCap: PAGE_ROWS,
            })
            .catch(() => undefined);
          const safeReason =
            cause instanceof Error && cause.message.includes("cannot be copied safely")
              ? cause.message
              : "The destination rejected a row batch; this table was rolled back.";
          throw new Error(`${relation.name}: ${safeReason}`, { cause });
        }
        completed++;
        request.onProgress?.({ completed, total, current: `${relation.name}: ${count} rows copied` });
      }
      for (const relation of schemaRelations.filter(({ kind }) => kind === "materializedView")) {
        await request.destination.call<"statement.execute">("statement.execute", {
          sessionId: destinationSession,
          sql: `REFRESH MATERIALIZED VIEW ${qualifiedName(destinationPath, relation.name)}`,
          pageRows: PAGE_ROWS,
          fetchAllCap: PAGE_ROWS,
        });
        completed++;
        request.onProgress?.({ completed, total, current: `${relation.name}: materialized view refreshed` });
      }
    }
  } finally {
    await Promise.allSettled([
      request.source.call<"session.close">("session.close", { sessionId: sourceSession }),
      request.destination.call<"session.close">("session.close", { sessionId: destinationSession }),
    ]);
  }
}

/** Copies every non-system schema in the current PostgreSQL database to a matching database. */
export async function copyPostgresDatabase(
  request: Omit<PostgresCopyRequest, "sourcePath" | "destinationPath">,
): Promise<void> {
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
  const sourceDatabase = sourceOpened.namespace?.[0];
  const destinationDatabase = destinationOpened.namespace?.[0];
  if (sourceDatabase === undefined || destinationDatabase === undefined) {
    await Promise.allSettled([
      request.source.call<"session.close">("session.close", { sessionId: sourceOpened.sessionId }),
      request.destination.call<"session.close">("session.close", { sessionId: destinationOpened.sessionId }),
    ]);
    throw new Error("Could not identify both PostgreSQL databases.");
  }
  let schemas: readonly Namespace[];
  let destinationSchemas: readonly Namespace[];
  try {
    schemas = await request.source.call<"catalog.namespaces">("catalog.namespaces", {});
    destinationSchemas = await request.destination.call<"catalog.namespaces">("catalog.namespaces", {});
  } catch (cause) {
    await Promise.allSettled([
      request.source.call<"session.close">("session.close", { sessionId: sourceOpened.sessionId }),
      request.destination.call<"session.close">("session.close", { sessionId: destinationOpened.sessionId }),
    ]);
    throw cause;
  }
  const selected = schemas.filter(
    ({ path }) =>
      path.length === 2 && path[1] !== undefined && path[1] !== "information_schema" && !path[1].startsWith("pg_"),
  );
  try {
    // Preflight the full schema selection before the first destination write.
    for (const [schemaIndex, { path: schemaPath }] of selected.entries()) {
      const schemaName = schemaPath[1];
      if (schemaName === undefined) continue;
      request.onProgress?.({
        completed: schemaIndex,
        total: selected.length,
        current: `Preparing schema ${schemaName}`,
      });
      const sourcePath = [sourceDatabase, schemaName];
      const destinationPath = [destinationDatabase, schemaName];
      const sourceCatalog = await describe(request.source, sourcePath);
      const chosenIds = request.selectedTables === undefined ? null : new Set(request.selectedTables);
      const chosenCatalog =
        chosenIds === null
          ? sourceCatalog
          : {
              ...sourceCatalog,
              relations: sourceCatalog.relations.filter(
                ({ kind, name }) => kind === "table" && chosenIds.has(databaseTableId(schemaName, name)),
              ),
            };
      const chosenTables = request.mode === "schema-only" ? [] : orderedTables(chosenCatalog, sourcePath);
      if (request.mode !== "data-only" && sourceCatalog.routines.length > 0) {
        throw new Error(`Schema ${schemaName} contains routines that need a separate migration.`);
      }
      if (request.mode !== "data-only" && hasStandaloneSequences(sourceCatalog)) {
        throw new Error(`Schema ${schemaName} contains standalone sequences that are not supported yet.`);
      }
      if (request.mode !== "data-only") {
        const script = await request.source.call<"catalog.script">("catalog.script", {
          path: sourcePath,
          kinds: ["table", "view", "materializedView"],
          title: "Preflight PostgreSQL database copy",
        });
        if (script.failed > 0)
          throw new Error(`PostgreSQL could not describe ${script.failed} objects in ${schemaName}.`);
      }
      const destinationSchemaExists = destinationSchemas.some(
        ({ path }) => path.length === 2 && path[0] === destinationDatabase && path[1] === schemaName,
      );
      if (!destinationSchemaExists) {
        if (request.mode === "data-only" && chosenTables.length === 0) continue;
        if (request.mode === "data-only") throw new Error(`Destination schema ${schemaName} does not exist.`);
        continue;
      }
      let destinationCatalog: NamespaceCatalog;
      {
        destinationCatalog = await describe(request.destination, destinationPath);
      }
      if (request.mode !== "data-only") {
        const existing = new Set(destinationCatalog.relations.map(({ name }) => name));
        const conflicts = sourceCatalog.relations.filter(({ name }) => existing.has(name));
        const destinationSequenceNames = new Set(destinationCatalog.sequences.map(({ name }) => name));
        const sequenceConflicts = sourceCatalog.sequences.filter(({ name }) => destinationSequenceNames.has(name));
        const allConflicts = [...conflicts.map(({ name }) => name), ...sequenceConflicts.map(({ name }) => name)];
        if (allConflicts.length > 0) {
          throw new Error(`Destination schema ${schemaName} already contains objects: ${allConflicts.join(", ")}`);
        }
      } else {
        const missing = chosenTables.filter(
          ({ name }) => !destinationCatalog.relations.some((relation) => relation.name === name),
        );
        if (missing.length > 0) {
          throw new Error(
            `Destination schema ${schemaName} is missing tables: ${missing.map(({ name }) => name).join(", ")}`,
          );
        }
        for (const relation of chosenTables) {
          const destinationRelation = destinationCatalog.relations.find(({ name }) => name === relation.name);
          if (destinationRelation === undefined || dataLayout(destinationRelation) !== dataLayout(relation))
            throw new Error(`Destination table ${schemaName}.${relation.name} has a different column layout.`);
          const count = await request.destination.call<"statement.execute">("statement.execute", {
            sessionId: destinationOpened.sessionId,
            sql: `SELECT COUNT(*) AS count FROM ${qualifiedName(destinationPath, relation.name)}`,
            pageRows: 1,
            fetchAllCap: 1,
          });
          const countValue = count.firstWindow.rows[0]?.[0];
          await request.destination
            .call<"result.release">("result.release", { handle: count.handle })
            .catch(() => undefined);
          if (countValue !== 0 && countValue !== "0") {
            throw new Error(`Destination table ${schemaName}.${relation.name} already contains data.`);
          }
        }
      }
    }
  } finally {
    await Promise.allSettled([
      request.source.call<"session.close">("session.close", { sessionId: sourceOpened.sessionId }),
      request.destination.call<"session.close">("session.close", { sessionId: destinationOpened.sessionId }),
    ]);
  }

  const completed: string[] = [];
  for (const { path: schemaPath } of selected) {
    const schemaName = schemaPath[1];
    if (schemaName === undefined) continue;
    try {
      await copyPostgresSchema({
        ...request,
        sourcePath: [sourceDatabase, schemaName],
        destinationPath: [destinationDatabase, schemaName],
        selectedTables: schemaSelectionFor(request.selectedTables, schemaName),
        onProgress: (progress) =>
          request.onProgress?.({
            ...progress,
            current: `${schemaName}.${progress.current}`,
          }),
      });
      completed.push(schemaName);
    } catch {
      const alreadyCopied =
        completed.length === 0 ? "No schema completed." : `Completed schemas: ${completed.join(", ")}.`;
      throw new Error(`Copy stopped in schema ${schemaName}. ${alreadyCopied}`);
    }
  }
}

/** Read-only definition comparison for supported table objects in one schema. */
export async function verifyPostgresSchema(
  source: EngineClient,
  destination: EngineClient,
  sourcePath: readonly string[],
  destinationPath: readonly string[],
): Promise<readonly PostgresVerificationFinding[]> {
  destinationPath = await destinationPathFor(destination, destinationPath.at(-1));
  if (!(await hasSchema(destination, destinationPath))) {
    return [{ object: destinationPath.join("."), status: "missing", detail: "Destination schema is missing." }];
  }
  const [left, right] = await Promise.all([describe(source, sourcePath), describe(destination, destinationPath)]);
  const sourceRelations = left.relations;
  const destinationRelations = right.relations;
  const sourceNames = new Set(sourceRelations.map(({ name }) => name));
  const destinationNames = new Set(destinationRelations.map(({ name }) => name));
  const findings: PostgresVerificationFinding[] = [];
  for (const relation of sourceRelations) {
    if (!destinationNames.has(relation.name)) {
      findings.push({
        object: `${sourcePath.at(-1)}.${relation.name}`,
        status: "missing",
        detail: "Destination table is missing.",
      });
      continue;
    }
    try {
      const [sourceDefinition, destinationDefinition] = await Promise.all([
        source.call<"catalog.definition">("catalog.definition", { path: sourcePath, name: relation.name }),
        destination.call<"catalog.definition">("catalog.definition", { path: destinationPath, name: relation.name }),
      ]);
      findings.push({
        object: `${sourcePath.at(-1)}.${relation.name}`,
        status: sourceDefinition === destinationDefinition ? "match" : "changed",
        detail: sourceDefinition === destinationDefinition ? "Definitions match." : "Definitions differ.",
      });
    } catch {
      findings.push({
        object: `${sourcePath.at(-1)}.${relation.name}`,
        status: "unverifiable",
        detail: "Definition could not be read.",
      });
    }
  }
  for (const relation of destinationRelations) {
    if (!sourceNames.has(relation.name)) {
      findings.push({
        object: `${destinationPath.at(-1)}.${relation.name}`,
        status: "extra",
        detail: "Destination has an extra table.",
      });
    }
  }
  for (const routine of left.routines) {
    findings.push({
      object: `${sourcePath.at(-1)}.${routine.name}`,
      status: "unverifiable",
      detail: "Routine definitions are outside the supported comparison set.",
    });
  }
  for (const sequence of left.sequences) {
    findings.push({
      object: `${sourcePath.at(-1)}.${sequence.name}`,
      status: "unverifiable",
      detail: "Sequence state is outside the supported comparison set.",
    });
  }
  return findings;
}

/** Compares row counts and order-independent, type-tagged SHA-256 row digests per table. */
export async function verifyPostgresData(
  source: EngineClient,
  destination: EngineClient,
  sourcePath: readonly string[],
  destinationPath: readonly string[],
): Promise<readonly PostgresVerificationFinding[]> {
  destinationPath = await destinationPathFor(destination, destinationPath.at(-1));
  if (!(await hasSchema(destination, destinationPath))) {
    return [{ object: destinationPath.join("."), status: "missing", detail: "Destination schema is missing." }];
  }
  const [left, right] = await Promise.all([describe(source, sourcePath), describe(destination, destinationPath)]);
  const destinationByName = new Map(
    right.relations.filter(({ kind }) => kind === "table").map((relation) => [relation.name, relation]),
  );
  const findings: PostgresVerificationFinding[] = [];
  for (const relation of left.relations.filter(({ kind }) => kind === "table")) {
    const target = destinationByName.get(relation.name);
    const object = `${sourcePath.at(-1)}.${relation.name}`;
    if (target === undefined) {
      findings.push({ object, status: "missing", detail: "Destination table is missing." });
      continue;
    }
    try {
      const [sourceDigest, destinationDigest] = await Promise.all([
        tableDigest(source, sourcePath, relation),
        tableDigest(destination, destinationPath, target),
      ]);
      const same = sourceDigest.rows === destinationDigest.rows && sourceDigest.digest === destinationDigest.digest;
      findings.push({
        object,
        status: same ? "match" : "mismatch",
        detail: same
          ? `${sourceDigest.rows} rows match.`
          : `Row count or content digest differs (${sourceDigest.rows} vs ${destinationDigest.rows} rows).`,
      });
    } catch {
      findings.push({ object, status: "unverifiable", detail: "One or more values cannot be compared safely." });
    }
  }
  const sourceNames = new Set(left.relations.filter(({ kind }) => kind === "table").map(({ name }) => name));
  for (const relation of right.relations.filter(({ kind }) => kind === "table")) {
    if (!sourceNames.has(relation.name)) {
      findings.push({
        object: `${destinationPath.at(-1)}.${relation.name}`,
        status: "extra",
        detail: "Destination has an extra table.",
      });
    }
  }
  return findings;
}
