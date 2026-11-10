import type { DefinitionReader, Introspector, Routine } from "./catalog.js";
import type { ExplainedPlan, Explainability, ExplainOptions } from "./explain.js";
import type { Keyspace } from "./keyspace.js";
import type {
  AccessManager,
  ClusterMaintenance,
  ClusterMembers,
  CoordinationViewer,
  KeyTransfer,
  KeyWatcher,
  LeaseManager,
} from "./keyAdvanced.js";
import type { ObjectEditor } from "./objects.js";
import type {
  CancelReach,
  Capability,
  CommandLanguage,
  InferredColumn,
  InsertRow,
  InsertTarget,
  NamespaceSwitch,
  NewColumn,
  RoutineArgument,
  RoutineCall,
  SavepointStatements,
  ServerInfo,
  ServerNode,
  ServerTimeout,
  SessionBase,
  SlowCommand,
  SqlLanguage,
  Transactions,
} from "./plugin.js";
import type { ServerSessions } from "./sessions.js";

/** The `cancel` service: stops the running statement (decision 131). */
export interface Canceller {
  /**
   * Interrupts the running statement, which then rejects with `cancelled`, and leaves the session
   * usable; a no-op when nothing runs.
   */
  cancel(): Promise<void>;
  /** How this session's cancel reaches the server, read once at connect. */
  readonly reach: CancelReach;
}

/** The `explain` service of a session (decision 031). */
export interface Explainer {
  /**
   * Checks `sql` with the language's `explainable` and rejects with `explainUnsupported` and its
   * reason when refused; otherwise sends the dialect's EXPLAIN on this session, like `execute`, and
   * reads the whole plan. With `analyze`, which needs `explainAnalyze`, the statement runs, in this
   * session's transaction. `cancel` interrupts it as it does `execute`.
   */
  explain(sql: string, options: ExplainOptions): Promise<ExplainedPlan>;
}

/** The `explain` service of a language (decision 031). */
export interface ExplainCheck {
  /**
   * Whether `sql`, one statement without its delimiter, can be explained (with `analyze`, analysed)
   * in this dialect, and whether it writes. Pure; `sqlExplainable` in `@table-craft/plugin-api/sql`
   * implements it.
   */
  readonly explainable: (sql: string, options: ExplainOptions) => Explainability;
}

/** The `currentNamespace` service of a session (decision 048). */
export interface NamespaceReader {
  /**
   * Asks the server which namespace unqualified names resolve against now, as an introspector
   * namespace path; null when none does. Never opens a transaction, and the host calls it only
   * while nothing runs.
   */
  current(): Promise<readonly string[] | null>;
}

/** The `keepAlive` service (decision 054). */
export interface KeepAlive {
  /**
   * One round trip to the server; rejects with `connectionLost` when the connection is gone. The
   * host calls it only while nothing runs, and bounds how long it waits.
   */
  ping(): Promise<void>;
}

/** The `bulkInsert` service of a session (decision 046). */
export interface BulkInserter {
  /**
   * Writes `rows` into `target` by the dialect's fastest safe path, values never spliced into SQL.
   * Atomic: when the database refuses any row it rejects with `statementFailed`, none of `rows` is
   * kept, and an open transaction stays usable; a lost connection rejects with `connectionFailed`.
   * Text is converted where the column needs it, so what TableCraft's CSV export writes inserts back
   * the same: `0x…` hex into a binary column, `true`/`false` into a boolean stored as a number.
   */
  insertRows(target: InsertTarget, rows: readonly InsertRow[]): Promise<void>;
}

/** The `bulkInsert` service of a language (decision 046); `sqlImporter` implements it. */
export interface ImportDdl {
  /** The column type an import proposes for text that looks like `column`. Every value of the sample inserts into it. */
  importType(column: InferredColumn): string;
  /** The `CREATE TABLE` for a new import target. */
  createTable(qualifiedName: string, columns: readonly NewColumn[]): string;
}

/** The `savepoints` service of a language (decision 155): edits joining an open transaction undo only themselves. */
export interface SavepointWriter {
  /** The statements that set, roll back to and release a savepoint called `name`. `sqlSavepoints` implements it. */
  savepoint(name: string): SavepointStatements;
}

