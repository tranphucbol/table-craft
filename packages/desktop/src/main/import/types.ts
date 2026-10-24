import type { ImportApp } from "@table-craft/desktop/preload/bridge.js";

export type ForeignApp = ImportApp;

export type ForeignSslMode = "disabled" | "preferred" | "required" | "verifyCa" | "verifyIdentity";

/**
 * Where a connection's password is, if anywhere. A `bundle` value never leaves main: the preview
 * the renderer gets says only `inFile`.
 */
export type PasswordSource =
  | { readonly kind: "none" }
  /** In the other app's credential store, looked up by this service name when importing. */
  | { readonly kind: "store"; readonly service: string; readonly user: string | null }
  | { readonly kind: "bundle"; readonly value: string }
  /** Kept by the other app in a store TableCraft does not read; the user types it on connect. */
  | { readonly kind: "elsewhere" };

/** One saved connection as another app describes it, before mapping to a TableCraft datasource. */
export interface ForeignConnection {
  readonly app: ForeignApp;
  /** The other app's own id: a DataGrip data source uuid, a TablePro connection id. */
  readonly id: string;
  readonly name: string;
  /** A `/`-separated path within the other app, or null at its top level. */
  readonly folder: string | null;
  /** DataGrip's driver-ref or TablePro's database type. */
  readonly driver: string | null;
  /** A JDBC or plain connection URL with macros expanded; null when given as separate fields. */
  readonly url: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly database: string | null;
  readonly user: string | null;
  /** A database file, for file databases given as separate fields. */
  readonly path: string | null;
  readonly ssh: { readonly host: string; readonly port: number | null } | null;
  readonly ssl: { readonly mode: ForeignSslMode; readonly certificateFiles: boolean } | null;
  readonly color: string | null;
  readonly comment: string;
  readonly readOnly: boolean;
  readonly password: PasswordSource;
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
}

/** Where the readers look: the platform and the user's directories, never `process` itself. */
export interface ImportEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** `%APPDATA%` on Windows; null elsewhere. */
  readonly appData: string | null;
  readonly files: ImportFiles;
}
