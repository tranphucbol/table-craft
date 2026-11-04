import type { SshAuthMethod } from "@table-craft/desktop/engine/protocol.js";
import type { ScannedApp } from "@table-craft/desktop/preload/bridge.js";

export type ForeignApp = ScannedApp;

export type ForeignSslMode = "disabled" | "preferred" | "required" | "verifyCa" | "verifyIdentity";

/** A connection's SSL settings; each file is a path as the other app saved it, or null when unset. */
export interface ForeignSsl {
  readonly mode: ForeignSslMode;
  readonly caFile: string | null;
  readonly certFile: string | null;
  readonly keyFile: string | null;
}

/**
 * Where a connection's password is, if anywhere. A `bundle` value never leaves main: the preview
 * the renderer gets says only `inFile`.
 */
export type PasswordSource =
  | { readonly kind: "none" }
  /**
   * In the other app's credential store, looked up by this service name when importing. With an
   * `account`, the item is the one for that account and holds the bare password (MySQL Workbench);
   * without, IntelliJ's format.
   */
  | { readonly kind: "store"; readonly service: string; readonly account?: string }
  | { readonly kind: "bundle"; readonly value: string }
  /** Kept by the other app in a store TableCraft does not read; the user types it on connect. */
  | { readonly kind: "elsewhere" };

/** The SSH tunnel a connection goes through; it imports only when the user and sign-in are known. */
export interface ForeignSsh {
  readonly host: string;
  readonly port: number | null;
  readonly user: string | null;
  readonly auth: SshAuthMethod | null;
  readonly keyPath: string | null;
  readonly password: PasswordSource;
  /** The key file's passphrase, for `key` auth; none when the app keeps none. */
  readonly passphrase?: PasswordSource;
  /** Why the tunnel cannot be imported as it is, such as a jump host; the row keeps its address. */
  readonly unsupported?: string;
}

/** One saved connection as another app describes it, before mapping to a TableCraft datasource. */
export interface ForeignConnection {
  readonly app: ForeignApp;
  /** The other app's own id: a DataGrip data source uuid, a TablePro connection id, a Workbench object id. */
  readonly id: string;
  readonly name: string;
  /** A `/`-separated path within the other app, or null at its top level. */
  readonly folder: string | null;
  /** DataGrip's driver-ref, TablePro's database type, or the database type a Workbench driver speaks. */
  readonly driver: string | null;
  /** A JDBC or plain connection URL with macros expanded; null when given as separate fields. */
  readonly url: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly database: string | null;
  readonly user: string | null;
  /** A database file, for file databases given as separate fields. */
  readonly path: string | null;
  readonly ssh: ForeignSsh | null;
  readonly ssl: ForeignSsl | null;
  readonly color: string | null;
  readonly comment: string;
  readonly readOnly: boolean;
  readonly password: PasswordSource;
  /** Why the reader knows it cannot be imported, shown on its unsupported row. */
  readonly problem?: string;
  /** What the reader had to leave out, shown on its row. */
  readonly warnings?: readonly string[];
}

/**
 * The read-only file access the readers need, injected so tests point them at fixtures. Every
 * method resolves null for a missing path and never writes.
 */
export interface ImportFiles {
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  /** The names in a directory; null when it is not one. */
  list(path: string): Promise<readonly string[] | null>;
  /**
   * A SQLite database opened read-only in place; null when the file is missing. Throws
   * `ImportBusyError` when its owner is writing it or left a journal behind.
   */
  readDatabase(path: string): Promise<ImportDatabase | null>;
}

/** One SQLite database opened read-only; rows come back as plain objects. */
export interface ImportDatabase {
  /** The column names of `table`, empty when it does not exist. */
  columns(table: string): readonly string[];
  all(sql: string, ...params: readonly (string | number | null)[]): readonly Record<string, unknown>[];
  close(): void;
}

/** The other app holds its database open for writing, or did not close it cleanly. */
export class ImportBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportBusyError";
  }
}

/** Where the readers look: the platform and the user's directories, never `process` itself. */
export interface ImportEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** `%APPDATA%` on Windows; null elsewhere. */
  readonly appData: string | null;
  readonly files: ImportFiles;
}
