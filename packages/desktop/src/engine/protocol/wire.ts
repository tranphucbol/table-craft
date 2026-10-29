import type { EngineError } from "./calls.js";
import type { DatasourceConfig, SshHop, TlsHop } from "./datasource.js";

/** Mirrors `RESULT_WINDOW_ROWS` in core: the most rows one `result.window` returns. */
export const RESULT_WINDOW_ROWS = 500;
/** Mirrors `RESULT_PAGE_ROWS` in core: the default page, before the user's setting (decision 032). */
export const RESULT_PAGE_ROWS = 500;
/** Mirrors `RESULT_FETCH_ALL_CAP` in core: the default Fetch All cap, before the user's setting. */
export const RESULT_FETCH_ALL_CAP = 100_000;

/** What main posts on the engine's parent port, once, before any renderer port arrives. */
export const ENGINE_BOOT_MESSAGE = "engine.boot";
/** What main posts on the engine's parent port alongside a fresh renderer port. */
export const ENGINE_PORT_MESSAGE = "engine.port";
/** What main posts on the engine's parent port to have it close every session and exit. */
export const ENGINE_SHUTDOWN_MESSAGE = "engine.shutdown";
/** What a probe engine posts on its parent port, once, before it exits. */
export const ENGINE_PROBED_MESSAGE = "engine.probed";
/** What an engine posts on its parent port for each log record; main alone writes the log (plan 017). */
export const ENGINE_LOG_MESSAGE = "engine.log";
/**
 * A plain cancel's message. A `cancelled` error with any other message says what else the cancel
 * did, such as resetting the session on a server that cannot stop a statement (decision 058).
 */
export const STATEMENT_CANCELLED_MESSAGE = "The statement was cancelled.";

/** Mirrors `WireValue` in plugin-api. */
export type WireValue =
  | null
  | boolean
  | number
  | string
  | { readonly kind: "bigint"; readonly value: string }
  | { readonly kind: "bytes"; readonly preview: string; readonly length: number }
  | { readonly kind: "json"; readonly text: string }
  | { readonly kind: "date"; readonly iso: string };

export type Row = readonly WireValue[];

/** Mirrors `TypeClass` in plugin-api: what a column holds, for its header glyph. */
export type TypeClass = "integer" | "float" | "decimal" | "boolean" | "temporal" | "json" | "bytes" | "text";

/** Mirrors `Column` in plugin-api. */
export interface Column {
  readonly name: string;
  readonly type: string | null;
  readonly typeClass?: TypeClass;
  readonly origin?: ColumnOrigin | null;
}

/** Mirrors `ColumnOrigin` in plugin-api. */
export interface ColumnOrigin {
  readonly table: string;
  readonly column: string;
}

/** Mirrors `Capability` in plugin-api. The renderer branches on these, never on a plugin id (decision 007). */
export type Capability =
  | "sql"
  | "cancel"
  | "schemaTree"
  | "transactions"
  | "ddl"
  | "explain"
  | "explainAnalyze"
  | "currentNamespace"
  | "keepAlive"
  | "bulkInsert"
  | "objects"
  | "serverMessages"
  | "sessions"
  | "routineCall"
  | "commands"
  | "keyValue"
  | "nodes"
  | "serverInfo";

/** Mirrors `CommandReply` in plugin-api: a command's scalar answer, which goes to Output (decision 112). */
export interface CommandReply {
  readonly value: WireValue;
  readonly text: string;
  readonly read?: boolean;
}

/** Mirrors `NODE_AUTO` in plugin-api: a command runs where its key's slot lives. */
export const NODE_AUTO = "auto";
/** Mirrors `NODE_ALL_PRIMARIES` in plugin-api: a command runs on every primary, one result. */
export const NODE_ALL_PRIMARIES = "allPrimaries";

/** Mirrors `ServerMessageLevel` in plugin-api. */
export type ServerMessageLevel = "error" | "warning" | "notice" | "info";

/** Mirrors `ServerMessage` in plugin-api: a warning or notice the server raised running a statement (decision 066). */
export interface ServerMessage {
  readonly level: ServerMessageLevel;
  readonly code: string | null;
  readonly text: string;
}

/** `serve` answers renderer ports until the last closes; `probe` tests one connection and exits. */
export type EngineMode = "serve" | "probe";

/** A folder whose subfolders are plugins, or one plugin's folder (decision 110). */
export type PluginRoot = string | { readonly directory: string };

export interface EngineBoot {
  readonly kind: typeof ENGINE_BOOT_MESSAGE;
  readonly mode: EngineMode;
  readonly datasource: DatasourceConfig;
  /** Where plugins are, in precedence order (decision 005); mirrors `PluginRoot` in core. */
  readonly pluginRoots: readonly PluginRoot[];
}

/**
 * What Test Connection shows: the server that answered, or why none did. `ssh` is the tunnel's hop
 * when it opened, so a failure past it still says the bastion was reached.
 */
export type ProbeResult =
  | {
      readonly ok: true;
      readonly pluginName: string;
      readonly serverVersion: string | null;
      /** The product that answered, one of the plugin's `brands` ids; null when it names none. */
      readonly serverBrand: string | null;
      readonly elapsedMs: number;
      readonly ssh?: SshHop;
      /** The TLS the database connection negotiated; null when it is not encrypted (decision 072). */
      readonly tls?: TlsHop | null;
    }
  | { readonly ok: false; readonly error: EngineError; readonly ssh?: SshHop };

/** `record` is a `LogRecord` (`log/record.ts`); main validates it and sets its `process`. */
export interface EngineLog {
  readonly kind: typeof ENGINE_LOG_MESSAGE;
  readonly record: unknown;
}

export interface EngineProbed {
  readonly kind: typeof ENGINE_PROBED_MESSAGE;
  readonly result: ProbeResult;
}

/**
 * The user's paging preferences, sent with every call that reads rows, because the engine keeps no
 * preferences of its own (decision 032).
 */
export interface ResultPaging {
  /** Rows read when the statement runs, and per Fetch Next Page. */
  readonly pageRows: number;
  /** The most rows the result holds; Fetch All stops there and closes the cursor. */
  readonly fetchAllCap: number;
}

/**
 * How long the statement may run before the engine cancels it with `statementTimedOut`; 0 or absent
 * for no limit. The renderer resolves it from the data source and Settings (decision 054).
 */
export interface StatementLimit {
  readonly timeoutSeconds?: number;
}
