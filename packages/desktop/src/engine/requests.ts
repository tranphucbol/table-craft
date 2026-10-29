import { EXPORT_FORMATS, EXTRACTOR_KINDS, IMPORT_ENCODINGS, IMPORT_ESCAPES } from "@table-craft/core";
import {
  FORMAT_STYLES,
  GENERATED_STATEMENTS,
  KEY_TYPES,
  KEYWORD_CASES,
  OBJECT_KINDS,
  TRANSACTION_MODES,
  z,
} from "@table-craft/plugin-api";
import { ERROR_ANSWERS, ON_ERROR_CHOICES, type EngineRequest } from "@table-craft/desktop/engine/protocol.js";
import {
  EXPORT_STALL_SECONDS_RANGE,
  FETCH_ALL_CAP_RANGE,
  INDENT_WIDTH_RANGE,
  LINES_BETWEEN_STATEMENTS_RANGE,
  PAGE_ROWS_RANGE,
  STATEMENT_TIMEOUT_SECONDS_RANGE,
} from "@table-craft/desktop/settings/settings.js";

const requestId = z.number().int().nonnegative();
const handle = z.string().min(1);
const sessionId = z.string().min(1);
const namespacePath = z.array(z.string()).min(1);
const index = z.number().int().nonnegative();
const extractor = z.enum(EXTRACTOR_KINDS);
const columns = z.array(index);
const relation = z.string().min(1);
const keyName = z.strictObject({
  text: z.string(),
  hex: z
    .string()
    .regex(/^(?:[0-9a-f]{2})+$/)
    .nullable(),
});
const keyNames = z.array(keyName).min(1);
const keyChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("setString"), value: keyName, original: keyName.nullable() }),
  z.strictObject({ kind: z.literal("setField"), field: keyName, value: keyName, original: keyName.nullable() }),
  z.strictObject({ kind: z.literal("deleteField"), field: keyName, original: keyName }),
  z.strictObject({ kind: z.literal("setIndex"), index: z.number().int(), value: keyName, original: keyName }),
  z.strictObject({ kind: z.literal("deleteIndex"), index: z.number().int(), original: keyName }),
  z.strictObject({ kind: z.literal("push"), value: keyName }),
  z.strictObject({ kind: z.literal("addMember"), member: keyName }),
  z.strictObject({ kind: z.literal("deleteMember"), member: keyName }),
  z.strictObject({
    kind: z.literal("setScore"),
    member: keyName,
    score: z.number(),
    original: z.number().nullable(),
  }),
  z.strictObject({ kind: z.literal("addEntry"), fields: z.array(z.tuple([keyName, keyName])).min(1) }),
  z.strictObject({ kind: z.literal("deleteEntry"), id: z.string().min(1) }),
]);
const keyChanges = z.array(keyChange).min(1);
const keyApplyOptions = z.strictObject({
  type: z.enum(KEY_TYPES),
  guard: z.boolean(),
  ttlMs: z.number().int().positive().optional(),
});
const taskId = z.string().min(1);
const sessionTarget = z.strictObject({ id: z.string().min(1), instance: z.string().min(1).nullable() });
const stallSeconds = z.number().int().min(EXPORT_STALL_SECONDS_RANGE.min).max(EXPORT_STALL_SECONDS_RANGE.max);
const exportSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("result"), handle, columns, shownOnly: z.boolean().optional() }),
  z.strictObject({ kind: z.literal("table"), path: namespacePath, relation, columns: z.array(z.string().min(1)) }),
]);
/** Matches the renderer's `INSPECTION_MAX_TEXT` (plan 108): longer consoles are not inspected live. */
const MAX_INSPECTION_TEXT = 200_000;
/** Longer than any search a person types; bounds the regular expression the engine compiles. */
const MAX_FIND_LENGTH = 1_000;
/** `SLOWLOG GET` keeps 128 entries by default; the Server tab asks for that many. */
const SLOW_LOG_MAX = 1_000;
const viewSpec = z.strictObject({
  find: z
    .strictObject({
      text: z.string().max(MAX_FIND_LENGTH),
      caseSensitive: z.boolean(),
      regex: z.boolean(),
      wholeCell: z.boolean(),
    })
    .nullable(),
  rowsOnly: z.boolean(),
  filters: z.array(
    z.discriminatedUnion("op", [
      z.strictObject({ column: index, op: z.literal("equals"), text: z.string() }),
      z.strictObject({ column: index, op: z.literal("notEquals"), text: z.string() }),
      z.strictObject({ column: index, op: z.literal("isNull") }),
      z.strictObject({ column: index, op: z.literal("isNotNull") }),
    ]),
  ),
  columns,
  formats: z.strictObject({ groupDigits: z.boolean() }),
});
const GENERATOR_STATEMENTS = ["create", ...GENERATED_STATEMENTS] as const;
const file = z.string().min(1);
const oneCharacter = z.string().length(1);
const importFormat = z.strictObject({
  delimiter: oneCharacter,
  quote: oneCharacter.nullable(),
  escape: z.enum(IMPORT_ESCAPES),
  header: z.boolean(),
  encoding: z.enum(IMPORT_ENCODINGS),
  nullToken: z.string(),
  trim: z.boolean(),
});
const newImportColumns = z
  .array(z.strictObject({ name: z.string().min(1), type: z.string().min(1), field: index }))
  .min(1);