/** Where a `RowLimiter` wrote its limit: the one span the host added to the statement. */
export interface RowLimitRewrite {
  readonly sql: string;
  /** The added text starts at `offset` in `sql` and is `length` characters long; the rest is the statement as given. */
  readonly inserted: { readonly offset: number; readonly length: number };
}

/** The `rowLimit` service of a language (decision 162): the host writes its page size into the SELECT it runs. */
export interface RowLimiter {
  /**
   * `sql` reading at most `rows` rows, by one insertion and nothing else; null when the statement
   * is not a plain read the host may limit, such as one already limited, locking or writing.
   * `rows` is a positive integer. `sqlRowLimiter` implements it.
   */
  limit(sql: string, rows: number): RowLimitRewrite | null;
}

/** The `routineCall` service (decision 090). */
export interface RoutineCaller {
  /**
   * The console text that calls `routine`, named `qualifiedName` by the introspector, and returns
   * its result, OUT values included. `args` has one entry per parameter in order; an `out` entry is
   * ignored. Throws a `PluginError` coded `statementFailed` saying what to change when the arguments
   * do not fit.
   */
  call(routine: Routine, qualifiedName: string, args: readonly RoutineArgument[]): RoutineCall;
}

/** The `nodes` service (decision 114). */
export interface NodeList {
  /** Every server of the datasource, primaries first; one entry for a single server. */
  list(): Promise<readonly ServerNode[]>;
}

/** The `serverInfo` service (decision 114). */
export interface ServerInfoReader {
  /** What `node` (a `ServerNode.id`, or null for the one server or a primary of the plugin's choice) reports about itself. */
  info(node: string | null): Promise<ServerInfo>;
  /** The newest `limit` slow commands, of every primary for a null `node`. */
  slowLog(node: string | null, limit: number): Promise<readonly SlowCommand[]>;
}

/** The `serverTimeout` service (decision 129), read once at connect. */
export interface ServerTimeoutLimit {
  /** What this server stops by itself under `ExecuteOptions.serverTimeoutMs`; null when this server version has no such setting. */
  readonly limit: ServerTimeout | null;
}

/**
 * What each capability brings to a session (decision 155). A key is a capability, and a session
 * has exactly the keys of the capabilities its plugin declares.
 */
export interface SessionServices {
  readonly cancel: Canceller;
  /** A new session's introspector; calls queue on the session. */
  readonly schemaTree: Introspector;
  readonly ddl: DefinitionReader;
  /** A new session starts in `auto`. */
  readonly transactions: Transactions;
  readonly explain: Explainer;
  readonly currentNamespace: NamespaceReader;
  readonly keepAlive: KeepAlive;
  readonly bulkInsert: BulkInserter;
  readonly sessions: ServerSessions;
  readonly keyValue: Keyspace;
  readonly nodes: NodeList;
  readonly serverInfo: ServerInfoReader;
  readonly serverTimeout: ServerTimeoutLimit;
  readonly watch: KeyWatcher;
  readonly leases: LeaseManager;
  readonly members: ClusterMembers;
  readonly maintenance: ClusterMaintenance;
  readonly access: AccessManager;
  readonly coordination: CoordinationViewer;
  readonly bulkTransfer: KeyTransfer;
}

/** What each capability brings to a SQL language (decision 155). */
export interface LanguageServices {
  readonly explain: ExplainCheck;
  /** How the console switches namespace (decision 060). */
  readonly currentNamespace: NamespaceSwitch;
  readonly bulkInsert: ImportDdl;
  /** The DDL for creating, altering, renaming and dropping (decision 052). */
  readonly objects: ObjectEditor;
  readonly routineCall: RoutineCaller;
  readonly savepoints: SavepointWriter;
  readonly rowLimit: RowLimiter;
}

export type SessionCapability = keyof SessionServices;
export type LanguageCapability = keyof LanguageServices;

const SESSION_KEYS: Readonly<Record<SessionCapability, true>> = {
  cancel: true,
  schemaTree: true,
  ddl: true,
  transactions: true,
  explain: true,
  currentNamespace: true,
  keepAlive: true,
  bulkInsert: true,
  sessions: true,
  keyValue: true,
  nodes: true,
  serverInfo: true,
  serverTimeout: true,
  watch: true,
  leases: true,
  members: true,
  maintenance: true,
  access: true,
  coordination: true,
  bulkTransfer: true,
};

