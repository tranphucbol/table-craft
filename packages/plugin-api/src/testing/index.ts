import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BYTES_PREVIEW_LENGTH,
  CAPABILITIES,
  FORMAT_STYLES,
  IMPORT_KINDS,
  DefinitionNotFoundError,
  errorPositionOf,
  isPluginError,
  offsetOfPosition,
  switchableTo,
  z,
  type BoundStatement,
  type ColumnDesign,
  type CompletionCatalog,
  type DdlScript,
  type ConnectionUrlPart,
  type ConnectOptions,
  type DatasourcePlugin,
  type DdlContext,
  type ExecuteOptions,
  type ExplainedPlan,
  type GeneratedStatement,
  type ImportKind,
  type InsertRow,
  type InsertTarget,
  type KeyApplied,
  type KeyChange,
  type KeyContents,
  type KeyName,
  type KeySource,
  type KeyType,
  type Keyspace,
  type PlanNode,
  type PluginErrorCode,
  type Problem,
  type PluginManifest,
  type Introspector,
  type NamespaceCatalog,
  type ObjectChange,
  type ObjectEditor,
  type Relation,
  type Routine,
  type RoutineArgument,
  type Row,
  type ServerMessage,
  type ServerSession,
  type Session,
  type SessionMonitor,
  type SqlLanguage,
  type TableDesign,
  type Transactions,
  type WireValue,
} from "@table-craft/plugin-api";

export interface ContractFixture {
  /** The plugin's parsed `table-craft-plugin.json`, whose connection form the suite checks. */
  readonly manifest: PluginManifest;
  /** Configuration that connects to a reachable, writable database seeded with `TYPE_PROBE_TABLE`. */
  readonly config: unknown;
  /** The same database with a wrong password; omitted by plugins that do not authenticate. */
  readonly wrongPasswordConfig?: unknown;
  readonly statements?: {
    /** A statement that runs for `seconds`; required when the plugin declares `cancel`. */
    readonly sleep?: (seconds: number) => string;
    /**
     * A write that succeeds on a writable session and leaves the fixture unchanged, such as an
     * update setting a column to itself; the read-only case is skipped without one.
     */
    readonly write?: string;
    /**
     * A statement the server answers with a warning or notice, and the level and code of the
     * first one; required when the plugin declares `serverMessages`.
     */
    readonly message?: {
      readonly sql: string;
      readonly level: ServerMessage["level"];
      readonly code: string | null;
    };
    /**
     * A statement with a syntax error and the 0-based offset the plugin's `PluginError.position`
     * must resolve to; leave it out for a database that cannot locate one.
     */
    readonly syntaxError?: { readonly sql: string; readonly offset: number };
  };
  /** Required when the plugin declares `sql`. */
  readonly typeProbe?: {
    /** The rows of `SELECT * FROM type_probe ORDER BY id`, as wire values. */
    readonly expected: readonly Row[];
    /**
     * Creates `TYPE_PROBE_COPY_TABLE` with `type_probe`'s columns and declared types; the literal
     * round trip creates and drops it. `CREATE TABLE … AS` will not do where it drops declared types.
     */
    readonly copyTable: string;
  };
  /** Scripts only this dialect splits, and the statements `language.split` must find in each. */
  readonly scripts?: readonly SplitCase[];
  /** Required when the plugin declares `schemaTree`. */
  readonly catalog?: {
    /** The namespace the fixture tables live in, which is also the connection's current one. */
    readonly path: readonly string[];
    /** An identifier that needs quoting, and what `qualifiedName(path, name)` must return for it. */
    readonly quoted: { readonly name: string; readonly qualified: string };
    /** `LINE_ITEMS_TABLE` as the dialect writes it in a statement, which completion must insert. */
    readonly lineItems: string;
    /** The name `orders`' check constraint carries, which its definition must show. */
    readonly ordersCheck: string;
    /** `customers`' table comment; null where the dialect has no comments. */
    readonly customersComment: string | null;
  };
  /** Required when the plugin declares `currentNamespace`, which also needs `catalog`. */
  readonly namespaceSwitch?: {
    /** A statement that makes another namespace current, such as `USE archive`. */
    readonly statement: string;
    /** The path `currentNamespace` reports after it. */
    readonly path: readonly string[];
    /** A switch to a namespace that does not exist, where the dialect rejects one. */
    readonly missing?: string;
  };
  /** Required when the plugin declares `commands` (decision 112). */
  readonly commands?: CommandsFixture;
  /** Required when the plugin declares `keyValue` (decision 113). */
  readonly keyspace?: KeyspaceFixture;
  /**
   * Required when the plugin declares `sessions`, which also needs `statements.sleep`, and
   * `statements.write` where it declares `transactions`.
   */
  readonly sessions?: {
    /** Connects as an account that sees every session and may stop any, such as a superuser. */
    readonly monitorConfig: unknown;
    /** What a listing shows as the sleeping statement's query; the statement itself by default. */
    readonly sleepQuery?: string;
    /** An account that sees only its own sessions, and what the listing's note must say about it. */
    readonly limited?: { readonly config: unknown; readonly note: RegExp };
    /**
     * False where the dialect cannot interrupt another session's statement and keep it connected,
     * as SQL Server's `KILL` cannot: every row's `cancel` is null and `cancelSession` rejects.
     */
    readonly cancels?: boolean;
    /**
     * A session id no session has, for servers that hand a closed session's id to the next login
     * (SQL Server): without it the test closes a session of its own and waits for its id to go.
     */
    readonly missingId?: string;
  };
  /** Required when the plugin declares `routineCall`, which also needs `catalog`. */
  readonly routines?: {
    /** Every routine the fixture seeds in `catalog.path`, as `describe` lists them. */
    readonly expected: readonly Routine[];
    /** A function given values, and the rows its call returns. */
    readonly function: RoutineCase;
    /** A call with one argument NULL, which must bind as SQL NULL. */
    readonly nullArgument: RoutineCase;
    /** A procedure whose OUT values come back as the last statement's rows. */
    readonly procedureOut: RoutineCase;
    /** A call that leaves a parameter to its default; omitted where the dialect has no defaults. */
    readonly defaulted?: RoutineCase;
  };
  /** The statements whose text differs by dialect; each defaults to the text PostgreSQL, MySQL and SQLite accept. */
  readonly sql?: ContractSql;
  /**
   * How the database stores an unquoted fixture name, such as Oracle's upper case; identity by
   * default. `LINE_ITEMS_TABLE` is quoted in every dialect and never folded.
   */
  readonly foldName?: (name: string) => string;
  /** The database stores an empty string as NULL, as Oracle does, so an empty text reads back null. */
  readonly emptyTextIsNull?: boolean;
}

/** Dialect-specific text the suite runs; every member is optional (decision 100). */
export interface ContractSql {
  /** A one-row query of `expressions`; Oracle adds `FROM DUAL`. */
  readonly select?: (expressions: string) => string;
  /** At least 100,000 rows; built from `select` by default. */
  readonly largeResult?: string;
  /** A join over `orders` and `customers` that plans with more than one step. */
  readonly explainJoin?: string;
  /** Replaces the scripts every other dialect splits the same way. */
  readonly sharedScripts?: readonly SplitCase[];
  /** Drops table `name` where it exists and does nothing where it does not. */
  readonly dropTableIfExists?: (name: string) => string;
  /** Creates a session-scoped table from `name`, and the name later statements reach it by. */
  readonly temporaryTable?: (name: string, columns: string) => { readonly create: string; readonly name: string };
  /** Opens a transaction explicitly in auto-commit mode. */
  readonly begin?: string;
  /** A name only quoting makes legal, which the dialect accepts; Oracle refuses a `"` inside one. */
  readonly awkwardIdentifier?: string;
  /** What `ExplainedPlan.statement` starts with; `EXPLAIN` by default, `SET SHOWPLAN_XML ON` on SQL Server. */
  readonly explainStatement?: RegExp;
}

/** A command and the result tab it opens: column names and rows as wire values. */
export interface CommandRows {
  readonly command: string;
  readonly columns: readonly string[];
  readonly rows: readonly Row[];
}

/** What a `commands` plugin's console runs against the fixture database (decision 112). */
export interface CommandsFixture {
  /** Scripts the language splits, and the commands it must find in each. */
  readonly scripts: readonly SplitCase[];
  /** A command answered with one scalar, and the text Output shows for the reply. */
  readonly scalar: { readonly command: string; readonly text: string };
  /** A command answered with an array. */
  readonly array: CommandRows;
  /** A command answered with a map. */
  readonly map: CommandRows;
  /** A command answering bytes that are not UTF-8, and those bytes in hex. */
  readonly binary: { readonly command: string; readonly hex: string };
  /** A write a read-only session refuses, and the command name the refusal carries. */
  readonly write: { readonly command: string; readonly name: string };
  /** A command classified costly, and the text of the first quick fix its problem offers. */
  readonly costly: { readonly command: string; readonly fixed: string };
  /** A command classified destructive and confirmed by the datasource's name. */
  readonly confirmByName: string;
}

/** The keys a `keyValue` plugin's fixture database carries (decision 113). */
export interface KeyspaceFixture {
  /** The database the fixture keys live in. */
  readonly database: number;
  /** A glob, and how many keys it matches: enough for many scan batches. */
  readonly scan: { readonly match: string; readonly count: number; readonly batch: number };
  /** A glob and a type, and the names of the keys of that type it matches. */
  readonly typed: { readonly match: string; readonly type: KeyType; readonly keys: readonly string[] };
  /** A key with an expiry. */
  readonly expiring: string;
  /** A key whose name is not valid UTF-8, as lower-case hex, a glob that finds it, and its value. */
  readonly binary: { readonly hex: string; readonly match: string; readonly type: KeyType; readonly value: string };
  /** A hash key and its first two columns' rows, in any order. */
  readonly hash: KeyRowsFixture;
  /** A sorted-set key and its member and score cells, in rank order. */
  readonly zset: KeyRowsFixture;
  /** A stream key, its columns and its rows, in id order. */
  readonly stream: KeyRowsFixture & { readonly columns: readonly string[] };
  /** A scratch key the suite creates, changes and removes. */
  readonly edit: KeyEditFixture;
  /**
   * Commands run in a console and the key each reply names as its source, null for none
   * (decision 119): one that reads a whole key, one that reads part of one, and one that reads
   * several. Without it the reply-source tests are skipped.
   */
  readonly sources?: readonly KeySourceFixture[];
}

/** A command and the source its reply names (decision 119). */
export interface KeySourceFixture {
  readonly command: string;
  readonly source: KeySource | null;
  /** The reply is a value read, which the console opens as a one-row result. */
  readonly read?: boolean;
}

/** How the suite changes one element of a scratch key and reads it back (decision 115). */
export interface KeyEditFixture {
  readonly key: string;
  readonly type: KeyType;
  /** A change setting the element to `value`, read as `original` (null: it did not exist). */
  readonly change: (value: string, original: string | null) => KeyChange;
  /** The element's value in what `read` returned; null when it is missing. */
  readonly valueOf: (contents: KeyContents) => Promise<string | null>;
}

/** The scratch key's element, written and read back through the keyspace. */
interface ApplyTo {
  set(value: string, original: string | null, guard: boolean): Promise<KeyApplied>;
  value(): Promise<string | null>;
}

/** A key and the rows reading it gives. */
export interface KeyRowsFixture {
  readonly key: string;
  readonly rows: readonly Row[];
}

/** One routine call: which routine (from `routines.expected`), its arguments, and the rows it returns. */
export interface RoutineCase {
  readonly name: string;
  readonly kind: Routine["kind"];
  readonly signature: string;
  readonly args: readonly RoutineArgument[];
  readonly rows: readonly Row[];
}

export interface SplitCase {
  readonly text: string;
  readonly statements: readonly string[];
}

/** What every SQL dialect splits the same way (decision 023). */
const SHARED_SCRIPTS: readonly SplitCase[] = [
  { text: "SELECT 'a;b' AS s; SELECT 2 AS n", statements: ["SELECT 'a;b' AS s", "SELECT 2 AS n"] },
  { text: "SELECT 'it''s; here' AS s;\nSELECT 2 AS n;", statements: ["SELECT 'it''s; here' AS s", "SELECT 2 AS n"] },
  { text: 'SELECT 1 AS "a;b"; SELECT 2 AS n', statements: ['SELECT 1 AS "a;b"', "SELECT 2 AS n"] },
  {
    text: "SELECT 1 AS n -- not; here\n;\n/* nor; here */ SELECT 2 AS n /* inside; */ ;",
    statements: ["SELECT 1 AS n", "SELECT 2 AS n"],
  },
  { text: ";; ; -- only comments;\n/* ; */ ;", statements: [] },
];

/** Every SQL dialect calls these destructive, or not (decision 011). */
const DESTRUCTIVE_CASES: readonly (readonly [string, boolean])[] = [
  ["DELETE FROM orders", true],
  ["DELETE FROM orders WHERE id = 1", false],
  ["UPDATE orders SET total = 0", true],
  ["UPDATE orders SET total = (SELECT max(total) FROM orders o WHERE o.id = 1)", true],
  ["UPDATE orders SET total = total WHERE id = 1", false],
  ["DROP TABLE orders", true],
  ["TRUNCATE TABLE orders", true],
  ["SELECT * FROM orders", false],
  // Plain EXPLAIN only plans; ANALYZE runs the statement, so it is as destructive as it (decision 031).
  ["EXPLAIN DELETE FROM orders", false],
  ["EXPLAIN ANALYZE DELETE FROM orders", true],
  ["EXPLAIN ANALYZE DELETE FROM orders WHERE id = 1", false],
];

/** A row the transaction cases add to `orders` and always remove, so the fixture's counts hold. */
const TRANSACTION_ROW_ID = 9001;
const INSERT_TRANSACTION_ROW = `INSERT INTO orders (id, customer_id, total, placed_at) VALUES (${TRANSACTION_ROW_ID}, 1, 1.00, '2024-01-01 00:00:00')`;
const SELECT_TRANSACTION_ROW = `SELECT id FROM orders WHERE id = ${TRANSACTION_ROW_ID}`;
const DELETE_TRANSACTION_ROW = `DELETE FROM orders WHERE id = ${TRANSACTION_ROW_ID}`;

/** The table every fixture database carries, one column per value rule the contract pins. */
export const TYPE_PROBE_TABLE = "type_probe";
/** Where the literal round trip inserts `type_probe`'s rows; created and dropped by the suite. */
export const TYPE_PROBE_COPY_TABLE = "type_probe_copy";
const AWKWARD_IDENTIFIER = 'we"ird`name';

export const TYPE_PROBE_COLUMNS = [
  "id",
  "small_int",
  "big_int",
  "exact_decimal",
  "unicode_text",
  "flag",
  "doc",
  "payload",
  "day",
  "moment",
] as const;

/** A fixture table whose name needs quoting in every dialect, for completion's quoting. */
export const LINE_ITEMS_TABLE = "Line Items";
/** SQL no inspector can read, which must still resolve with fixes whose edits stay inside the text. */
const INSPECTION_GARBAGE = [
  ")))(((",
  "SELECT FROM WHERE ((( ' \" /* ",
  "WITH WITH AS AS ( SELECT",
  "UPDATE SET WHERE",
  ". , ;",
];

/** The relations every fixture database carries, sorted by name as `describe` returns them. */
export const FIXTURE_RELATIONS = [
  { name: "customer_totals", kind: "view" },
  { name: "customers", kind: "table" },
  { name: "orders", kind: "table" },
  { name: "edit_probe", kind: "table" },
  { name: "no_key_probe", kind: "table" },
  { name: TYPE_PROBE_TABLE, kind: "table" },
  { name: LINE_ITEMS_TABLE, kind: "table" },
] as const;

/** The data editor's table (decision 026): a serial key and a default for every other column. */
export const EDIT_PROBE_TABLE = "edit_probe";
const EDIT_PROBE_SELECT = `SELECT id, label, qty, note FROM ${EDIT_PROBE_TABLE} ORDER BY id`;
const EDIT_PROBE_KEY_TYPE = "integer";
const EDIT_PROBE_TEXT_TYPE = "text";
const EDIT_PROBE_DEFAULT_QTY = 1;
const EDIT_PROBE_DEFAULT_LABEL = "new";
const MISSING_ROW_ID = -1;