const importTarget = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("table"),
    path: namespacePath,
    relation,
    mapping: z.array(z.strictObject({ column: z.string().min(1), field: index })).min(1),
  }),
  z.strictObject({ kind: z.literal("new"), path: namespacePath, relation, columns: newImportColumns }),
]);
const name = z.string();
const names = z.array(z.string().min(1));
const original = z.string().min(1).nullable();
const tableDesign = z.strictObject({
  name,
  comment: z.string().nullable(),
  columns: z.array(
    z.strictObject({
      name,
      type: z.string(),
      nullable: z.boolean(),
      default: z.string().nullable(),
      autoIncrement: z.boolean(),
      comment: z.string().nullable(),
      original,
    }),
  ),
  primaryKey: names,
  primaryKeyName: z.string().nullable(),
  indexes: z.array(z.strictObject({ name, columns: names, unique: z.boolean(), original })),
  foreignKeys: z.array(
    z.strictObject({
      name,
      columns: names,
      target: z.strictObject({ path: namespacePath, relation: z.string(), columns: names }),
      onDelete: z.string().nullable(),
      onUpdate: z.string().nullable(),
      original,
    }),
  ),
  checks: z.array(z.strictObject({ name, expression: z.string(), original })),
});
const catalogObject = z.strictObject({ kind: z.enum(OBJECT_KINDS), name: relation });
const objectChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("createTable"), path: namespacePath, design: tableDesign }),
  z.strictObject({ kind: z.literal("alterTable"), path: namespacePath, relation, design: tableDesign }),
  z.strictObject({ kind: z.literal("rename"), path: namespacePath, object: catalogObject, name }),
  z.strictObject({ kind: z.literal("drop"), path: namespacePath, object: catalogObject, cascade: z.boolean() }),
  z.strictObject({ kind: z.literal("truncate"), path: namespacePath, relation, cascade: z.boolean() }),
  z.strictObject({ kind: z.literal("createNamespace"), path: z.array(z.string()), name }),
]);
const importTransaction = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("all") }),
  z.strictObject({ mode: z.literal("every"), rows: z.number().int().positive() }),
]);
const importErrors = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("stop") }),
  z.strictObject({ mode: z.literal("skip"), limit: z.number().int().nonnegative() }),
]);
const paging = {
  pageRows: z.number().int().min(PAGE_ROWS_RANGE.min).max(PAGE_ROWS_RANGE.max),
  fetchAllCap: z.number().int().min(FETCH_ALL_CAP_RANGE.min).max(FETCH_ALL_CAP_RANGE.max),
};
const timeoutSeconds = z
  .number()
  .int()
  .min(STATEMENT_TIMEOUT_SECONDS_RANGE.min)
  .max(STATEMENT_TIMEOUT_SECONDS_RANGE.max)
  .optional();
const cellInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({ kind: z.literal("null") }),
  z.strictObject({ kind: z.literal("default") }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("bytes"), id: z.string().min(1), length: index, preview: z.string() }),
]);
const edits = z.array(
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("update"),
      row: index,
      values: z.array(z.strictObject({ column: index, value: cellInput })),
    }),
    z.strictObject({ kind: z.literal("insert"), values: z.array(cellInput) }),
    z.strictObject({ kind: z.literal("delete"), row: index }),
  ]),
);

/** The renderer is untrusted input: every request is parsed before it is routed. */
export const engineRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: requestId, type: z.literal("session.open"), readOnly: z.boolean().optional() }),
  z.strictObject({ id: requestId, type: z.literal("session.close"), sessionId }),
  z.strictObject({
    id: requestId,
    type: z.literal("statement.execute"),
    sessionId,
    sql: z.string(),
    parameters: z.record(z.string(), z.string().nullable()).optional(),
    ...paging,
    timeoutSeconds,
    node: z.string().min(1).optional(),
    repeat: z.number().int().min(2).optional(),
  }),
  z.strictObject({ id: requestId, type: z.literal("statement.cancel"), sessionId }),
  z.strictObject({ id: requestId, type: z.literal("script.split"), text: z.string() }),
  z.strictObject({
    id: requestId,
    type: z.literal("sql.format"),
    text: z.string(),
    options: z.strictObject({
      style: z.enum(FORMAT_STYLES),
      keywordCase: z.enum(KEYWORD_CASES),
      indentWidth: z.number().int().min(INDENT_WIDTH_RANGE.min).max(INDENT_WIDTH_RANGE.max),
      linesBetweenStatements: z
        .number()
        .int()
        .min(LINES_BETWEEN_STATEMENTS_RANGE.min)
        .max(LINES_BETWEEN_STATEMENTS_RANGE.max),
      alignAliases: z.boolean(),
    }),
  }),
  z.strictObject({ id: requestId, type: z.literal("sql.explainable"), sql: z.string(), analyze: z.boolean() }),
  z.strictObject({
    id: requestId,
    type: z.literal("statement.explain"),
    sessionId,
    sql: z.string(),
    analyze: z.boolean(),
    timeoutSeconds,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("transaction.setMode"),
    sessionId,
    mode: z.enum(TRANSACTION_MODES),
  }),
  z.strictObject({ id: requestId, type: z.literal("transaction.commit"), sessionId }),
  z.strictObject({ id: requestId, type: z.literal("transaction.rollback"), sessionId }),
  z.strictObject({
    id: requestId,
    type: z.literal("result.window"),
    handle,
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
  z.strictObject({ id: requestId, type: z.literal("result.release"), handle }),
  z.strictObject({ id: requestId, type: z.literal("result.fetchMore"), handle, all: z.boolean(), ...paging }),
  z.strictObject({ id: requestId, type: z.literal("result.stopFetch"), handle }),
  z.strictObject({
    id: requestId,
    type: z.literal("result.sort"),
    handle,
    keys: z.array(z.strictObject({ column: index, direction: z.enum(["asc", "desc"]) })),
  }),
  z.strictObject({ id: requestId, type: z.literal("result.view"), handle, spec: viewSpec.nullable() }),
  z.strictObject({ id: requestId, type: z.literal("result.viewState"), handle }),
  z.strictObject({
    id: requestId,
    type: z.literal("result.findMatch"),
    handle,
    from: z.strictObject({ row: index, column: index }).nullable(),
    backward: z.boolean(),
  }),
  z.strictObject({ id: requestId, type: z.literal("result.editable"), handle, current: namespacePath.optional() }),
  z.strictObject({
    id: requestId,
    type: z.literal("result.extract"),
    handle,
    extractor,
    rows: z.array(z.strictObject({ from: index, to: index })),
    columns,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("result.aggregate"),
    handle,
    rows: z.array(z.strictObject({ from: index, to: index })),
    columns,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("result.cellBytes"),
    handle,
    row: index,
    column: index,
    maxBytes: z.number().int().positive(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("result.saveBytes"),
    handle,
    row: index,
    column: index,
    path: file,
    maxBytes: z.number().int().positive(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("result.loadBytes"),
    handle,
    path: file,
    maxBytes: z.number().int().positive(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("export.start"),
    source: exportSource,
    format: z.enum(EXPORT_FORMATS),
    path: z.string().min(1),
    stallSeconds,
  }),
  z.strictObject({ id: requestId, type: z.literal("export.cancel"), taskId }),
  z.strictObject({ id: requestId, type: z.literal("export.retry"), taskId, stallSeconds }),
  z.strictObject({ id: requestId, type: z.literal("export.list") }),
  z.strictObject({ id: requestId, type: z.literal("import.preview"), file, format: importFormat }),
  z.strictObject({
    id: requestId,
    type: z.literal("import.ddl"),
    path: namespacePath,
    relation,
    columns: newImportColumns,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("import.start"),
    file,
    format: importFormat,
    target: importTarget,
    transaction: importTransaction,
    errors: importErrors,
    stallSeconds,
  }),
  z.strictObject({ id: requestId, type: z.literal("import.cancel"), taskId }),
  z.strictObject({ id: requestId, type: z.literal("import.resume"), taskId, stallSeconds }),
  z.strictObject({ id: requestId, type: z.literal("import.list") }),
  z.strictObject({
    id: requestId,
    type: z.literal("script.run"),
    files: z.array(file).min(1),
    namespace: namespacePath.nullable(),
    onError: z.enum(ON_ERROR_CHOICES),
  }),
  z.strictObject({ id: requestId, type: z.literal("script.answer"), taskId, answer: z.enum(ERROR_ANSWERS) }),
  z.strictObject({ id: requestId, type: z.literal("script.cancel"), taskId }),
  z.strictObject({ id: requestId, type: z.literal("script.list") }),
  z.strictObject({ id: requestId, type: z.literal("catalog.namespaces"), refresh: z.boolean().optional() }),
  z.strictObject({ id: requestId, type: z.literal("namespace.targets"), refresh: z.boolean().optional() }),
  z.strictObject({ id: requestId, type: z.literal("namespace.switchStatement"), path: namespacePath }),
  z.strictObject({ id: requestId, type: z.literal("server.nodes") }),
  z.strictObject({ id: requestId, type: z.literal("server.info"), node: z.string().min(1).nullable() }),
  z.strictObject({
    id: requestId,
    type: z.literal("server.slowLog"),
    node: z.string().min(1).nullable(),
    limit: z.number().int().positive().max(SLOW_LOG_MAX),
  }),
  z.strictObject({ id: requestId, type: z.literal("keyspace.databases") }),
  z.strictObject({
    id: requestId,
    type: z.literal("keyspace.scan"),
    database: index,
    cursor: z.string().nullable(),
    match: z.string().min(1),
    keyType: z.enum(KEY_TYPES).nullable(),
  }),
  z.strictObject({ id: requestId, type: z.literal("keyspace.describe"), database: index, keys: keyNames }),
  z.strictObject({
    id: requestId,
    type: z.literal("keyspace.open"),
    sessionId,
    database: index,
    key: keyName,
    range: z.strictObject({
      match: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    ...paging,
    timeoutSeconds,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("keyspace.preview"),
    key: keyName,
    changes: keyChanges,
    options: keyApplyOptions,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("keyspace.apply"),
    database: index,
    key: keyName,
    changes: keyChanges,
    options: keyApplyOptions,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("keyspace.rename"),
    database: index,
    key: keyName,
    to: keyName,
    overwrite: z.boolean(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("keyspace.expire"),
    database: index,
    key: keyName,
    expiry: z
      .union([
        z.strictObject({ inMs: z.number().int().positive() }),
        z.strictObject({ at: z.iso.datetime({ offset: true }) }),
      ])
      .nullable(),
  }),
  z.strictObject({ id: requestId, type: z.literal("keyspace.remove"), database: index, keys: keyNames }),
  z.strictObject({
    id: requestId,
    type: z.literal("catalog.describe"),
    path: namespacePath,
    refresh: z.boolean().optional(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("catalog.qualifiedName"),
    path: namespacePath,
    name: z.string().min(1),
  }),
  z.strictObject({ id: requestId, type: z.literal("catalog.definition"), path: namespacePath, name: relation }),
  z.strictObject({
    id: requestId,
    type: z.literal("sql.generate"),
    path: namespacePath,
    name: relation,
    statement: z.enum(GENERATOR_STATEMENTS),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("routine.call"),
    path: namespacePath,
    name: z.string().min(1),
    kind: z.enum(["function", "procedure"]),
    signature: z.string(),
    args: z.array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("value"), value: z.string().nullable() }),
        z.strictObject({ kind: z.literal("default") }),
      ]),
    ),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("table.query"),
    sessionId,
    path: namespacePath,
    relation,
    where: z.string(),
    orderBy: z.string(),
    ...paging,
    timeoutSeconds,
  }),
  z.strictObject({ id: requestId, type: z.literal("objects.features") }),
  z.strictObject({ id: requestId, type: z.literal("objects.design"), path: namespacePath, relation }),
  z.strictObject({ id: requestId, type: z.literal("objects.script"), change: objectChange }),
  z.strictObject({
    id: requestId,
    type: z.literal("objects.apply"),
    change: objectChange,
    statements: z.array(z.string()),
  }),
  z.strictObject({ id: requestId, type: z.literal("table.count"), path: namespacePath, relation, where: z.string() }),
  z.strictObject({
    id: requestId,
    type: z.literal("table.condition"),
    handle,
    rows: z.array(index).min(1),
    columns: z.array(z.strictObject({ column: index, name: z.string().min(1) })).min(1),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("completion.complete"),
    text: z.string(),
    offset: index,
    scope: z.strictObject({ path: namespacePath, relation }).optional(),
    current: namespacePath.optional(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("inspection.inspect"),
    text: z.string().max(MAX_INSPECTION_TEXT),
    current: namespacePath.optional(),
    disabled: z.array(z.string().min(1)).optional(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("completion.signature"),
    text: z.string(),
    offset: index,
    scope: z.strictObject({ path: namespacePath, relation }).optional(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("navigation.resolve"),
    text: z.string(),
    offset: index,
    current: namespacePath.optional(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("table.orderBy"),
    terms: z.array(z.strictObject({ name: z.string().min(1), direction: z.enum(["asc", "desc"]) })),
  }),
  z.strictObject({ id: requestId, type: z.literal("edits.preview"), handle, edits }),
  z.strictObject({ id: requestId, type: z.literal("edits.submit"), sessionId, handle, edits }),
  z.strictObject({ id: requestId, type: z.literal("sessions.list") }),
  z.strictObject({ id: requestId, type: z.literal("sessions.cancel"), target: sessionTarget }),
  z.strictObject({ id: requestId, type: z.literal("sessions.terminate"), target: sessionTarget }),
]) satisfies z.ZodType<EngineRequest>;

const idOnly = z.object({ id: requestId });

/** The id of a request that failed to parse, so its caller still hears back. */
export function readRequestId(message: unknown): number | null {
  const parsed = idOnly.safeParse(message);
  return parsed.success ? parsed.data.id : null;
}