const LANGUAGE_KEYS: Readonly<Record<LanguageCapability, true>> = {
  explain: true,
  currentNamespace: true,
  bulkInsert: true,
  objects: true,
  routineCall: true,
  savepoints: true,
  rowLimit: true,
};

/** The capabilities with a session service: the keys of `SessionServices`. */
export const SESSION_CAPABILITIES = Object.keys(SESSION_KEYS) as readonly SessionCapability[];

/** The capabilities with a language service: the keys of `LanguageServices`. */
export const LANGUAGE_CAPABILITIES = Object.keys(LANGUAGE_KEYS) as readonly LanguageCapability[];

/** The capabilities that bring a whole language to the plugin, and the member that holds it. */
export const PLUGIN_LANGUAGES = { sql: "language", commands: "commandLanguage" } as const satisfies Partial<
  Record<Capability, keyof HostPlugin>
>;

/** Capabilities that only say what the plugin does with what it already has: no service. */
export const FLAG_CAPABILITIES = [
  "explainAnalyze",
  "serverMessages",
  "revisions",
] as const satisfies readonly Capability[];

/** The session a plugin declaring `C` returns: exactly those services (decision 155). */
export interface PluginSession<C extends Capability> extends SessionBase {
  readonly services: Pick<SessionServices, C & SessionCapability>;
}

/** What the host holds: any subset of the services, reached through a check of the key. */
export type Session = SessionBase & { readonly services: Partial<SessionServices> };

interface HostPlugin {
  readonly language?: SqlLanguage;
  readonly commandLanguage?: CommandLanguage;
}

export const SERVICE_PROBLEM_KINDS = ["missing", "undeclared"] as const;

/** Where "present exactly when declared" breaks (decision 155). */
export interface ServiceProblem {
  readonly kind: (typeof SERVICE_PROBLEM_KINDS)[number];
  readonly capability: Capability;
  readonly where: "session" | "language" | "plugin";
  /** Reads after "it": "declares leases but its session has no leases service". */
  readonly message: string;
}

/**
 * Every place `plugin` and, when given, `session` break "a service is present exactly when its
 * capability is declared" (decision 155); empty when nothing does. A service is an object: a
 * missing key, `undefined` and `null` are all absent.
 */
export function serviceProblems(
  capabilities: readonly Capability[],
  plugin: HostPlugin,
  session?: { readonly services?: unknown },
): readonly ServiceProblem[] {
  const declared = new Set<Capability>(capabilities);
  const problems: ServiceProblem[] = [];
  for (const [capability, member] of Object.entries(PLUGIN_LANGUAGES) as [Capability, keyof HostPlugin][]) {
    const present = isService(plugin[member]);
    if (declared.has(capability) && !present) {
      problems.push({
        kind: "missing",
        capability,
        where: "plugin",
        message: `declares ${capability} but exports no ${member}`,
      });
    } else if (!declared.has(capability) && present) {
      problems.push({
        kind: "undeclared",
        capability,
        where: "plugin",
        message: `exports ${member} but does not declare ${capability}`,
      });
    }
  }
  if (isService(plugin.language)) {
    problems.push(...keyProblems("language", LANGUAGE_CAPABILITIES, declared, servicesOf(plugin.language)));
  }
  if (session !== undefined) {
    problems.push(...keyProblems("session", SESSION_CAPABILITIES, declared, servicesOf(session)));
  }
  return problems;
}

function keyProblems(
  where: "session" | "language",
  keys: readonly Capability[],
  declared: ReadonlySet<Capability>,
  services: Readonly<Record<string, unknown>>,
): ServiceProblem[] {
  const problems: ServiceProblem[] = [];
  for (const capability of keys) {
    const present = isService(services[capability]);
    if (declared.has(capability) && !present) {
      problems.push({
        kind: "missing",
        capability,
        where,
        message: `declares ${capability} but its ${where} has no ${capability} service`,
      });
    } else if (!declared.has(capability) && present) {
      problems.push({
        kind: "undeclared",
        capability,
        where,
        message: `has the ${capability} service on its ${where} but does not declare ${capability}`,
      });
    }
  }
  return problems;
}

function servicesOf(holder: unknown): Readonly<Record<string, unknown>> {
  const services = (holder as { readonly services?: unknown }).services;
  return isService(services) ? (services as Readonly<Record<string, unknown>>) : {};
}

function isService(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