const MISSING_NAMESPACE = "table_craft_no_such_namespace";
const MISSING_RELATION = "table_craft_no_such_relation";
const ORDERS_INDEX = "orders_placed_at_idx";
/** Created and dropped by the generated-DROP case. */
const DROP_PROBE_TABLE = "table_craft_drop_probe";

/** A join every fixture database plans with more than one step. */
const EXPLAIN_JOIN = "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 10";
const EXPLAIN_DELETE_ALL = "DELETE FROM orders";
const EXPLAIN_UPDATE = "UPDATE orders SET total = total WHERE id = 1";
/** The `orders` rows every fixture database is seeded with. */
const ORDERS_ROWS = 3;
const ANALYSED_ORDER_ID = 1;
const ANALYSED_UPDATE = `UPDATE orders SET total = 0 WHERE id = ${ANALYSED_ORDER_ID}`;
const ANALYSED_TOTAL = `SELECT total FROM orders WHERE id = ${ANALYSED_ORDER_ID}`;

function planNodes(roots: readonly PlanNode[]): PlanNode[] {
  return roots.flatMap((node) => [node, ...planNodes(node.children)]);
}

const PROBE_TABLE = "table_craft_contract_probe";
const PROBE_ROWS = 2;
const PROBE_ROW_ID = 1;

/** Far from UTC either way, so a driver that parses timestamps as local time shifts them visibly. */
const DISTANT_TIME_ZONE = "Pacific/Kiritimati";

const DIGIT_COUNT = 10;
/** 100,000 rows, more than any driver buffers in one fetch. */
function largeResultSql(select: (expressions: string) => string): string {
  const digits = Array.from({ length: DIGIT_COUNT }, (_, digit) => select(`${digit} AS n`)).join(" UNION ALL ");
  return (
    `SELECT a.n + 10 * b.n + 100 * c.n + 1000 * d.n + 10000 * e.n AS n FROM ` +
    ["a", "b", "c", "d", "e"].map((alias) => `(${digits}) ${alias}`).join(" CROSS JOIN ")
  );
}

/** The statements the suite runs for `fixture`, each default filled in. */
export function contractSql(fixture: Pick<ContractFixture, "sql">): Required<ContractSql> {
  const select = fixture.sql?.select ?? ((expressions: string) => `SELECT ${expressions}`);
  return {
    select,
    largeResult: fixture.sql?.largeResult ?? largeResultSql(select),
    explainJoin: fixture.sql?.explainJoin ?? EXPLAIN_JOIN,
    sharedScripts: fixture.sql?.sharedScripts ?? SHARED_SCRIPTS,
    dropTableIfExists: fixture.sql?.dropTableIfExists ?? ((name: string) => `DROP TABLE IF EXISTS ${name}`),
    temporaryTable:
      fixture.sql?.temporaryTable ??
      ((name: string, columns: string) => ({ create: `CREATE TEMPORARY TABLE ${name} (${columns})`, name })),
    begin: fixture.sql?.begin ?? "BEGIN",
    awkwardIdentifier: fixture.sql?.awkwardIdentifier ?? AWKWARD_IDENTIFIER,
    explainStatement: fixture.sql?.explainStatement ?? DEFAULT_EXPLAIN_STATEMENT,
  };
}
const DEFAULT_EXPLAIN_STATEMENT = /^EXPLAIN\b/i;
const ROWS_READ_BEFORE_RETURN = 3;
/** Longer than `BYTES_PREVIEW_LENGTH` and within every fixture's `payload` column (MySQL's is `VARBINARY(64)`). */
const LONG_BYTES_LENGTH = 48;
/** Stops a scan pass that never ends, so a broken cursor fails rather than hangs. */
const MAX_SCAN_BATCHES = 10_000;
const READ_WINDOW = 100;
const SLOW_LOG_LIMIT = 5;
const LONG_BYTES_HEX = "c3";
const HEX_DIGITS_PER_BYTE = 2;

/** Created and dropped by the import-type case. */
const IMPORT_PROBE_TABLE = "table_craft_import_probe";

/** The tables the objects block creates, alters, renames and drops (decision 052). */
const OBJECT_PARENT_TABLE = "table_craft_object_parent";
const OBJECT_CHILD_TABLE = "table_craft_object_child";
const OBJECT_RENAMED_TABLE = "table_craft_object_renamed";
const OBJECT_INDEX = "table_craft_object_label_idx";
const OBJECT_FOREIGN_KEY = "table_craft_object_parent_fk";
const OBJECT_KEY_TYPE = "integer";
const OBJECT_NARROW_TYPE = "varchar(40)";
const OBJECT_WIDE_TYPE = "varchar(80)";
const OBJECT_WIDE_LENGTH = /80/;
const OBJECT_ROW =
  "INSERT INTO table_craft_object_child (id, parent_id, label, obsolete) VALUES (1, 1, 'kept', 'gone')";
/** Text a file holds for each inferred kind; every proposed type must take it. */
const IMPORT_SAMPLES: Readonly<Record<ImportKind, string>> = {
  boolean: "true",
  integer: "-42",
  bigint: "9007199254740993",
  decimal: "1234567.891",
  double: "1.5e3",
  date: "2024-02-29",
  timestamp: "2024-02-29 13:45:30",
  text: "plain",
};
/** Characters a bulk path must carry through its own framing: COPY's tab, newline and backslash among them. */
const AWKWARD_TEXTS = ["tab\there", "line\nbreak\r\nand", "back\\slash \\N", "\\N", "quote \" ' ,", ""];

/** A cell as TableCraft's CSV export writes it (`cellText` in core), the text an import reads back. */
function exportedText(value: WireValue): string | null {
  if (value === null) return null;
  if (typeof value !== "object") return String(value);
  switch (value.kind) {
    case "bigint":
      return value.value;
    case "json":
      return value.text;
    case "date":
      return value.iso;
    case "bytes":
      return `0x${value.preview}`;
  }
}

const SLEEP_SECONDS = 30;
/** Long enough for the statement to reach the database before it is cancelled. */
const CANCEL_DELAY_MS = 500;
/** Well under `SLEEP_SECONDS`, so a cancel that did nothing fails the test instead of passing late. */
const CANCEL_DEADLINE_MS = 10_000;
const KEEPALIVE_DELAY_MS = 1000;
/** How long a listing may take to show what another connection just did. */
const LISTING_DEADLINE_MS = 10_000;
const LISTING_POLL_MS = 200;

async function collect(rows: AsyncIterable<Row>): Promise<Row[]> {
  const collected: Row[] = [];
  for await (const row of rows) collected.push(row);
  return collected;
}

function typeProbeOf(fixture: ContractFixture): NonNullable<ContractFixture["typeProbe"]> {
  if (fixture.typeProbe === undefined) throw new Error("A plugin that declares sql needs fixture.typeProbe.");
  return fixture.typeProbe;
}

function commandsOf(fixture: ContractFixture): CommandsFixture {
  if (fixture.commands === undefined) throw new Error("A plugin that declares commands needs fixture.commands.");
  return fixture.commands;
}

function catalogPathOf(fixture: ContractFixture): readonly string[] {
  if (fixture.catalog === undefined) throw new Error("A plugin that declares schemaTree needs fixture.catalog.");
  return fixture.catalog.path;
}

const WRITABLE: ConnectOptions = { readOnly: false };
const READ_ONLY: ConnectOptions = { readOnly: true };

async function connect(plugin: DatasourcePlugin, config: unknown, options = WRITABLE): Promise<Session> {
  return plugin.connect(plugin.connectionSchema.parse(config), options);
}

/** A completion catalog straight over `introspector`, describing each namespace once. */
async function liveCompletionCatalog(
  introspector: Introspector,
  serverVersion: string | null = null,
): Promise<CompletionCatalog> {
  const namespaces = await introspector.namespaces();
  const described = new Map<string, Promise<NamespaceCatalog>>();
  const describe = (path: readonly string[]): Promise<NamespaceCatalog> => {
    const key = JSON.stringify(path);
    const known = described.get(key) ?? introspector.describe(path);
    described.set(key, known);
    return known;
  };
  return {
    current: namespaces.find((namespace) => namespace.current)?.path ?? null,
    server: { version: serverVersion },
    namespaces: () => Promise.resolve(namespaces),
    relations: async (path) => (await describe(path)).relations,
    referencing: async (path, relation) => {
      const catalogs = await Promise.all([...described.values()]);
      return catalogs.flatMap((catalog) =>
        catalog.relations.flatMap((source) =>
          source.foreignKeys
            .filter(
              (key) => key.target.relation === relation && JSON.stringify(key.target.path) === JSON.stringify(path),
            )
            .map((foreignKey) => ({ path: catalog.path, relation: source.name, foreignKey })),
        ),
      );
    },
  };
}

async function withSession(
  plugin: DatasourcePlugin,
  fixture: ContractFixture,
  use: (session: Session) => Promise<void>,
  options = WRITABLE,
): Promise<void> {
  const session = await connect(plugin, fixture.config, options);
  try {
    await use(session);
  } finally {
    await session.close();
  }
}

async function rejectionCode(pending: Promise<unknown>): Promise<PluginErrorCode | "notAPluginError" | "resolved"> {
  try {
    await pending;
    return "resolved";
  } catch (error) {
    return isPluginError(error) ? error.code : "notAPluginError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ObjectJsonSchema {
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
}

/**
 * Where a manifest's connection form and the plugin's `connectionSchema` disagree (decision 019),
 * one sentence per problem; empty when they agree.
 */
export function connectionFormProblems(manifest: PluginManifest, connectionSchema: z.ZodType): string[] {
  const json = z.toJSONSchema(connectionSchema, { io: "input", unrepresentable: "any" }) as ObjectJsonSchema;
  const accepted = new Set(Object.keys(json.properties ?? {}));
  const fields = manifest.connection.fields;
  const keys = new Set(fields.map((field) => field.key));
  const problems: string[] = [];
  if (keys.size !== fields.length) problems.push("Two connection fields share a key.");
  for (const field of fields) {
    if (!accepted.has(field.key)) problems.push(`Field "${field.key}" is not accepted by connectionSchema.`);
    if (field.kind === "password" && field.secret !== true) {
      problems.push(`Password field "${field.key}" must be marked secret.`);
    }
    if (field.kind === "select" && field.options === undefined) {
      problems.push(`Select field "${field.key}" needs options.`);
    }
  }
  for (const key of json.required ?? []) {
    if (!keys.has(key)) problems.push(`connectionSchema requires "${key}", but no connection field fills it.`);
  }
  return [...problems, ...connectionUrlProblems(manifest)];
}

const SERVER_URL_PARTS: readonly ConnectionUrlPart[] = ["host", "port", "database", "user", "password"];

/** Where `connection.url` names fields the form lacks, or maps them inconsistently (decision 055). */
function connectionUrlProblems(manifest: PluginManifest): string[] {
  const url = manifest.connection.url;
  if (url === undefined) return [];
  const fields = new Map(manifest.connection.fields.map((field) => [field.key, field]));
  const problems: string[] = [];
  const allowed = url.form === "server" ? SERVER_URL_PARTS : ["path"];
  for (const [part, key] of Object.entries(url.parts)) {
    if (!allowed.includes(part as ConnectionUrlPart)) problems.push(`A ${url.form} URL has no "${part}" part.`);
    const field = fields.get(key);
    if (field === undefined) {
      problems.push(`URL part "${part}" fills "${key}", which no connection field declares.`);
      continue;
    }
    if ((part === "password") !== (field.secret === true)) {
      problems.push(`URL part "${part}" fills "${key}", but only the password part fills a secret field.`);
    }
    if (part === "port" && field.kind !== "number") problems.push(`URL part "port" must fill a number field.`);
  }
  const required = url.form === "server" ? "host" : "path";
  if (url.parts[required] === undefined) problems.push(`A ${url.form} URL needs a "${required}" part.`);
  for (const param of url.params ?? []) {
    const field = fields.get(param.key);
    if (field === undefined) {
      problems.push(`URL parameter "${param.name}" fills "${param.key}", which no connection field declares.`);
      continue;
    }
    if (field.secret === true) problems.push(`URL parameter "${param.name}" must not fill a secret field.`);
    const options = new Set(field.options?.map((option) => option.value));
    for (const value of Object.values(param.values ?? {})) {
      if (field.kind === "select" && !options.has(value)) {
        problems.push(`URL parameter "${param.name}" maps to "${value}", which "${param.key}" does not offer.`);
      }
    }
  }
  return problems;
}

/**
 * The behaviour every plugin owes the host, gated on the capabilities it declares (decision 013).
 * Call it from a Vitest file; it registers one `describe` block.
 */
export function runPluginContract(plugin: DatasourcePlugin, fixture: ContractFixture): void {
  const dialectSql = contractSql(fixture);
  const fold = (name: string): string => (name === LINE_ITEMS_TABLE ? name : (fixture.foldName?.(name) ?? name));
  const selectOne = dialectSql.select("1 AS one");
  const dropIfExists = dialectSql.dropTableIfExists;

  /** Shows `session` still answers: a one-row SELECT, or the fixture's scalar command. */
  async function expectAlive(session: Session): Promise<void> {
    if (plugin.capabilities.includes("commands")) {
      const { command, text } = commandsOf(fixture).scalar;
      expect((await session.execute(command)).reply?.text).toBe(text);
      return;
    }
    expect(await collect((await session.execute(selectOne)).rows)).toEqual([[1]]);
  }

  describe(`plugin contract: ${plugin.id}`, () => {
    it("givenPlugin_whenInspected_thenDeclaresOnlyKnownCapabilities", () => {
      for (const capability of plugin.capabilities) expect(CAPABILITIES).toContain(capability);
    });

    it("givenFixtureConfig_whenParsedByConnectionSchema_thenSucceeds", () => {
      expect(plugin.connectionSchema.safeParse(fixture.config).success).toBe(true);
    });

    it("givenManifestFields_whenComparedWithConnectionSchema_thenAgree", () => {
      expect(fixture.manifest.id).toBe(plugin.id);
      expect(connectionFormProblems(fixture.manifest, plugin.connectionSchema)).toEqual([]);
    });

    it("givenSession_whenConnected_thenServerVersionNonEmpty", async () => {
      await withSession(plugin, fixture, (session) => {
        expect(session.serverVersion).toMatch(/\S/);
        return Promise.resolve();
      });
    });

    it("givenSession_whenConnected_thenTlsIsNullOrDescribed", async () => {
      await withSession(plugin, fixture, (session) => {
        if (session.tls !== undefined && session.tls !== null) {
          expect(session.tls.protocol).toMatch(/\S/);
          expect(session.tls.cipher).toMatch(/\S/);
        }
        return Promise.resolve();
      });
    });

    it("givenPlugin_whenInspected_thenHasLanguageExactlyWhenSqlDeclared", () => {
      expect(plugin.language !== undefined).toBe(plugin.capabilities.includes("sql"));
    });

    it("givenPlugin_whenInspected_thenHasCommandLanguageExactlyWhenCommandsDeclared", () => {
      const commands = plugin.capabilities.includes("commands");
      if (commands) expect(plugin.capabilities).not.toContain("sql");
      expect(plugin.commandLanguage !== undefined).toBe(commands);
    });

    it("givenSession_whenInspected_thenHasKeyspaceExactlyWhenKeyValueDeclared", async () => {
      const keyValue = plugin.capabilities.includes("keyValue");
      if (keyValue) expect(plugin.capabilities).toContain("commands");
      await withSession(plugin, fixture, (session) => {
        expect(session.keyspace !== undefined).toBe(keyValue);
        return Promise.resolve();
      });
    });

    it("givenSession_whenInspected_thenHasNodesAndServerInfoExactlyWhenDeclared", async () => {
      await withSession(plugin, fixture, (session) => {
        expect(session.nodes !== undefined).toBe(plugin.capabilities.includes("nodes"));
        expect(session.serverInfo !== undefined).toBe(plugin.capabilities.includes("serverInfo"));
        return Promise.resolve();
      });
    });

    it("givenSession_whenInspected_thenHasTransactionsExactlyWhenDeclared", async () => {
      await withSession(plugin, fixture, (session) => {
        expect(session.transactions !== undefined).toBe(plugin.capabilities.includes("transactions"));
        expect(session.transactions?.mode ?? "auto").toBe("auto");
        expect(session.transactions?.open ?? false).toBe(false);
        return Promise.resolve();
      });
    });

    it("givenSession_whenInspected_thenHasIntrospectorExactlyWhenSchemaTreeDeclared", async () => {
      await withSession(plugin, fixture, (session) => {
        expect(session.introspector !== undefined).toBe(plugin.capabilities.includes("schemaTree"));
        return Promise.resolve();
      });
    });

    it("givenSession_whenInspected_thenHasDefinitionExactlyWhenDdlDeclared", async () => {
      const ddl = plugin.capabilities.includes("ddl");
      if (ddl) expect(plugin.capabilities).toContain("schemaTree");
      await withSession(plugin, fixture, (session) => {
        expect(session.introspector?.definition !== undefined).toBe(ddl);
        return Promise.resolve();
      });
    });

    it("givenPlugin_whenInspected_thenHasExplainableAndExplainExactlyWhenExplainDeclared", async () => {
      const explain = plugin.capabilities.includes("explain");
      if (explain) expect(plugin.capabilities).toContain("sql");
      if (plugin.capabilities.includes("explainAnalyze")) expect(plugin.capabilities).toContain("explain");
      expect(plugin.language?.explainable !== undefined).toBe(explain);
      await withSession(plugin, fixture, (session) => {
        expect(session.explain !== undefined).toBe(explain);
        return Promise.resolve();
      });
    });

    it("givenSession_whenInspected_thenHasPingExactlyWhenKeepAliveDeclared", async () => {
      await withSession(plugin, fixture, (session) => {
        expect(session.ping !== undefined).toBe(plugin.capabilities.includes("keepAlive"));
        return Promise.resolve();
      });
    });

    it("givenSession_whenInspected_thenHasCurrentNamespaceExactlyWhenDeclared", async () => {
      const declared = plugin.capabilities.includes("currentNamespace");
      if (declared) expect(plugin.capabilities).toContain("sql");
      await withSession(plugin, fixture, (session) => {
        expect(session.currentNamespace !== undefined).toBe(declared);
        return Promise.resolve();
      });
    });

    it("givenPlugin_whenInspected_thenHasNamespaceSwitchExactlyWhenCurrentNamespaceDeclared", () => {
      expect(plugin.language?.namespaceSwitch !== undefined).toBe(plugin.capabilities.includes("currentNamespace"));
    });

    it("givenPlugin_whenInspected_thenHasInsertRowsAndImportLanguageExactlyWhenBulkInsertDeclared", async () => {
      const bulk = plugin.capabilities.includes("bulkInsert");
      if (bulk) expect(plugin.capabilities).toContain("transactions");
      expect(plugin.language?.importType !== undefined).toBe(bulk);
      expect(plugin.language?.createTable !== undefined).toBe(bulk);
      await withSession(plugin, fixture, (session) => {
        expect(session.insertRows !== undefined).toBe(bulk);
        return Promise.resolve();
      });
    });

    it("givenSession_whenInspected_thenHasSessionMonitorExactlyWhenSessionsDeclared", async () => {
      const declared = plugin.capabilities.includes("sessions");
      if (declared) {
        expect(plugin.capabilities.includes("sql") || plugin.capabilities.includes("commands")).toBe(true);
        expect(plugin.capabilities.includes("schemaTree") || plugin.capabilities.includes("keyValue")).toBe(true);
      }
      await withSession(plugin, fixture, (session) => {
        expect(session.sessions !== undefined).toBe(declared);
        expect(typeof session.serverSessionId === "string").toBe(declared);
        return Promise.resolve();
      });
    });

    it("givenPlugin_whenInspected_thenHasObjectEditorExactlyWhenObjectsDeclared", () => {
      const objects = plugin.capabilities.includes("objects");
      if (objects) expect(plugin.capabilities).toEqual(expect.arrayContaining(["sql", "schemaTree"]));
      expect(plugin.language?.objects !== undefined).toBe(objects);
    });

    it("givenPlugin_whenInspected_thenHasRoutineCallExactlyWhenDeclared", () => {
      const routineCall = plugin.capabilities.includes("routineCall");
      if (routineCall) expect(plugin.capabilities).toEqual(expect.arrayContaining(["sql", "schemaTree"]));
      expect(plugin.language?.routineCall !== undefined).toBe(routineCall);
    });

    it.runIf(fixture.wrongPasswordConfig !== undefined)(
      "givenWrongPassword_whenConnecting_thenRejectsWithConnectionFailed",
      async () => {
        expect(await rejectionCode(connect(plugin, fixture.wrongPasswordConfig))).toBe("connectionFailed");
      },
    );

    describe.runIf(plugin.capabilities.includes("sql"))("sql", () => {
      it("givenSession_whenSelectLiterals_thenReturnsColumnsAndOneRow", async () => {
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(dialectSql.select("1 AS one, 'two' AS two"));
          expect(result.columns.map((column) => column.name)).toEqual(["one", "two"].map(fold));
          expect(await collect(result.rows)).toEqual([[1, "two"]]);
        });
      });

      it("givenStatementWithoutRows_whenExecuted_thenReturnsNoColumns", async () => {
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(dialectSql.temporaryTable(PROBE_TABLE, "n INTEGER").create);
          expect(result.columns).toEqual([]);
          expect(await collect(result.rows)).toEqual([]);
        });
      });

      it("givenInsert_whenExecuted_thenReportsRowsAffected", async () => {
        await withSession(plugin, fixture, async (session) => {
          const probe = dialectSql.temporaryTable(PROBE_TABLE, "n INTEGER");
          await session.execute(probe.create);
          const result = await session.execute(`INSERT INTO ${probe.name} (n) VALUES (1), (2)`);
          expect(result.rowsAffected).toBe(PROBE_ROWS);
        });
      });

      it("givenInvalidSql_whenExecuted_thenRejectsWithStatementFailed", async () => {
        await withSession(plugin, fixture, async (session) => {
          expect(await rejectionCode(session.execute("SELEC 1"))).toBe("statementFailed");
        });
      });

      it.runIf(fixture.statements?.syntaxError !== undefined)(
        "givenSyntaxError_whenExecuted_thenPositionPointsAtToken",
        async () => {
          const { sql, offset } = fixture.statements?.syntaxError ?? { sql: "", offset: 0 };
          await withSession(plugin, fixture, async (session) => {
            const failure = await session.execute(sql).then(
              () => undefined,
              (error: unknown) => error,
            );
            const position = errorPositionOf(failure);
            expect(position).toBeDefined();
            expect(position === undefined ? null : offsetOfPosition(sql, position)).toBe(offset);
          });
        },
      );

      it.runIf(fixture.statements?.write !== undefined)(
        "givenReadOnlySession_whenInsert_thenStatementFailed",
        async () => {
          const write = fixture.statements?.write ?? "";
          await withSession(plugin, fixture, async (session) => {
            await session.execute(write);
          });
          await withSession(
            plugin,
            fixture,
            async (session) => {
              expect(await rejectionCode(session.execute(write))).toBe("statementFailed");
              expect(await collect((await session.execute(selectOne)).rows)).toEqual([[1]]);
            },
            READ_ONLY,
          );
        },
      );

      it("givenFailedStatement_whenNextStatementRun_thenSessionStillWorks", async () => {
        await withSession(plugin, fixture, async (session) => {
          await rejectionCode(session.execute("SELEC 1"));
          expect(await collect((await session.execute(selectOne)).rows)).toEqual([[1]]);
        });
      });

      it("givenTypeProbe_whenSelected_thenCellsMatchExpectedWireValues", async () => {
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(`SELECT * FROM ${TYPE_PROBE_TABLE} ORDER BY id`);
          expect(result.columns.map((column) => column.name)).toEqual(TYPE_PROBE_COLUMNS.map(fold));
          expect(await collect(result.rows)).toEqual(typeProbeOf(fixture).expected);
        });
      });

      describe("bound parameters", () => {
        function bound(sql: string, values: Readonly<Record<string, string | null>>): BoundStatement {
          if (plugin.language === undefined) throw new Error("A plugin that declares sql needs language.");
          return plugin.language.bind(sql, values);
        }

        it("givenParams_whenExecute_thenBoundAsValues", async () => {
          const statement = bound("SELECT name FROM customers WHERE id = :id AND name <> ':id'", { ":id": "2" });
          await withSession(plugin, fixture, async (session) => {
            expect(await collect((await session.execute(statement.sql, statement.params)).rows)).toEqual([
              ["Grace Hopper"],
            ]);
          });
        });

        it("givenNullParam_whenExecute_thenBindsNull", async () => {
          const statement = bound("SELECT name FROM customers WHERE id = :id OR :id IS NULL ORDER BY id", {
            ":id": null,
          });
          await withSession(plugin, fixture, async (session) => {
            expect(await collect((await session.execute(statement.sql, statement.params)).rows)).toEqual([
              ["Ada Lovelace"],
              ["Grace Hopper"],
            ]);
          });
        });

        it("givenQuoteInParam_whenExecute_thenLandsAsData", async () => {
          const value = "'; DROP TABLE customers; --";
          const statement = bound("SELECT name FROM customers WHERE name = :name OR id = :id", {
            ":name": value,
            ":id": "1",
          });
          await withSession(plugin, fixture, async (session) => {
            expect(await collect((await session.execute(statement.sql, statement.params)).rows)).toEqual([
              ["Ada Lovelace"],
            ]);
            const remaining = await session.execute("SELECT id FROM customers ORDER BY id");
            expect(await collect(remaining.rows)).toEqual([[1], [2]]);
          });
        });

        it("givenParamsThenPlainStatement_whenExecuted_thenBothRun", async () => {
          const statement = bound("SELECT name FROM customers WHERE id = :id", { ":id": "1" });
          await withSession(plugin, fixture, async (session) => {
            for (let run = 0; run < 2; run += 1) {
              expect(await collect((await session.execute(statement.sql, statement.params)).rows)).toEqual([
                ["Ada Lovelace"],
              ]);
            }
            expect(await collect((await session.execute(selectOne)).rows)).toEqual([[1]]);
          });
        });

        it.each(FORMAT_STYLES)("givenLanguage_whenFormatAndBind_thenRoundTripsThroughExecute (%s)", async (style) => {
          const language = plugin.language;
          if (language === undefined) throw new Error("A plugin that declares sql needs language.");
          const formatted = language.format(
            "select c.name as who, c.id from customers c where c.id = :id and (c.id > 0 or c.id < 0) -- the second",
            { style, keywordCase: "upper", indentWidth: 2, linesBetweenStatements: 1, alignAliases: true },
          );
          expect(formatted).toContain("-- the second");
          expect(language.parameters(formatted).map((parameter) => parameter.name)).toEqual([":id"]);
          const statement = language.bind(formatted, { ":id": "2" });
          await withSession(plugin, fixture, async (session) => {
            expect(await collect((await session.execute(statement.sql, statement.params)).rows)).toEqual([
              ["Grace Hopper", 2],
            ]);
          });
        });
      });

      describe("in a distant time zone", () => {
        let original: string | undefined;
        beforeEach(() => {
          original = process.env.TZ;
          process.env.TZ = DISTANT_TIME_ZONE;
        });
        afterEach(() => {
          if (original === undefined) delete process.env.TZ;
          else process.env.TZ = original;
        });

        it("givenTimestamp_whenSelected_thenTextIsUnshiftedByClientTimeZone", async () => {
          const momentColumn = TYPE_PROBE_COLUMNS.indexOf("moment");
          const dayColumn = TYPE_PROBE_COLUMNS.indexOf("day");
          const expected = typeProbeOf(fixture).expected.find((row) => row[0] === PROBE_ROW_ID);
          await withSession(plugin, fixture, async (session) => {
            const result = await session.execute(
              `SELECT day, moment FROM ${TYPE_PROBE_TABLE} WHERE id = ${PROBE_ROW_ID}`,
            );
            expect(await collect(result.rows)).toEqual([[expected?.[dayColumn], expected?.[momentColumn]]]);
          });
        });
      });

      it("givenLargeResult_whenIteratorReturnedEarly_thenCursorClosedAndSessionUsable", async () => {
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(dialectSql.largeResult);
          const iterator = result.rows[Symbol.asyncIterator]();
          for (let read = 0; read < ROWS_READ_BEFORE_RETURN; read += 1) {
            expect((await iterator.next()).done).toBe(false);
          }
          await iterator.return?.();
          expect(await collect((await session.execute(selectOne)).rows)).toEqual([[1]]);
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("sql"))("language", () => {
      function language(): SqlLanguage {
        if (plugin.language === undefined) throw new Error("A plugin that declares sql needs language.");
        return plugin.language;
      }

      function statementsOf(text: string): string[] {
        const spans = language().split(text);
        for (const span of spans) expect(text.slice(span.from, span.to)).toBe(span.sql);
        return spans.map((span) => span.sql);
      }

      it.each([...dialectSql.sharedScripts, ...(fixture.scripts ?? [])])(
        "givenScript_whenSplit_thenStatementsMatch: $text",
        ({ text, statements }) => {
          expect(statementsOf(text)).toEqual(statements);
        },
      );

      it.each([...dialectSql.sharedScripts, ...(fixture.scripts ?? [])])(
        "givenScriptInPieces_whenSplitStreamed_thenSameStatementsAsSplit: $text",
        ({ text }) => {
          const stream = language().splitStream?.();
          if (stream === undefined) return;
          const streamed = [...text].flatMap((character) => stream.push(character)).concat(stream.end());
          expect(streamed.map(({ from, to, sql }) => ({ from, to, sql }))).toEqual(
            language()
              .split(text)
              .map(({ from, to, sql }) => ({ from, to, sql })),
          );
        },
      );

      it("givenSplitScript_whenEachStatementExecuted_thenEachSucceeds", async () => {
        const statements = statementsOf(
          `${dialectSql.select("'a;b' AS s")};\n-- between\n${dialectSql.select("2 AS n")};`,
        );
        await withSession(plugin, fixture, async (session) => {
          for (const sql of statements) await collect((await session.execute(sql)).rows);
        });
        expect(statements).toHaveLength(2);
      });

      it.each(DESTRUCTIVE_CASES)(
        "givenStatement_whenClassified_thenDestructiveMatches: %s → %s",
        (sql, destructive) => {
          expect(language().classify(sql).destructive !== null).toBe(destructive);
        },
      );

      it("givenAwkwardIdentifier_whenQuotedAndSelected_thenNameReadsBack", async () => {
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(
            dialectSql.select(`1 AS ${language().quoteIdentifier(dialectSql.awkwardIdentifier)}`),
          );
          await collect(result.rows);
          expect(result.columns.map((column) => column.name)).toEqual([dialectSql.awkwardIdentifier]);
        });
      });

      it("givenTypeProbeRow_whenSqlInsertPerDialect_thenRoundTripsEqual", async () => {
        const dialect = language();
        const run = async (session: Session, sql: string): Promise<Row[]> => collect((await session.execute(sql)).rows);
        await withSession(plugin, fixture, async (session) => {
          const source = await session.execute(`SELECT * FROM ${TYPE_PROBE_TABLE} ORDER BY id`);
          const rows = await collect(source.rows);
          const names = source.columns.map((column) => dialect.quoteIdentifier(column.name)).join(", ");
          await run(session, dropIfExists(TYPE_PROBE_COPY_TABLE));
          await run(session, typeProbeOf(fixture).copyTable);
          try {
            for (const row of rows) {
              const values = row.map((value, index) => dialect.literal(value, source.columns[index]?.type ?? null));
              await run(
                session,
                `INSERT INTO ${dialect.quoteIdentifier(fold(TYPE_PROBE_COPY_TABLE))} (${names}) VALUES (${values.join(", ")})`,
              );
            }
            expect(await run(session, `SELECT * FROM ${TYPE_PROBE_COPY_TABLE} ORDER BY id`)).toEqual(
              typeProbeOf(fixture).expected,
            );
          } finally {
            await run(session, dropIfExists(TYPE_PROBE_COPY_TABLE));
          }
        });
      });

      it("givenFullBytes_whenExecuting_thenBytesPreviewIsComplete", async () => {
        const dialect = language();
        const run = async (session: Session, sql: string, options?: ExecuteOptions): Promise<Row[]> =>
          collect((await session.execute(sql, [], options)).rows);
        const whole = LONG_BYTES_HEX.repeat(LONG_BYTES_LENGTH);
        await withSession(plugin, fixture, async (session) => {
          const probe = await session.execute(`SELECT id, payload FROM ${TYPE_PROBE_TABLE} ORDER BY id`);
          const payloadType = probe.columns[1]?.type ?? null;
          await collect(probe.rows);
          await run(session, dropIfExists(TYPE_PROBE_COPY_TABLE));
          await run(session, typeProbeOf(fixture).copyTable);
          try {
            const payload = dialect.literal({ kind: "bytes", preview: whole, length: LONG_BYTES_LENGTH }, payloadType);
            await run(
              session,
              `INSERT INTO ${dialect.quoteIdentifier(fold(TYPE_PROBE_COPY_TABLE))} (id, payload) VALUES (${PROBE_ROW_ID}, ${payload})`,
            );
            const select = `SELECT payload FROM ${TYPE_PROBE_COPY_TABLE}`;
            expect(await run(session, select, { fullBytes: true })).toEqual([
              [{ kind: "bytes", preview: whole, length: LONG_BYTES_LENGTH }],
            ]);
            expect(await run(session, select)).toEqual([
              [
                {
                  kind: "bytes",
                  preview: whole.slice(0, BYTES_PREVIEW_LENGTH * HEX_DIGITS_PER_BYTE),
                  length: LONG_BYTES_LENGTH,
                },
              ],
            ]);
          } finally {
            await run(session, dropIfExists(TYPE_PROBE_COPY_TABLE));
          }
        });
      });

      it("givenDropTable_whenClassified_thenDdl", () => {
        expect(language().classify("DROP TABLE orders").kind).toBe("ddl");
        expect(language().classify("CREATE TABLE t (id INTEGER)").kind).toBe("ddl");
        expect(language().classify("SELECT 1").kind).toBe("read");
        expect(language().classify("INSERT INTO t VALUES (1)").kind).toBe("write");
        expect(language().classify("COMMIT").kind).toBe("transaction");
      });

      it("givenColumnAndExpression_whenSelected_thenOriginsTellThemApart", async () => {
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(`SELECT id, id + 1 AS next FROM ${TYPE_PROBE_TABLE}`);
          await collect(result.rows);
          const [column, expression] = result.columns;
          if (column?.origin === undefined) return;
          expect(column.origin).not.toBeNull();
          expect(expression?.origin).toBeNull();
        });
      });

      it.runIf(plugin.capabilities.includes("schemaTree"))(
        "givenSingleTableSelect_whenSourceRead_thenNamesTheTableAndItsColumns",
        async () => {
          await withSession(plugin, fixture, async (session) => {
            const introspector = session.introspector;
            const lang = language();
            const selectSource = lang.selectSource?.bind(lang);
            if (introspector === undefined || selectSource === undefined) return;
            const catalog = await liveCompletionCatalog(introspector);
            const source = await selectSource(`SELECT id, id + 1 AS next FROM ${TYPE_PROBE_TABLE}`, catalog);
            expect(source).toEqual({
              kind: "table",
              path: catalogPathOf(fixture),
              relation: fold(TYPE_PROBE_TABLE),
              columns: [fold("id"), null],
            });
          });
        },
      );

      it("givenSavepoint_whenRolledBackToAndReleased_thenTheTransactionStaysOpen", async () => {
        const lang = language();
        const savepoint = lang.savepoint?.bind(lang);
        if (savepoint === undefined) return;
        await withSession(plugin, fixture, async (session) => {
          const transactions = session.transactions;
          if (transactions === undefined) return;
          const statements = savepoint("table_craft_contract");
          await transactions.setMode("manual");
          try {
            await collect((await session.execute(statements.set)).rows);
            await collect((await session.execute(statements.rollback)).rows);
            await collect((await session.execute(statements.release)).rows);
            expect(transactions.open).toBe(true);
          } finally {
            await transactions.rollback();
            await transactions.setMode("auto");
          }
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("bulkInsert"))("bulkInsert", () => {
      const run = async (session: Session, sql: string): Promise<Row[]> => collect((await session.execute(sql)).rows);

      function insertRowsOf(session: Session): (target: InsertTarget, rows: readonly InsertRow[]) => Promise<void> {
        const insert = session.insertRows?.bind(session);
        if (insert === undefined) throw new Error("A bulkInsert session needs insertRows.");
        return insert;
      }

      /** The copy table as the engine targets it: named and typed by the introspector. */
      async function copyTarget(session: Session): Promise<InsertTarget> {
        await run(session, dropIfExists(TYPE_PROBE_COPY_TABLE));
        await run(session, typeProbeOf(fixture).copyTable);
        const introspector = session.introspector;
        if (introspector === undefined) {
          const probe = await session.execute(`SELECT * FROM ${TYPE_PROBE_COPY_TABLE}`);
          await collect(probe.rows);
          return { table: TYPE_PROBE_COPY_TABLE, columns: probe.columns };
        }
        const path = catalogPathOf(fixture);
        const relation = (await introspector.describe(path)).relations.find(
          (candidate) => candidate.name === fold(TYPE_PROBE_COPY_TABLE),
        );
        if (relation === undefined) throw new Error(`${TYPE_PROBE_COPY_TABLE} was not described.`);
        return {
          table: introspector.qualifiedName(path, fold(TYPE_PROBE_COPY_TABLE)),
          columns: relation.columns.map((column) => ({ name: column.name, type: column.type })),
        };
      }

      async function withCopy(use: (session: Session, target: InsertTarget) => Promise<void>): Promise<void> {
        await withSession(plugin, fixture, async (session) => {
          try {
            await use(session, await copyTarget(session));
          } finally {
            await session.transactions?.rollback();
            await run(session, dropIfExists(TYPE_PROBE_COPY_TABLE));
          }
        });
      }

      it("givenBulkInsert_whenTypeProbeTextInserted_thenReadBackEqual", async () => {
        await withCopy(async (session, target) => {
          const rows = typeProbeOf(fixture).expected.map((row) => row.map(exportedText));

          await insertRowsOf(session)(target, rows);

          expect(await run(session, `SELECT * FROM ${TYPE_PROBE_COPY_TABLE} ORDER BY id`)).toEqual(
            typeProbeOf(fixture).expected,
          );
        });
      });

      it("givenBulkInsert_whenBatchRefused_thenNothingOfItAndTransactionUsable", async () => {
        await withCopy(async (session, target) => {
          const insert = insertRowsOf(session);
          const row = (id: string): InsertRow =>
            target.columns.map((column) => (column.name === fold("id") ? id : null));
          await session.transactions?.setMode("manual");

          await insert(target, [row("1")]);
          const refused = await rejectionCode(insert(target, [row("2"), row("not a number")]));
          const open = session.transactions?.open;
          await insert(target, [row("3")]);
          await session.transactions?.commit();
          await session.transactions?.setMode("auto");

          expect(refused).toBe("statementFailed");
          expect(open).toBe(true);
          expect(await run(session, `SELECT id FROM ${TYPE_PROBE_COPY_TABLE} ORDER BY id`)).toEqual([[1], [3]]);
        });
      });

      it("givenBulkInsert_whenControlCharacters_thenRoundTrip", async () => {
        await withCopy(async (session, target) => {
          const texts = AWKWARD_TEXTS;
          const rows = texts.map((text, index) =>
            target.columns.map((column) =>
              column.name === fold("id") ? String(index + 1) : column.name === fold("unicode_text") ? text : null,
            ),
          );

          await insertRowsOf(session)(target, rows);

          expect(await run(session, `SELECT unicode_text FROM ${TYPE_PROBE_COPY_TABLE} ORDER BY id`)).toEqual(
            texts.map((text) => [text === "" && fixture.emptyTextIsNull === true ? null : text]),
          );
        });
      });

      it("givenCreateTable_whenEveryImportType_thenTableTakesSampleText", async () => {
        const dialect = plugin.language;
        if (dialect === undefined) throw new Error("A bulkInsert plugin needs language.");
        await withSession(plugin, fixture, async (session) => {
          const columns = IMPORT_KINDS.map((kind) => ({
            name: `${kind}_value`,
            type: dialect.importType?.({ kind, integerDigits: 7, scale: 3 }) ?? "",
          }));
          const create = dialect.createTable?.(IMPORT_PROBE_TABLE, columns) ?? "";
          await run(session, dropIfExists(IMPORT_PROBE_TABLE));
          try {
            expect(dialect.classify(create).kind).toBe("ddl");
            await run(session, create);
            await insertRowsOf(session)({ table: IMPORT_PROBE_TABLE, columns }, [
              IMPORT_KINDS.map((kind) => IMPORT_SAMPLES[kind]),
            ]);
            expect(await run(session, `SELECT COUNT(*) AS n FROM ${IMPORT_PROBE_TABLE}`)).toHaveLength(1);
          } finally {
            await run(session, dropIfExists(IMPORT_PROBE_TABLE));
          }
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("objects"))("objects", () => {
      const run = async (session: Session, sql: string): Promise<Row[]> => collect((await session.execute(sql)).rows);
      const path = (): readonly string[] => catalogPathOf(fixture);

      function editorOf(): ObjectEditor {
        const editor = plugin.language?.objects;
        if (editor === undefined) throw new Error("An objects plugin needs language.objects.");
        return editor;
      }

      function introspectorOf(session: Session): Introspector {
        if (session.introspector === undefined) throw new Error("An objects plugin needs an introspector.");
        return session.introspector;
      }

      async function relationOf(session: Session, name: string): Promise<Relation | undefined> {
        return (await introspectorOf(session).describe(path())).relations.find(
          (relation) => relation.name === fold(name),
        );
      }

      /** Runs a script as the engine does: prepare, the statements in one transaction where it says so, verify, finish. */
      async function apply(session: Session, script: DdlScript): Promise<void> {
        for (const sql of script.prepare) await run(session, sql);
        const transactions = script.transactional ? session.transactions : undefined;
        try {
          await transactions?.setMode("manual");
          try {
            for (const sql of script.statements) await run(session, sql);
            for (const sql of script.verify) {
              if ((await run(session, sql)).length > 0) throw new Error(`${sql} found rows.`);
            }
            await transactions?.commit();
          } catch (error) {
            await transactions?.rollback();
            throw error;
          } finally {
            await transactions?.setMode("auto");
          }
        } finally {
          for (const sql of script.finish) await run(session, sql);
        }
      }

      async function scriptOf(session: Session, change: ObjectChange): Promise<DdlScript> {
        const introspector = introspectorOf(session);
        let current: TableDesign | null = null;
        if (change.kind === "alterTable") {
          const relation = await relationOf(session, change.relation);
          if (relation === undefined) throw new Error(`${change.relation} was not described.`);
          current = editorOf().design(relation);
        }
        const context: DdlContext = { qualifiedName: introspector.qualifiedName.bind(introspector), current };
        return editorOf().script(change, context);
      }

      function column(name: string, type: string, nullable = true): ColumnDesign {
        return { name: fold(name), type, nullable, default: null, autoIncrement: false, comment: null, original: null };
      }

      function parentDesign(): TableDesign {
        return {
          name: fold(OBJECT_PARENT_TABLE),
          comment: null,
          columns: [column("id", OBJECT_KEY_TYPE, false)],
          primaryKey: [fold("id")],
          primaryKeyName: null,
          indexes: [],
          foreignKeys: [],
          checks: [],
        };
      }

      function childDesign(): TableDesign {
        return {
          name: fold(OBJECT_CHILD_TABLE),
          comment: null,
          columns: [
            column("id", OBJECT_KEY_TYPE, false),
            column("parent_id", OBJECT_KEY_TYPE),
            column("label", OBJECT_NARROW_TYPE),
            column("obsolete", OBJECT_NARROW_TYPE),
          ],
          primaryKey: [fold("id")],
          primaryKeyName: null,
          indexes: [{ name: fold(OBJECT_INDEX), columns: [fold("label")], unique: false, original: null }],
          foreignKeys: [
            {
              name: fold(OBJECT_FOREIGN_KEY),
              columns: [fold("parent_id")],
              target: { path: path(), relation: fold(OBJECT_PARENT_TABLE), columns: [fold("id")] },
              onDelete: "CASCADE",
              onUpdate: null,
              original: null,
            },
          ],
          checks: [],
        };
      }

      async function dropAll(session: Session): Promise<void> {
        const introspector = introspectorOf(session);
        for (const table of [OBJECT_CHILD_TABLE, OBJECT_RENAMED_TABLE, OBJECT_PARENT_TABLE]) {
          await run(session, dropIfExists(introspector.qualifiedName(path(), fold(table))));
        }
      }

      /** A parent and a child with one row each, created through the editor. */
      async function withTables(use: (session: Session) => Promise<void>): Promise<void> {
        await withSession(plugin, fixture, async (session) => {
          await dropAll(session);
          try {
            await apply(
              session,
              await scriptOf(session, { kind: "createTable", path: path(), design: parentDesign() }),
            );
            await apply(session, await scriptOf(session, { kind: "createTable", path: path(), design: childDesign() }));
            await run(session, `INSERT INTO ${OBJECT_PARENT_TABLE} (id) VALUES (1)`);
            await run(session, OBJECT_ROW);
            await use(session);
          } finally {
            await dropAll(session);
          }
        });
      }

      /** The child's design as described, with `label` widened, `obsolete` dropped and `note` added. */
      async function widenedChild(session: Session, extra: Partial<TableDesign> = {}): Promise<TableDesign> {
        const relation = await relationOf(session, OBJECT_CHILD_TABLE);
        if (relation === undefined) throw new Error(`${OBJECT_CHILD_TABLE} was not described.`);
        const described = editorOf().design(relation);
        return {
          ...described,
          columns: [
            ...described.columns
              .filter((entry) => entry.name !== fold("obsolete"))
              .map((entry) => (entry.name === fold("label") ? { ...entry, type: OBJECT_WIDE_TYPE } : entry)),
            column("note", OBJECT_NARROW_TYPE),
          ],
          ...extra,
        };
      }

      it("givenObjectsDeclared_whenCreateTableWithKeyIndexAndForeignKey_thenDescribedAsDesigned", async () => {
        await withTables(async (session) => {
          const child = await relationOf(session, OBJECT_CHILD_TABLE);

          expect(child?.columns.map((entry) => entry.name)).toEqual(["id", "parent_id", "label", "obsolete"].map(fold));
          expect(child?.primaryKey?.columns).toEqual([fold("id")]);
          expect(child?.indexes.map((index) => index.name)).toContain(fold(OBJECT_INDEX));
          expect(child?.foreignKeys.map((key) => [key.target.relation, key.target.columns, key.onDelete])).toEqual([
            [fold(OBJECT_PARENT_TABLE), [fold("id")], "CASCADE"],
          ]);
        });
      });

      it("givenDescribedDesign_whenScriptedUnchanged_thenNoStatement", async () => {
        await withTables(async (session) => {
          const relation = await relationOf(session, OBJECT_CHILD_TABLE);
          if (relation === undefined) throw new Error(`${OBJECT_CHILD_TABLE} was not described.`);

          const script = await scriptOf(session, {
            kind: "alterTable",
            path: path(),
            relation: fold(OBJECT_CHILD_TABLE),
            design: editorOf().design(relation),
          });

          expect(script.statements).toEqual([]);
        });
      });

      it("givenTable_whenColumnAddedTypeChangedAndDropped_thenDescribedAfterAndRowsKept", async () => {
        await withTables(async (session) => {
          const design = await widenedChild(session);

          await apply(
            session,
            await scriptOf(session, { kind: "alterTable", path: path(), relation: fold(OBJECT_CHILD_TABLE), design }),
          );

          const child = await relationOf(session, OBJECT_CHILD_TABLE);
          expect(child?.columns.map((entry) => entry.name)).toEqual(["id", "parent_id", "label", "note"].map(fold));
          expect(child?.columns.find((entry) => entry.name === fold("label"))?.type).toMatch(OBJECT_WIDE_LENGTH);
          expect(child?.foreignKeys).toHaveLength(1);
          expect(child?.indexes.map((index) => index.name)).toContain(fold(OBJECT_INDEX));
          expect(await run(session, `SELECT label FROM ${OBJECT_CHILD_TABLE}`)).toEqual([["kept"]]);
        });
      });

      it.runIf(plugin.capabilities.includes("transactions"))(
        "givenTransactionalScript_whenStatementFails_thenNothingApplied",
        async () => {
          await withTables(async (session) => {
            // A second index under the table's own index name clashes in every dialect; one named like a
            // table does not where index names are per table, as on SQL Server.
            const design = await widenedChild(session, {});
            const clashing: TableDesign = {
              ...design,
              indexes: [
                ...design.indexes,
                { name: fold(OBJECT_INDEX), columns: [fold("note")], unique: false, original: null },
              ],
            };
            const script = await scriptOf(session, {
              kind: "alterTable",
              path: path(),
              relation: fold(OBJECT_CHILD_TABLE),
              design: clashing,
            });
            if (!script.transactional) return;

            await expect(apply(session, script)).rejects.toThrow();

            const child = await relationOf(session, OBJECT_CHILD_TABLE);
            expect(child?.columns.map((entry) => entry.name)).toEqual(
              ["id", "parent_id", "label", "obsolete"].map(fold),
            );
            expect(await run(session, `SELECT label FROM ${OBJECT_CHILD_TABLE}`)).toEqual([["kept"]]);
          });
        },
      );

      it("givenTable_whenRenamed_thenDescribedUnderNewName", async () => {
        await withTables(async (session) => {
          await apply(
            session,
            await scriptOf(session, {
              kind: "rename",
              path: path(),
              object: { kind: "table", name: fold(OBJECT_CHILD_TABLE) },
              name: fold(OBJECT_RENAMED_TABLE),
            }),
          );

          expect(await relationOf(session, OBJECT_CHILD_TABLE)).toBeUndefined();
          expect((await relationOf(session, OBJECT_RENAMED_TABLE))?.columns).toHaveLength(4);
        });
      });

      it("givenTableWithRows_whenTruncated_thenEmptyAndStillDescribed", async () => {
        await withTables(async (session) => {
          await apply(
            session,
            await scriptOf(session, {
              kind: "truncate",
              path: path(),
              relation: fold(OBJECT_CHILD_TABLE),
              cascade: false,
            }),
          );

          expect(await run(session, `SELECT id FROM ${OBJECT_CHILD_TABLE}`)).toEqual([]);
          expect(await relationOf(session, OBJECT_CHILD_TABLE)).toBeDefined();
        });
      });

      it("givenTable_whenDropped_thenNotDescribed", async () => {
        await withTables(async (session) => {
          await apply(
            session,
            await scriptOf(session, {
              kind: "drop",
              path: path(),
              object: { kind: "table", name: fold(OBJECT_CHILD_TABLE) },
              cascade: false,
            }),
          );

          expect(await relationOf(session, OBJECT_CHILD_TABLE)).toBeUndefined();
        });
      });

      it("givenFeatures_whenRead_thenEveryDroppableKindNamedAndTypesSuggested", () => {
        const { features } = editorOf();

        expect(features.types.length).toBeGreaterThan(0);
        expect(features.droppable).toContain("table");
        expect(features.renamable).toContain("table");
      });
    });

    describe.runIf(plugin.capabilities.includes("transactions"))("transactions", () => {
      function transactionsOf(session: Session): Transactions {
        if (session.transactions === undefined) throw new Error("A transactions session needs transactions.");
        return session.transactions;
      }

      async function rowsWithId(session: Session): Promise<number> {
        return (await collect((await session.execute(SELECT_TRANSACTION_ROW)).rows)).length;
      }

      async function removeRow(): Promise<void> {
        await withSession(plugin, fixture, async (session) => {
          await session.execute(DELETE_TRANSACTION_ROW);
        });
      }

      afterEach(removeRow);

      it("givenManualMode_whenInsertThenRollback_thenRowGoneAndNotOpen", async () => {
        await withSession(plugin, fixture, async (session) => {
          const transactions = transactionsOf(session);
          await transactions.setMode("manual");
          expect(transactions.open).toBe(false);
          await session.execute(INSERT_TRANSACTION_ROW);
          expect(transactions.open).toBe(true);
          expect(await rowsWithId(session)).toBe(1);
          await transactions.rollback();
          expect(transactions.open).toBe(false);
          expect(await rowsWithId(session)).toBe(0);
          expect(transactions.mode).toBe("manual");
        });
      });

      it("givenManualMode_whenInsertThenCommit_thenRowKept", async () => {
        await withSession(plugin, fixture, async (session) => {
          const transactions = transactionsOf(session);
          await transactions.setMode("manual");
          await session.execute(INSERT_TRANSACTION_ROW);
          await withSession(plugin, fixture, async (other) => {
            expect(await rowsWithId(other)).toBe(0);
          });
          await transactions.commit();
          expect(transactions.open).toBe(false);
        });
        await withSession(plugin, fixture, async (other) => {
          expect(await rowsWithId(other)).toBe(1);
        });
      });

      it("givenAutoMode_whenExplicitBegin_thenTransactionOpen", async () => {
        await withSession(plugin, fixture, async (session) => {
          const transactions = transactionsOf(session);
          await session.execute(INSERT_TRANSACTION_ROW);
          expect(transactions.open).toBe(false);
          await session.execute(DELETE_TRANSACTION_ROW);
          await session.execute(dialectSql.begin);
          expect(transactions.open).toBe(true);
          await session.execute(INSERT_TRANSACTION_ROW);
          await session.execute("ROLLBACK");
          expect(transactions.open).toBe(false);
          expect(await rowsWithId(session)).toBe(0);
        });
      });

      it("givenOpenTransaction_whenSwitchedToAuto_thenRejectsWithStatementFailedAndStaysOpen", async () => {
        await withSession(plugin, fixture, async (session) => {
          const transactions = transactionsOf(session);
          await transactions.setMode("manual");
          await session.execute(INSERT_TRANSACTION_ROW);
          expect(await rejectionCode(transactions.setMode("auto"))).toBe("statementFailed");
          expect(transactions.open).toBe(true);
          await transactions.rollback();
          await transactions.setMode("auto");
          expect(transactions.mode).toBe("auto");
        });
      });

      it("givenNoOpenTransaction_whenCommitAndRollback_thenNoOps", async () => {
        await withSession(plugin, fixture, async (session) => {
          const transactions = transactionsOf(session);
          await transactions.commit();
          await transactions.rollback();
          expect(transactions.open).toBe(false);
          expect(await collect((await session.execute(selectOne)).rows)).toEqual([[1]]);
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("sql") && plugin.capabilities.includes("transactions"))("edits", () => {
      it("givenEditProbe_whenEditsRoundTrip_thenRowsMatch", async () => {
        const dialect = plugin.language;
        if (dialect === undefined) throw new Error("A plugin that declares sql needs language.");
        const table = dialect.quoteIdentifier(fold(EDIT_PROBE_TABLE));
        const name = (column: string): string => dialect.quoteIdentifier(fold(column));
        const text = (value: string): string => dialect.literal(value, EDIT_PROBE_TEXT_TYPE);
        const key = (id: Row[number]): string => `${name("id")} = ${dialect.literal(id, EDIT_PROBE_KEY_TYPE)}`;
        await withSession(plugin, fixture, async (session) => {
          const transactions = session.transactions;
          if (transactions === undefined) throw new Error("A transactions session needs transactions.");
          const read = async (): Promise<Row[]> => collect((await session.execute(EDIT_PROBE_SELECT)).rows);
          const affected = async (sql: string): Promise<number | null> => {
            const result = await session.execute(sql);
            await collect(result.rows);
            return result.rowsAffected;
          };
          const qtyDefault =
            (await session.introspector?.describe(catalogPathOf(fixture)))?.relations
              .find((relation) => relation.name === fold(EDIT_PROBE_TABLE))
              ?.columns.find((column) => column.name === fold("qty"))?.default ?? String(EDIT_PROBE_DEFAULT_QTY);
          const before = await read();
          await transactions.setMode("manual");
          try {
            expect(await affected(`INSERT INTO ${table} (${name("label")}) VALUES (${text("round trip")})`)).toBe(1);
            expect(await affected(dialect.emptyInsert(table))).toBe(1);
            const inserted = (await read()).slice(before.length);
            expect(inserted.map((row) => row.slice(1))).toEqual([
              ["round trip", EDIT_PROBE_DEFAULT_QTY, null],
              [EDIT_PROBE_DEFAULT_LABEL, EDIT_PROBE_DEFAULT_QTY, null],
            ]);
            const [kept, dropped] = inserted;
            const update =
              `UPDATE ${table} SET ${name("label")} = ${text("it's changed")}, ${name("qty")} = ${text("7")}, ` +
              `${name("note")} = NULL WHERE ${key(kept?.[0] ?? null)}`;
            expect(await affected(update)).toBe(1);
            // Unchanged values must still count the matched row, or Submit would reject a no-op edit.
            expect(await affected(update)).toBe(1);
            const reset = `UPDATE ${table} SET ${name("qty")} = ${dialect.updateDefault(qtyDefault)} WHERE ${key(kept?.[0] ?? null)}`;
            expect(await affected(`UPDATE ${table} SET ${name("qty")} = 2 WHERE ${key(kept?.[0] ?? null)}`)).toBe(1);
            expect(await affected(reset)).toBe(1);
            expect(await affected(`DELETE FROM ${table} WHERE ${key(dropped?.[0] ?? null)}`)).toBe(1);
            expect((await read()).slice(before.length).map((row) => row.slice(1))).toEqual([
              ["it's changed", EDIT_PROBE_DEFAULT_QTY, null],
            ]);
            expect(
              await affected(`UPDATE ${table} SET ${name("label")} = ${text("x")} WHERE ${key(MISSING_ROW_ID)}`),
            ).toBe(0);
          } finally {
            await transactions.rollback();
            await transactions.setMode("auto");
          }
          expect(await read()).toEqual(before);
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("schemaTree"))("schemaTree", () => {
      function catalogFixture(): NonNullable<ContractFixture["catalog"]> {
        if (fixture.catalog === undefined) {
          throw new Error("A plugin that declares schemaTree needs fixture.catalog.");
        }
        return fixture.catalog;
      }

      async function withIntrospector(use: (introspector: Introspector) => Promise<void>): Promise<void> {
        await withSession(plugin, fixture, async (session) => {
          const introspector = session.introspector;
          if (introspector === undefined) throw new Error("A schemaTree session needs an introspector.");
          await use(introspector);
        });
      }

      async function describeFixture(): Promise<NamespaceCatalog> {
        let described: NamespaceCatalog | undefined;
        await withIntrospector(async (introspector) => {
          described = await introspector.describe(catalogFixture().path);
        });
        if (described === undefined) throw new Error("describe resolved nothing.");
        return described;
      }

      function relation(catalog: NamespaceCatalog, name: string): Relation {
        const found = catalog.relations.find((candidate) => candidate.name === fold(name));
        if (found === undefined) throw new Error(`The fixture namespace has no relation ${name}.`);
        return found;
      }

      it("givenSchemaTreePlugin_whenNamespacesListed_thenCurrentNamespaceIsMarked", async () => {
        await withIntrospector(async (introspector) => {
          const namespaces = await introspector.namespaces();
          const current = namespaces.filter((namespace) => namespace.current);
          expect(current.map((namespace) => namespace.path)).toEqual([catalogFixture().path]);
          expect(current[0]?.system).toBe(false);
          expect(current[0]?.name).toBe(catalogFixture().path.at(-1));
        });
      });

      it("givenFixture_whenDescribed_thenCustomersOrdersTypeProbeAndCustomerTotalsArePresent", async () => {
        const catalog = await describeFixture();
        expect(catalog.path).toEqual(catalogFixture().path);
        const names = catalog.relations.map((candidate) => candidate.name);
        expect(names).toEqual([...names].sort());
        expect(catalog.relations.map(({ name, kind }) => ({ name, kind }))).toEqual(
          expect.arrayContaining(FIXTURE_RELATIONS.map((expected) => ({ ...expected, name: fold(expected.name) }))),
        );
        const probe = relation(catalog, TYPE_PROBE_TABLE);
        expect(probe.columns.map((column) => column.name)).toEqual(TYPE_PROBE_COLUMNS.map(fold));
        expect(probe.columns.map((column) => column.position)).toEqual(TYPE_PROBE_COLUMNS.map((_, index) => index + 1));
        for (const column of probe.columns) expect(column.type).toMatch(/\S/);
      });

      it("givenOrders_whenDescribed_thenForeignKeyTargetsCustomersId", async () => {
        const orders = relation(await describeFixture(), "orders");
        expect(orders.foreignKeys).toHaveLength(1);
        expect(orders.foreignKeys[0]).toMatchObject({
          columns: [fold("customer_id")],
          target: { path: catalogFixture().path, relation: fold("customers"), columns: [fold("id")] },
        });
        expect(orders.foreignKeys[0]?.onDelete).toMatch(/\S/);
        const customerId = orders.columns.find((column) => column.name === fold("customer_id"));
        expect(customerId?.nullable).toBe(false);
      });

      it("givenOrders_whenDescribed_thenIndexOrdersPlacedAtIdxIsListed", async () => {
        const orders = relation(await describeFixture(), "orders");
        expect(orders.indexes).toContainEqual({
          name: fold(ORDERS_INDEX),
          columns: [fold("placed_at")],
          unique: false,
          primary: false,
        });
      });

      it("givenCustomers_whenDescribed_thenIdIsPrimaryKeyAndEmailIsUnique", async () => {
        const customers = relation(await describeFixture(), "customers");
        expect(customers.comment).toBe(catalogFixture().customersComment);
        expect(customers.primaryKey?.columns).toEqual([fold("id")]);
        expect(customers.uniqueKeys.map((key) => key.columns)).toEqual([[fold("email")]]);
        expect(customers.columns.find((column) => column.name === fold("email"))?.nullable).toBe(false);
      });

      it("givenUnknownNamespace_whenDescribed_thenRejectsWithIntrospectionFailed", async () => {
        const missing = [...catalogFixture().path.slice(0, -1), MISSING_NAMESPACE];
        await withIntrospector(async (introspector) => {
          expect(await rejectionCode(introspector.describe(missing))).toBe("introspectionFailed");
        });
      });

      it("givenIdentifierNeedingQuotes_whenQualified_thenPluginQuotesIt", async () => {
        const { path, quoted } = catalogFixture();
        await withIntrospector((introspector) => {
          expect(introspector.qualifiedName(path, quoted.name)).toBe(quoted.qualified);
          return Promise.resolve();
        });
      });

      it("givenIntrospection_whenStatementRunAfter_thenSessionStillWorks", async () => {
        await withSession(plugin, fixture, async (session) => {
          await session.introspector?.describe(catalogFixture().path);
          expect(await collect((await session.execute(selectOne)).rows)).toEqual([[1]]);
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("sql") && plugin.capabilities.includes("schemaTree"))(
      "completion",
      () => {
        function completionFixture() {
          const catalog = fixture.catalog;
          const language = plugin.language;
          if (catalog === undefined || language === undefined) {
            throw new Error("A plugin that declares sql and schemaTree needs a language and fixture.catalog.");
          }
          return { catalog, language };
        }

        /** The completer against the live database, read the way the engine's cache reads it. */
        async function withCompletion(
          use: (language: SqlLanguage, catalog: CompletionCatalog) => Promise<void>,
        ): Promise<void> {
          const { language } = completionFixture();
          await withSession(plugin, fixture, async (session) => {
            const introspector = session.introspector;
            if (introspector === undefined) throw new Error("A schemaTree session needs an introspector.");
            await use(language, await liveCompletionCatalog(introspector, session.serverVersion));
          });
        }

        function at(text: string, marker: string): { text: string; offset: number } {
          return { text: text.replace(marker, ""), offset: text.indexOf(marker) };
        }

        it("givenFromClause_whenCompleting_thenOffersFixtureTablesAndViews", async () => {
          await withCompletion(async (language, catalog) => {
            const result = await language.complete(at("SELECT * FROM |", "|"), catalog);
            const offered = result.items.map(({ label, kind }) => ({ label, kind }));
            expect(offered).toEqual(
              expect.arrayContaining([
                { label: fold("orders"), kind: "table" },
                { label: fold("customers"), kind: "table" },
                { label: fold("customer_totals"), kind: "view" },
              ]),
            );
          });
        });

        it("givenAliasDot_whenCompleting_thenOffersAliasedColumnsWithTypes", async () => {
          await withCompletion(async (language, catalog) => {
            const result = await language.complete(at("SELECT o.| FROM orders o", "|"), catalog);
            const columns = result.items.filter((item) => item.kind === "column");
            expect(columns.map((item) => item.label)).toEqual(["id", "customer_id", "total", "placed_at"].map(fold));
            for (const column of columns) expect(column.detail).toMatch(/\S/);
          });
        });

        it("givenJoinAfterOrders_whenCompleting_thenCustomersJoinFirstWithOnClause", async () => {
          await withCompletion(async (language, catalog) => {
            const result = await language.complete(at("SELECT * FROM orders o JOIN |", "|"), catalog);
            const first = [...result.items].sort((left, right) => right.boost - left.boost)[0];
            expect(first).toMatchObject({
              kind: "join",
              apply: `${fold("customers")} c ON c.${fold("id")} = o.${fold("customer_id")}`,
            });
          });
        });

        it("givenNameNeedingQuotes_whenCompleting_thenApplyIsQuotedByDialect", async () => {
          const { catalog: expected } = completionFixture();
          await withCompletion(async (language, catalog) => {
            const result = await language.complete(at("SELECT * FROM Li|", "|"), catalog);
            const item = result.items.find((candidate) => candidate.label === LINE_ITEMS_TABLE);
            expect(item?.apply).toBe(expected.lineItems);
          });
        });

        it("givenAliasReference_whenResolving_thenReturnsDeclarationSpan", async () => {
          await withCompletion(async (language, catalog) => {
            const text = "SELECT o.id FROM orders o";
            const declaration = await language.resolve({ text, offset: text.indexOf("o.id") }, catalog);
            const from = text.indexOf("orders o");
            expect(declaration).toEqual({ kind: "alias", from, to: from + "orders o".length });
          });
        });

        it("givenUpperCallOpen_whenAskingSignature_thenFirstArgumentOfUpper", async () => {
          await withCompletion(async (language, catalog) => {
            const text = "SELECT upper( FROM orders";
            const offset = text.indexOf("(") + 1;
            const help = await language.signatureAt?.({ text, offset }, catalog);
            expect(help).toMatchObject({ name: "upper", argument: 0, from: text.indexOf("upper") });
            expect(help?.signatures[0]?.parameters.length).toBe(1);
            expect(help?.summary).toMatch(/\S/);
          });
        });

        it("givenFunctionPrefix_whenCompleting_thenItemCarriesSignatureAndCaretInsideCall", async () => {
          await withCompletion(async (language, catalog) => {
            const result = await language.complete(at("SELECT upp| FROM orders", "|"), catalog);
            const upper = result.items.find((item) => item.kind === "function" && item.label === "upper");
            expect(upper).toMatchObject({ apply: "upper()", caret: "upper(".length });
            expect(upper?.detail).toMatch(/^\(.*\) → /);
            expect(upper?.info).toMatch(/\S/);
          });
        });

        it("givenRelationReference_whenResolving_thenReturnsCurrentPathAndRelation", async () => {
          const { catalog: expected } = completionFixture();
          await withCompletion(async (language, catalog) => {
            const text = "SELECT * FROM customers";
            const declaration = await language.resolve({ text, offset: text.indexOf("customers") + 2 }, catalog);
            expect(declaration).toEqual({ kind: "relation", path: expected.path, relation: fold("customers") });
          });
        });

        describe.runIf(plugin.language?.inspect !== undefined)("inspect", () => {
          async function inspect(text: string, catalog: CompletionCatalog): Promise<readonly Problem[]> {
            const inspector = plugin.language?.inspect?.bind(plugin.language);
            if (inspector === undefined) throw new Error("This block runs only when language.inspect exists.");
            return inspector({ text }, catalog);
          }

          it("givenGarbage_whenInspecting_thenResolvesWithEditsInsideTheText", async () => {
            await withCompletion(async (_language, catalog) => {
              for (const text of INSPECTION_GARBAGE) {
                for (const problem of await inspect(text, catalog)) {
                  for (const edit of problem.fixes.flatMap((fix) => fix.edits)) {
                    expect(0 <= edit.from && edit.from <= edit.to && edit.to <= text.length).toBe(true);
                  }
                }
              }
            });
          });

          it("givenFixtureQuery_whenInspecting_thenNothingUnresolved", async () => {
            await withCompletion(async (_language, catalog) => {
              const text = "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = 1";
              expect((await inspect(text, catalog)).map((problem) => problem.message)).toEqual([]);
            });
          });

          it("givenMisspelledTable_whenInspecting_thenUnresolvedWithFixToFixtureTable", async () => {
            await withCompletion(async (_language, catalog) => {
              const text = "SELECT * FROM ordrs WHERE id = 1";
              const problem = (await inspect(text, catalog)).find((found) => found.inspection === "SqlResolve");
              expect(text.slice(problem?.from, problem?.to)).toBe("ordrs");
              const edit = problem?.fixes[0]?.edits[0];
              expect(edit?.insert.toLowerCase()).toBe("orders");
            });
          });
        });
      },
    );

    describe.runIf(plugin.capabilities.includes("ddl"))("ddl", () => {
      function catalogFixture(): NonNullable<ContractFixture["catalog"]> {
        if (fixture.catalog === undefined) throw new Error("A plugin that declares ddl needs fixture.catalog.");
        return fixture.catalog;
      }

      async function definitionOf(name: string, path = catalogFixture().path): Promise<string> {
        let definition = "";
        await withSession(plugin, fixture, async (session) => {
          const read = session.introspector?.definition?.bind(session.introspector);
          if (read === undefined) throw new Error("A ddl session needs introspector.definition.");
          definition = await read(path, fold(name));
        });
        return definition;
      }

      it("givenTable_whenReadingDefinition_thenIncludesColumnsKeysAndCheck", async () => {
        const definition = await definitionOf("orders");
        for (const column of ["id", "customer_id", "total", "placed_at"]) expect(definition).toContain(fold(column));
        expect(definition).toMatch(/PRIMARY KEY/i);
        expect(definition).toContain(catalogFixture().ordersCheck);
        expect(definition).toMatch(/CHECK/i);
        expect(definition).toContain(fold(ORDERS_INDEX));
        expect(definition.trimEnd().endsWith(";")).toBe(true);
      });

      it("givenTableWithForeignKey_whenReadingDefinition_thenNamesTarget", async () => {
        expect(await definitionOf("orders")).toMatch(/REFERENCES\s+\S*customers\S*\s*\(\S*id\S*\)/i);
      });

      it("givenView_whenReadingDefinition_thenIncludesItsQuery", async () => {
        const definition = await definitionOf("customer_totals");
        expect(definition).toMatch(/CREATE\b[\s\S]*\bVIEW\b/i);
        expect(definition).toMatch(/coalesce/i);
        expect(definition).toMatch(/customers/);
      });

      it("givenCustomers_whenReadingDefinition_thenIncludesTheTableComment", async () => {
        const comment = catalogFixture().customersComment;
        const definition = await definitionOf("customers");
        if (comment !== null) expect(definition).toContain(comment);
        expect(definition).toContain(fold("email"));
      });

      it("givenUnknownRelation_whenReadingDefinition_thenDefinitionNotFound", async () => {
        await withSession(plugin, fixture, async (session) => {
          const pending = session.introspector?.definition?.(catalogFixture().path, MISSING_RELATION);
          const failure: unknown = await pending?.catch((error: unknown) => error);
          expect(isPluginError(failure) && failure.code).toBe("definitionNotFound");
          expect(failure instanceof Error && failure.message).toContain(MISSING_RELATION);
        });
      });

      it("givenDefinitionNotFoundError_whenConstructed_thenNamesPathAndRelation", () => {
        const error = new DefinitionNotFoundError(catalogFixture().path, MISSING_RELATION);
        expect(isPluginError(error)).toBe(true);
        expect(error.message).toContain(catalogFixture().path.join("."));
      });
    });

    describe.runIf(plugin.capabilities.includes("sql") && plugin.capabilities.includes("schemaTree"))(
      "generate",
      () => {
        async function withGenerator(
          use: (session: Session, generated: (statement: GeneratedStatement, name: string) => string) => Promise<void>,
        ): Promise<void> {
          const language = plugin.language;
          if (language === undefined || fixture.catalog === undefined) {
            throw new Error("A plugin that declares sql and schemaTree needs a language and fixture.catalog.");
          }
          const path = fixture.catalog.path;
          await withSession(plugin, fixture, async (session) => {
            const introspector = session.introspector;
            if (introspector === undefined) throw new Error("A schemaTree session needs an introspector.");
            const catalog = await introspector.describe(path);
            await use(session, (statement, name) => {
              const relation = catalog.relations.find((candidate) => candidate.name === fold(name));
              if (relation === undefined) throw new Error(`The fixture namespace has no relation ${name}.`);
              const sql = language.generate(statement, relation, introspector.qualifiedName(path, fold(name)));
              const spans = language.split(sql);
              expect(spans).toHaveLength(1);
              return spans[0]?.sql ?? "";
            });
          });
        }

        it("givenGeneratedSelect_whenExecuted_thenReturnsTheTablesColumns", async () => {
          await withGenerator(async (session, generated) => {
            const result = await session.execute(generated("select", LINE_ITEMS_TABLE));
            await collect(result.rows);
            expect(result.columns.map((column) => column.name)).toEqual(["id", "sku"].map(fold));
          });
        });

        it("givenGeneratedUpdate_whenExecuted_thenAffectsNoRows", async () => {
          await withGenerator(async (session, generated) => {
            const sql = generated("update", "orders");
            const result = await session.execute(sql);
            await collect(result.rows);
            expect(result.rowsAffected).toBe(0);
          });
        });

        it.runIf(plugin.capabilities.includes("transactions"))(
          "givenGeneratedInsert_whenExecutedInTransaction_thenInsertsOneRow",
          async () => {
            await withGenerator(async (session, generated) => {
              const transactions = session.transactions;
              if (transactions === undefined) throw new Error("A transactions session needs transactions.");
              await transactions.setMode("manual");
              try {
                const result = await session.execute(generated("insert", EDIT_PROBE_TABLE));
                await collect(result.rows);
                expect(result.rowsAffected).toBe(1);
              } finally {
                await transactions.rollback();
                await transactions.setMode("auto");
              }
            });
          },
        );

        it("givenGeneratedDrop_whenExecuted_thenRelationGone", async () => {
          await withSession(plugin, fixture, async (session) => {
            await collect((await session.execute(`CREATE TABLE ${DROP_PROBE_TABLE} (id INTEGER)`)).rows);
          });
          try {
            await withGenerator(async (session, generated) => {
              await collect((await session.execute(generated("drop", DROP_PROBE_TABLE))).rows);
              expect(await rejectionCode(session.execute(`SELECT * FROM ${DROP_PROBE_TABLE}`))).toBe("statementFailed");
            });
          } finally {
            await withSession(plugin, fixture, async (session) => {
              await collect((await session.execute(dropIfExists(DROP_PROBE_TABLE))).rows);
            });
          }
        });
      },
    );

    describe.runIf(plugin.capabilities.includes("explain"))("explain", () => {
      function explainable(): NonNullable<SqlLanguage["explainable"]> {
        const language = plugin.language;
        if (language?.explainable === undefined) {
          throw new Error("A plugin that declares explain needs language.explainable.");
        }
        return (sql, options) => language.explainable?.(sql, options) ?? { ok: false, reason: "" };
      }

      async function explained(session: Session, sql: string, analyze: boolean): Promise<ExplainedPlan> {
        if (session.explain === undefined) throw new Error("An explain session needs explain.");
        return session.explain(sql, { analyze });
      }

      async function ordersRows(session: Session): Promise<number> {
        return (await collect((await session.execute("SELECT id FROM orders")).rows)).length;
      }

      it("givenSelect_whenExplained_thenTreeWithAnOperation", async () => {
        await withSession(plugin, fixture, async (session) => {
          const plan = await explained(session, dialectSql.explainJoin, false);
          expect(plan.analyzed).toBe(false);
          expect(plan.statement).toMatch(dialectSql.explainStatement);
          expect(plan.statement).toContain(dialectSql.explainJoin);
          expect(plan.raw).toMatch(/\S/);
          const nodes = planNodes(plan.roots);
          expect(nodes.length).toBeGreaterThan(1);
          for (const node of nodes) {
            expect(node.operation).toMatch(/\S/);
            expect([node.actualRows, node.actualTimeMs, node.loops]).toEqual([null, null, null]);
          }
          expect(await ordersRows(session)).toBe(ORDERS_ROWS);
        });
      });

      it("givenDeleteWithoutWhere_whenExplained_thenNothingRuns", async () => {
        await withSession(plugin, fixture, async (session) => {
          const plan = await explained(session, EXPLAIN_DELETE_ALL, false);
          expect(plan.roots.length).toBeGreaterThan(0);
          expect(await ordersRows(session)).toBe(ORDERS_ROWS);
        });
      });

      it("givenDdl_whenExplainable_thenRefusedWithReason", async () => {
        const verdict = explainable()("CREATE TABLE t (id INTEGER)", { analyze: false });
        expect(verdict.ok).toBe(false);
        expect(verdict.ok ? "" : verdict.reason).toMatch(/\S/);
        await withSession(plugin, fixture, async (session) => {
          expect(await rejectionCode(explained(session, "CREATE TABLE t (id INTEGER)", false))).toBe(
            "explainUnsupported",
          );
          expect(await ordersRows(session)).toBe(ORDERS_ROWS);
        });
      });

      it("givenTwoStatements_whenExplainable_thenRefused", () => {
        expect(explainable()("SELECT 1; SELECT 2", { analyze: false }).ok).toBe(false);
        expect(explainable()("  -- nothing\n", { analyze: false }).ok).toBe(false);
      });

      it("givenExplainStatement_whenExplainable_thenRefused", () => {
        expect(explainable()(`EXPLAIN ${dialectSql.explainJoin}`, { analyze: false }).ok).toBe(false);
      });

      it("givenReadAndWrite_whenExplainable_thenWritesOnlyForTheWrite", () => {
        expect(explainable()(dialectSql.explainJoin, { analyze: false })).toEqual({ ok: true, writes: false });
        expect(explainable()(EXPLAIN_UPDATE, { analyze: false })).toEqual({ ok: true, writes: true });
      });

      it.runIf(!plugin.capabilities.includes("explainAnalyze"))(
        "givenNoExplainAnalyze_whenAnalyseExplainable_thenRefused",
        () => {
          expect(explainable()(dialectSql.explainJoin, { analyze: true }).ok).toBe(false);
        },
      );
    });

    describe.runIf(plugin.capabilities.includes("explainAnalyze"))("explainAnalyze", () => {
      async function analysed(session: Session, sql: string): Promise<ExplainedPlan> {
        if (session.explain === undefined) throw new Error("An explain session needs explain.");
        return session.explain(sql, { analyze: true });
      }

      it("givenSelect_whenAnalysed_thenActualRowsPresent", async () => {
        await withSession(plugin, fixture, async (session) => {
          const plan = await analysed(session, dialectSql.explainJoin);
          expect(plan.analyzed).toBe(true);
          expect(planNodes(plan.roots).some((node) => node.actualRows !== null && node.loops !== null)).toBe(true);
        });
      });

      it.runIf(
        plugin.capabilities.includes("transactions") &&
          plugin.language?.explainable?.(ANALYSED_UPDATE, { analyze: true }).ok === true,
      )("givenUpdateInManualTransaction_whenAnalysed_thenRolledBackLeavesRows", async () => {
        await withSession(plugin, fixture, async (session) => {
          const transactions = session.transactions;
          if (transactions === undefined) throw new Error("A transactions session needs transactions.");
          const total = async (): Promise<Row[]> => collect((await session.execute(ANALYSED_TOTAL)).rows);
          const before = await total();
          await transactions.setMode("manual");
          try {
            const plan = await analysed(session, ANALYSED_UPDATE);
            expect(plan.analyzed).toBe(true);
            expect(transactions.open).toBe(true);
            expect(await total()).not.toEqual(before);
          } finally {
            await transactions.rollback();
            await transactions.setMode("auto");
          }
          expect(await total()).toEqual(before);
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("serverMessages"))("serverMessages", () => {
      function messageCase(): NonNullable<NonNullable<ContractFixture["statements"]>["message"]> {
        const message = fixture.statements?.message;
        if (message === undefined) throw new Error("A serverMessages fixture needs statements.message.");
        return message;
      }

      it("givenStatementWithWarnings_whenExecuted_thenMessagesReturned", async () => {
        await withSession(plugin, fixture, async (session) => {
          const { sql, level, code } = messageCase();
          const result = await session.execute(sql);
          await collect(result.rows);
          expect(result.messages?.[0]).toMatchObject({ level, code });
          expect(result.messages?.[0]?.text).not.toBe("");
        });
      });

      it("givenQuietStatement_whenExecuted_thenNoMessages", async () => {
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(dialectSql.select("1 AS n"));
          await collect(result.rows);
          expect(result.messages).toEqual([]);
        });
      });

      it("givenStatementWithWarnings_whenNextStatementRuns_thenItsMessagesAreItsOwn", async () => {
        await withSession(plugin, fixture, async (session) => {
          await collect((await session.execute(messageCase().sql)).rows);
          const quiet = await session.execute(dialectSql.select("1 AS n"));
          await collect(quiet.rows);
          expect(quiet.messages).toEqual([]);
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("currentNamespace"))("currentNamespace", () => {
      function namespaceSwitch(): NonNullable<ContractFixture["namespaceSwitch"]> {
        if (fixture.namespaceSwitch === undefined) {
          throw new Error("A plugin that declares currentNamespace needs fixture.namespaceSwitch.");
        }
        return fixture.namespaceSwitch;
      }

      async function current(session: Session): Promise<readonly string[] | null> {
        if (session.currentNamespace === undefined) throw new Error("A currentNamespace session needs it.");
        return session.currentNamespace();
      }

      it("givenFreshSession_whenCurrentNamespaceRead_thenIsCatalogPath", async () => {
        const path = fixture.catalog?.path;
        if (path === undefined) throw new Error("A plugin that declares currentNamespace needs fixture.catalog.");
        await withSession(plugin, fixture, async (session) => {
          expect(await current(session)).toEqual(path);
        });
      });

      it("givenSwitchStatement_whenClassified_thenSetsNamespace", () => {
        expect(plugin.language?.classify(namespaceSwitch().statement).setsNamespace).toBe(true);
        expect(plugin.language?.classify("SELECT 1").setsNamespace ?? false).toBe(false);
      });

      it("givenSwitchStatement_whenExecuted_thenCurrentNamespaceIsTarget", async () => {
        const { statement, path } = namespaceSwitch();
        await withSession(plugin, fixture, async (session) => {
          await collect((await session.execute(statement)).rows);
          expect(await current(session)).toEqual(path);
          expect(await collect((await session.execute(selectOne)).rows)).toEqual([[1]]);
        });
      });

      function switcher(): NonNullable<SqlLanguage["namespaceSwitch"]> {
        const found = plugin.language?.namespaceSwitch;
        if (found === undefined)
          throw new Error("A plugin that declares currentNamespace needs language.namespaceSwitch.");
        return found;
      }

      it("givenSwitchStatementForTarget_whenExecuted_thenCurrentNamespaceIsTarget", async () => {
        const { path } = namespaceSwitch();
        const written = switcher();
        await withSession(plugin, fixture, async (session) => {
          // A database switch reaches [database, default schema] on SQL Server, so the target may be a prefix.
          const listed = (await session.introspector?.namespaces()) ?? [];
          const target = listed
            .filter((namespace) => namespace.path.every((part, index) => part === path[index]))
            .filter((namespace) => switchableTo(written.targets, namespace))
            .sort((a, b) => b.path.length - a.path.length)[0];
          expect(target).toBeDefined();
          const sql = written.statement(target?.path ?? path);
          expect(plugin.language?.classify(sql).setsNamespace).toBe(true);
          await collect((await session.execute(sql)).rows);
          expect(await current(session)).toEqual(path);
        });
      });

      it("givenEmptyPath_whenSwitchStatementWritten_thenThrows", () => {
        let thrown: unknown = null;
        try {
          switcher().statement([]);
        } catch (error) {
          thrown = error;
        }
        expect(isPluginError(thrown) ? thrown.code : thrown).toBe("statementFailed");
      });

      it.runIf(fixture.namespaceSwitch?.missing !== undefined)(
        "givenMissingTarget_whenExecuted_thenRejectsAndNamespaceUnchanged",
        async () => {
          const { missing } = namespaceSwitch();
          if (missing === undefined) return;
          await withSession(plugin, fixture, async (session) => {
            const before = await current(session);
            expect(await rejectionCode(session.execute(missing))).toBe("statementFailed");
            expect(await current(session)).toEqual(before);
          });
        },
      );
    });

    describe.runIf(plugin.capabilities.includes("commands"))("commands", () => {
      function language(): NonNullable<DatasourcePlugin["commandLanguage"]> {
        if (plugin.commandLanguage === undefined)
          throw new Error("A plugin that declares commands has no commandLanguage.");
        return plugin.commandLanguage;
      }

      async function rowsOf(command: string, session: Session): Promise<{ columns: string[]; rows: Row[] }> {
        const result = await session.execute(command);
        return { columns: result.columns.map((column) => column.name), rows: await collect(result.rows) };
      }

      it("givenCommands_whenSplit_thenOneSpanPerLineSkippingComments", () => {
        for (const script of commandsOf(fixture).scripts) {
          const spans = language().split(script.text);
          expect(spans.map((span) => span.sql)).toEqual(script.statements);
          for (const span of spans) expect(script.text.slice(span.from, span.to)).toBe(span.sql);
        }
      });

      it("givenScalarCommand_whenExecute_thenReplyAndNoColumns", async () => {
        const { command, text } = commandsOf(fixture).scalar;
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(command);
          expect(result.reply?.text).toBe(text);
          expect(result.columns).toEqual([]);
          expect(await collect(result.rows)).toEqual([]);
        });
      });

      it("givenArrayCommand_whenExecute_thenIndexValueRows", async () => {
        const { command, columns, rows } = commandsOf(fixture).array;
        await withSession(plugin, fixture, async (session) => {
          expect(await rowsOf(command, session)).toEqual({ columns, rows });
        });
      });

      it("givenMapReply_whenExecute_thenKeyValueRows", async () => {
        const { command, columns, rows } = commandsOf(fixture).map;
        await withSession(plugin, fixture, async (session) => {
          expect(await rowsOf(command, session)).toEqual({ columns, rows });
        });
      });

      it("givenBinaryValue_whenExecute_thenBytesValue", async () => {
        const { command, hex } = commandsOf(fixture).binary;
        await withSession(plugin, fixture, async (session) => {
          const result = await session.execute(command, [], { fullBytes: true });
          expect(result.reply?.value).toEqual({
            kind: "bytes",
            preview: hex,
            length: hex.length / HEX_DIGITS_PER_BYTE,
          });
        });
      });

      it("givenReadOnly_whenWriteCommand_thenStatementFailedNamingIt", async () => {
        const { command, name } = commandsOf(fixture).write;
        await withSession(
          plugin,
          fixture,
          async (session) => {
            const failure = await session.execute(command).then(
              () => undefined,
              (error: unknown) => error,
            );
            expect(isPluginError(failure) ? failure.code : failure).toBe("statementFailed");
            expect(failure instanceof Error ? failure.message : "").toContain(name);
          },
          READ_ONLY,
        );
      });

      it("givenFlushdb_whenClassify_thenDestructiveConfirmByName", () => {
        const classified = language().classify(commandsOf(fixture).confirmByName);
        expect(classified.destructive).not.toBeNull();
        expect(classified.confirmByName).toBe(true);
      });

      it("givenKeysPattern_whenClassify_thenCostlyWithScanFix", async () => {
        const { command, fixed } = commandsOf(fixture).costly;
        expect(language().classify(command).costly).toMatch(/\S/);
        const problems = (await language().inspect?.({ text: command })) ?? [];
        const fix = problems[0]?.fixes[0];
        expect(fix).toBeDefined();
        let text = command;
        for (const edit of [...(fix?.edits ?? [])].sort((a, b) => b.from - a.from)) {
          text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
        }
        expect(text).toBe(fixed);
      });

      it("givenCommand_whenComplete_thenNeverRejects", async () => {
        await withSession(plugin, fixture, async (session) => {
          for (const text of ["", "h", "HGET ", '"unterminated', "# only a comment"]) {
            const result = await language().complete({ text, offset: text.length }, session);
            expect(result.from).toBeLessThanOrEqual(text.length);
          }
          const offline = await language().complete({ text: "h", offset: 1 }, null);
          expect(offline.to).toBe(1);
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("keyValue"))("keyValue", () => {
      function keyspaceFixture(): KeyspaceFixture {
        if (fixture.keyspace === undefined) throw new Error("keyValue needs fixture.keyspace");
        return fixture.keyspace;
      }

      function keyspaceOf(session: Session): Keyspace {
        if (session.keyspace === undefined) throw new Error("keyValue needs session.keyspace");
        return session.keyspace;
      }

      /** Every key of one pass, and how many batches it took. */
      async function scanAll(
        keyspace: Keyspace,
        request: { match: string; type?: KeyType; count?: number },
      ): Promise<{ keys: KeyName[]; batches: number }> {
        const keys: KeyName[] = [];
        let cursor: string | null = null;
        let batches = 0;
        do {
          const scan = await keyspace.scan({
            database: keyspaceFixture().database,
            cursor,
            match: request.match,
            type: request.type ?? null,
            ...(request.count === undefined ? {} : { count: request.count }),
          });
          keys.push(...scan.keys);
          cursor = scan.cursor;
          batches += 1;
        } while (cursor !== null && batches < MAX_SCAN_BATCHES);
        expect(cursor).toBeNull();
        return { keys, batches };
      }

      it.runIf(fixture.keyspace?.sources !== undefined)(
        "givenSingleKeyRead_whenExecute_thenReplyNamesItsSourceKey",
        async () => {
          await withSession(plugin, fixture, async (session) => {
            for (const expected of keyspaceFixture().sources ?? []) {
              const result = await session.execute(expected.command);
              await collect(result.rows);
              expect(result.source ?? null, expected.command).toEqual(expected.source);
              if (expected.read !== undefined)
                expect(result.reply?.read ?? false, expected.command).toBe(expected.read);
            }
          });
        },
      );

      it("givenKeyspace_whenDatabases_thenFixtureDatabaseCountedAndOneCurrent", async () => {
        await withSession(plugin, fixture, async (session) => {
          const databases = await keyspaceOf(session).databases();
          const own = databases.find((database) => database.index === keyspaceFixture().database);
          expect(own?.keys).toBeGreaterThanOrEqual(keyspaceFixture().scan.count);
          expect(databases.filter((database) => database.current)).toHaveLength(1);
          expect(keyspaceOf(session).delimiter).not.toBe("");
        });
      });

      it("givenKeyspace_whenScanToEnd_thenEveryFixtureKeyOnceAndCursorNull", async () => {
        await withSession(plugin, fixture, async (session) => {
          const { match, count, batch } = keyspaceFixture().scan;
          const { keys, batches } = await scanAll(keyspaceOf(session), { match, count: batch });
          const names = keys.map((key) => key.text);
          expect(new Set(names).size).toBe(count);
          expect(names).toHaveLength(count);
          expect(batches).toBeGreaterThan(1);
        });
      });

      it("givenMatchAndType_whenScan_thenOnlyMatchingKeys", async () => {
        await withSession(plugin, fixture, async (session) => {
          const { match, type, keys } = keyspaceFixture().typed;
          const found = await scanAll(keyspaceOf(session), { match, type });
          expect(found.keys.map((key) => key.text).sort()).toEqual([...keys].sort());
        });
      });

      it("givenKeys_whenDescribe_thenTypeExpiryAndMissingInOrder", async () => {
        await withSession(plugin, fixture, async (session) => {
          const { typed, expiring, database } = keyspaceFixture();
          const [first = ""] = typed.keys;
          const names = [first, expiring, "table-craft:contract:missing"];
          const infos = await keyspaceOf(session).describe(
            database,
            names.map((text) => ({ text, hex: null })),
          );
          expect(infos.map((info) => info.key.text)).toEqual(names);
          expect(infos[0]).toMatchObject({ type: typed.type, ttlMs: null });
          expect(infos[1]?.ttlMs).toBeGreaterThan(0);
          expect(infos[2]).toMatchObject({ type: null, typeName: null, ttlMs: null });
        });
      });

      it("givenBinaryKeyName_whenScanAndRead_thenHexRoundTrips", async () => {
        await withSession(plugin, fixture, async (session) => {
          const { binary, database } = keyspaceFixture();
          const found = await scanAll(keyspaceOf(session), { match: binary.match });
          const key = found.keys.find((candidate) => candidate.hex === binary.hex);
          expect(key?.text).toMatch(/\\x[0-9a-f]{2}/);
          if (key === undefined) return;
          const [info] = await keyspaceOf(session).describe(database, [key]);
          expect(info?.type).toBe(binary.type);
          const contents = await keyspaceOf(session).read(database, key, { window: READ_WINDOW });
          expect(contents.details.key).toEqual(key);
          expect(contents.value).toBe(binary.value);
        });
      });

      /** The key's rows, each cut to its first `width` cells. */
      async function readRows(session: Session, key: string, width: number) {
        const contents = await keyspaceOf(session).read(
          keyspaceFixture().database,
          { text: key, hex: null },
          { window: READ_WINDOW },
        );
        if (contents.result === null) throw new Error(`${key} read no rows`);
        const rows = await collect(contents.result.rows);
        return {
          contents,
          columns: contents.result.columns.map((column) => column.name),
          rows: rows.map((row) => row.slice(0, width)),
        };
      }

      it("givenHash_whenRead_thenFieldValueRows", async () => {
        await withSession(plugin, fixture, async (session) => {
          const { hash } = keyspaceFixture();
          const read = await readRows(session, hash.key, 2);
          expect(read.columns.slice(0, 2)).toEqual(["field", "value"]);
          const sorted = (rows: readonly Row[]) =>
            [...rows].sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
          expect(sorted(read.rows)).toEqual(sorted(hash.rows));
          expect(read.contents.details).toMatchObject({ type: "hash", length: hash.rows.length });
        });
      });

      it("givenZset_whenRead_thenMemberScoreRowsInRankOrder", async () => {
        await withSession(plugin, fixture, async (session) => {
          const { zset } = keyspaceFixture();
          const read = await readRows(session, zset.key, 3);
          expect(read.columns).toEqual(["#", "member", "score"]);
          expect(read.rows.map((row) => row.slice(1))).toEqual(zset.rows);
          expect(read.rows.map((row) => row[0])).toEqual(zset.rows.map((_, index) => index));
        });
      });

      it("givenStream_whenRead_thenIdAndFieldColumns", async () => {
        await withSession(plugin, fixture, async (session) => {
          const { stream } = keyspaceFixture();
          const read = await readRows(session, stream.key, stream.columns.length);
          expect(read.columns).toEqual(stream.columns);
          expect(read.rows).toEqual(stream.rows);
        });
      });

      it("givenMissingKey_whenRead_thenNoTypeAndNoContents", async () => {
        await withSession(plugin, fixture, async (session) => {
          const contents = await keyspaceOf(session).read(
            keyspaceFixture().database,
            { text: "table-craft:contract:missing", hex: null },
            { window: READ_WINDOW },
          );
          expect(contents).toMatchObject({ details: { type: null }, result: null, value: null });
        });
      });

      /** Runs `use` with the scratch key removed before and after. */
      async function withScratchKey(use: (keyspace: Keyspace, apply: ApplyTo) => Promise<void>) {
        const { database, edit } = keyspaceFixture();
        const key = { text: edit.key, hex: null };
        await withSession(plugin, fixture, async (session) => {
          const keyspace = keyspaceOf(session);
          await keyspace.remove(database, [key]);
          try {
            await use(keyspace, {
              set: (value, original, guard) =>
                keyspace.apply(database, key, [edit.change(value, original)], { type: edit.type, guard }),
              value: async () => edit.valueOf(await keyspace.read(database, key, { window: READ_WINDOW })),
            });
          } finally {
            await keyspace.remove(database, [key]);
          }
        });
      }

      it("givenChange_whenApply_thenValueWritten", async () => {
        await withScratchKey(async (keyspace, scratch) => {
          const { edit } = keyspaceFixture();
          const applied = await scratch.set("one", null, true);
          expect(await scratch.value()).toBe("one");
          const options = { type: edit.type, guard: true };
          expect(applied.commands).toEqual(
            keyspace.preview({ text: edit.key, hex: null }, [edit.change("one", null)], options),
          );
        });
      });

      it("givenChangedSinceRead_whenApplyGuarded_thenConflictAndNothingWritten", async () => {
        await withScratchKey(async (_keyspace, scratch) => {
          await scratch.set("one", null, true);
          await scratch.set("two", "one", false);
          expect(await rejectionCode(scratch.set("three", "one", true))).toBe("conflict");
          expect(await scratch.value()).toBe("two");
        });
      });

      it("givenChangedSinceRead_whenApplyUnguarded_thenWritten", async () => {
        await withScratchKey(async (_keyspace, scratch) => {
          await scratch.set("one", null, true);
          await scratch.set("two", "one", false);
          await scratch.set("three", "one", false);
          expect(await scratch.value()).toBe("three");
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("cancel"))("cancel", () => {
      function sleepSql(): string {
        const sleep = fixture.statements?.sleep;
        if (sleep === undefined) throw new Error("A plugin that declares cancel needs fixture.statements.sleep.");
        return sleep(SLEEP_SECONDS);
      }

      async function runAndCancel(session: Session): Promise<string> {
        const started = Date.now();
        const running = rejectionCode(session.execute(sleepSql()));
        await delay(CANCEL_DELAY_MS);
        await session.cancel?.();
        const code = await running;
        expect(Date.now() - started).toBeLessThan(CANCEL_DEADLINE_MS);
        return code;
      }

      it("givenSession_whenInspected_thenImplementsCancel", async () => {
        await withSession(plugin, fixture, (session) => {
          expect(typeof session.cancel).toBe("function");
          return Promise.resolve();
        });
      });

      it("givenIdleSession_whenCancelled_thenResolvesAndSessionWorks", async () => {
        await withSession(plugin, fixture, async (session) => {
          await session.cancel?.();
          await expectAlive(session);
        });
      });

      it("givenSleepingStatement_whenCancelled_thenExecuteRejectsWithCancelled", async () => {
        await withSession(plugin, fixture, async (session) => {
          expect(await runAndCancel(session)).toBe("cancelled");
        });
      });

      it("givenCancelledStatement_whenNextStatementRun_thenSessionStillWorks", async () => {
        await withSession(plugin, fixture, async (session) => {
          await runAndCancel(session);
          await expectAlive(session);
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("keepAlive"))("keepAlive", () => {
      it("givenKeepAlive_whenConnectedWithDelay_thenPingResolvesAndSessionWorks", async () => {
        await withSession(
          plugin,
          fixture,
          async (session) => {
            await session.ping?.();
            await session.ping?.();
            await expectAlive(session);
          },
          { readOnly: false, keepAliveInitialDelayMs: KEEPALIVE_DELAY_MS },
        );
      });

      it("givenClosedSession_whenPinged_thenRejectsWithConnectionLost", async () => {
        const session = await connect(plugin, fixture.config);
        await session.close();
        expect(await rejectionCode(session.ping?.() ?? Promise.resolve())).toBe("connectionLost");
      });
    });

    describe.runIf(plugin.capabilities.includes("serverInfo"))("serverInfo", () => {
      it("givenEveryNode_whenServerInfo_thenTitledSectionsWithEntries", async () => {
        await withSession(plugin, fixture, async (session) => {
          const nodes = (await session.nodes?.()) ?? [];
          for (const node of [null, ...nodes.map((listed) => listed.id)]) {
            const info = await session.serverInfo?.(node);
            expect(info?.sections.length).toBeGreaterThan(0);
            for (const section of info?.sections ?? []) expect(section.title).not.toBe("");
            expect(info?.sections.some((section) => section.entries.length > 0)).toBe(true);
            if (node !== null) expect(info?.node).toBe(node);
          }
        });
      });

      it("givenSlowLog_whenRead_thenAtMostLimitNewestFirst", async () => {
        await withSession(plugin, fixture, async (session) => {
          const entries = (await session.slowLog?.(null, SLOW_LOG_LIMIT)) ?? [];
          expect(entries.length).toBeLessThanOrEqual(SLOW_LOG_LIMIT);
          const times = entries.map((entry) => entry.at);
          expect(times).toEqual([...times].sort().reverse());
        });
      });
    });

    describe.runIf(plugin.capabilities.includes("sessions"))("sessions", () => {
      function sessionsFixture(): NonNullable<ContractFixture["sessions"]> {
        if (fixture.sessions === undefined) throw new Error("A plugin that declares sessions needs fixture.sessions.");
        return fixture.sessions;
      }

      function sleepSql(): string {
        const sleep = fixture.statements?.sleep;
        if (sleep === undefined) throw new Error("A plugin that declares sessions needs fixture.statements.sleep.");
        return sleep(SLEEP_SECONDS);
      }

      async function withMonitor(work: (monitor: SessionMonitor) => Promise<void>): Promise<void> {
        const session = await connect(plugin, sessionsFixture().monitorConfig);
        try {
          if (session.sessions === undefined) throw new Error("A session of a sessions plugin has no monitor.");
          await work(session.sessions);
        } finally {
          await session.close();
        }
      }

      function idOf(session: Session): string {
        if (session.serverSessionId === undefined)
          throw new Error("A session of a sessions plugin has no serverSessionId.");
        return session.serverSessionId;
      }

      async function listedUntil(
        monitor: SessionMonitor,
        id: string,
        ready: (row: ServerSession | undefined) => boolean,
      ): Promise<ServerSession | undefined> {
        const deadline = Date.now() + LISTING_DEADLINE_MS;
        for (;;) {
          const row = (await monitor.list()).sessions.find((listed) => listed.id === id);
          if (ready(row)) return row;
          if (Date.now() > deadline)
            throw new Error(`Session ${id} never got there; last seen ${JSON.stringify(row)}.`);
          await delay(LISTING_POLL_MS);
        }
      }

      async function present(monitor: SessionMonitor, id: string, ready = (_: ServerSession) => true) {
        const row = await listedUntil(monitor, id, (listed) => listed !== undefined && ready(listed));
        if (row === undefined) throw new Error(`Session ${id} is not listed.`);
        return row;
      }

      async function withSleeper(work: (sleeper: Session, running: Promise<string>) => Promise<void>): Promise<void> {
        const sleeper = await connect(plugin, fixture.config);
        const running = rejectionCode(sleeper.execute(sleepSql()).then((result) => collect(result.rows)));
        try {
          await work(sleeper, running);
        } finally {
          await sleeper.cancel?.();
          await running;
          await sleeper.close();
        }
      }

      it("givenOwnSession_whenList_thenServerSessionIdListed", async () => {
        await withSession(plugin, fixture, async (session) => {
          await withMonitor(async (monitor) => {
            const row = await present(monitor, idOf(session));
            expect(row.system).toBe(false);
            expect(row.terminate).not.toBeNull();
          });
        });
      });

      it("givenSleepingSession_whenList_thenActiveWithQueryText", async () => {
        await withMonitor(async (monitor) => {
          await withSleeper(async (sleeper) => {
            const row = await present(monitor, idOf(sleeper), (listed) => listed.state === "active");
            expect(row.query).toContain(sessionsFixture().sleepQuery ?? sleepSql());
            expect(row.queryMs).not.toBeNull();
          });
        });
      });

      it.runIf(fixture.sessions?.cancels === false)("givenNoCancel_whenCancelSession_thenRejects", async () => {
        await withMonitor(async (monitor) => {
          await withSleeper(async (sleeper) => {
            const row = await present(monitor, idOf(sleeper), (listed) => listed.state === "active");
            expect(row.cancel).toBeNull();
            expect(await rejectionCode(monitor.cancelSession({ id: row.id, instance: row.instance }))).toBe(
              "statementFailed",
            );
          });
        });
      });

      it.runIf(fixture.sessions?.cancels !== false)("givenActiveQuery_whenCancel_thenQueryCancelled", async () => {
        await withMonitor(async (monitor) => {
          await withSleeper(async (sleeper, running) => {
            const row = await present(monitor, idOf(sleeper), (listed) => listed.state === "active");
            expect(row.cancel).not.toBeNull();
            const started = Date.now();
            await monitor.cancelSession({ id: row.id, instance: row.instance });
            // MySQL's SLEEP answers 1 when killed rather than failing; either way it stops early.
            expect(["cancelled", "resolved"]).toContain(await running);
            expect(Date.now() - started).toBeLessThan(CANCEL_DEADLINE_MS);
            await expectAlive(sleeper);
          });
        });
      });

      it("givenSession_whenTerminate_thenGone", async () => {
        const victim = await connect(plugin, fixture.config);
        try {
          await withMonitor(async (monitor) => {
            const row = await present(monitor, idOf(victim));
            await monitor.terminateSession({ id: row.id, instance: row.instance });
            await listedUntil(monitor, row.id, (listed) => listed === undefined);
          });
        } finally {
          await victim.close();
        }
      });

      it("givenMissingSession_whenTerminate_thenRejects", async () => {
        const missingId = sessionsFixture().missingId;
        if (missingId !== undefined) {
          await withMonitor(async (monitor) => {
            const listed = await monitor.list();
            expect(listed.sessions.map((session) => session.id)).not.toContain(missingId);
            expect(await rejectionCode(monitor.terminateSession({ id: missingId, instance: null }))).toBe(
              "statementFailed",
            );
          });
          return;
        }
        const victim = await connect(plugin, fixture.config);
        const id = idOf(victim);
        await victim.close();
        await withMonitor(async (monitor) => {
          await listedUntil(monitor, id, (listed) => listed === undefined);
          expect(await rejectionCode(monitor.terminateSession({ id, instance: null }))).toBe("statementFailed");
        });
      });

      it.runIf(plugin.capabilities.includes("transactions"))("givenLockWait_whenList_thenBlockedByFilled", async () => {
        const write = fixture.statements?.write;
        if (write === undefined) throw new Error("A plugin that declares sessions needs fixture.statements.write.");
        const holder = await connect(plugin, fixture.config);
        const waiter = await connect(plugin, fixture.config);
        let waiting: Promise<unknown> = Promise.resolve();
        try {
          await holder.transactions?.setMode("manual");
          await waiter.transactions?.setMode("manual");
          await collect((await holder.execute(write)).rows);
          waiting = waiter.execute(write).then((result) => collect(result.rows));
          await withMonitor(async (monitor) => {
            const row = await present(monitor, idOf(waiter), (listed) => listed.state === "blocked");
            expect(row.blockedBy).toContain(idOf(holder));
          });
        } finally {
          await holder.transactions?.rollback();
          await waiting.catch(() => undefined);
          await waiter.transactions?.rollback();
          await holder.close();
          await waiter.close();
        }
      });

      it.runIf(fixture.sessions?.limited !== undefined)(
        "givenNoProcessPrivilege_whenList_thenOwnOnlyWithExplanation",
        async () => {
          const limited = sessionsFixture().limited;
          if (limited === undefined) return;
          const session = await connect(plugin, limited.config);
          try {
            await withMonitor(async (monitor) => {
              const own = await present(monitor, idOf(session));
              const listing = await session.sessions?.list();
              expect(listing?.notes.some((note) => limited.note.test(note))).toBe(true);
              expect(listing?.sessions.map((row) => row.id)).toContain(own.id);
              const monitorIds = (await monitor.list()).sessions.map((row) => row.id);
              const foreign = monitorIds.filter((id) => !listing?.sessions.some((row) => row.id === id));
              expect(foreign.length).toBeGreaterThan(0);
            });
          } finally {
            await session.close();
          }
        },
      );
    });

    describe.runIf(plugin.capabilities.includes("routineCall"))("routineCall", () => {
      function routinesFixture(): NonNullable<ContractFixture["routines"]> {
        if (fixture.routines === undefined)
          throw new Error("A plugin that declares routineCall needs fixture.routines.");
        return fixture.routines;
      }

      function introspectorOf(session: Session): Introspector {
        if (session.introspector === undefined) throw new Error("A routineCall plugin needs an introspector.");
        return session.introspector;
      }

      async function seeded(session: Session): Promise<readonly Routine[]> {
        return (await introspectorOf(session).describe(catalogPathOf(fixture))).routines;
      }

      /** Runs the call as the console does: each statement split, bound with the call's values, in turn. */
      async function call(session: Session, routineCase: RoutineCase): Promise<Row[]> {
        const language = plugin.language;
        const routineCall = language?.routineCall?.bind(language);
        if (language === undefined || routineCall === undefined) {
          throw new Error("A routineCall plugin needs language.routineCall.");
        }
        const routine = (await seeded(session)).find(
          (candidate) =>
            candidate.name === routineCase.name &&
            candidate.kind === routineCase.kind &&
            candidate.signature === routineCase.signature,
        );
        if (routine === undefined) throw new Error(`The fixture routine ${routineCase.name} is not described.`);
        const qualified = introspectorOf(session).qualifiedName(catalogPathOf(fixture), routine.name);
        const { sql, params } = routineCall(routine, qualified, routineCase.args);
        let rows: Row[] = [];
        for (const span of language.split(sql)) {
          const statement = language.bind(span.sql, params);
          rows = await collect((await session.execute(statement.sql, statement.params)).rows);
        }
        return rows;
      }

      it("givenFixtureRoutines_whenDescribe_thenParametersAndModes", async () => {
        await withSession(plugin, fixture, async (session) => {
          expect(await seeded(session)).toEqual(routinesFixture().expected);
        });
      });

      it("givenFunction_whenCall_thenResultReturned", async () => {
        const routineCase = routinesFixture().function;
        await withSession(plugin, fixture, async (session) => {
          expect(await call(session, routineCase)).toEqual(routineCase.rows);
        });
      });

      it("givenNullToggle_whenRun_thenBindsNull", async () => {
        const routineCase = routinesFixture().nullArgument;
        expect(routineCase.args.some((argument) => argument.kind === "value" && argument.value === null)).toBe(true);
        await withSession(plugin, fixture, async (session) => {
          expect(await call(session, routineCase)).toEqual(routineCase.rows);
        });
      });

      it("givenProcedureOut_whenCall_thenOutValueReturned", async () => {
        const routineCase = routinesFixture().procedureOut;
        await withSession(plugin, fixture, async (session) => {
          expect(await call(session, routineCase)).toEqual(routineCase.rows);
        });
      });

      it.runIf(fixture.routines?.defaulted !== undefined)(
        "givenDefaultParameter_whenOmitted_thenUsesDefault",
        async () => {
          const routineCase = routinesFixture().defaulted;
          if (routineCase === undefined) return;
          expect(routineCase.args.some((argument) => argument.kind === "default")).toBe(true);
          await withSession(plugin, fixture, async (session) => {
            expect(await call(session, routineCase)).toEqual(routineCase.rows);
          });
        },
      );

      it("givenDefaultWithoutOne_whenCall_thenStatementFailed", async () => {
        const routineCase = routinesFixture().function;
        const routineCall = plugin.language?.routineCall?.bind(plugin.language);
        await withSession(plugin, fixture, async (session) => {
          const routine = (await seeded(session)).find(
            (candidate) => candidate.name === routineCase.name && candidate.signature === routineCase.signature,
          );
          const required = routine?.parameters.findIndex(
            (parameter) => !parameter.hasDefault && parameter.mode !== "out",
          );
          expect(required).toBeGreaterThanOrEqual(0);
          if (routine === undefined || routineCall === undefined || required === undefined) return;
          const args = routineCase.args.map((argument, index): RoutineArgument =>
            index === required ? { kind: "default" } : argument,
          );
          const attempt = Promise.resolve().then(() => routineCall(routine, routine.name, args));
          expect(await rejectionCode(attempt)).toBe("statementFailed");
        });
      });
    });
  });
}
