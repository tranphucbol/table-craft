import type { KeyConflictSnapshot } from "./keyspace.js";

/** Failures the host tells apart; anything else a plugin throws is reported as `statementFailed`. */
export const PLUGIN_ERROR_CODES = [
  "cancelled",
  "connectionFailed",
  "statementFailed",
  "introspectionFailed",
  "definitionNotFound",
  /** `Session.explain` refused the statement; the message says why and what to explain instead. */
  "explainUnsupported",
  /**
   * The connection was gone before the statement was sent, so the host may reconnect and run it
   * again; `Session.ping` rejects with it too.
   */
  "connectionLost",
  /**
   * The session is still busy with an earlier statement or result and refused this one unsent
   * (decision 058). The host waits for every close first, so this is a bug it logs and heals by
   * reconnecting; never a message for the user.
   */
  "sessionBusy",
  /**
   * A guarded write found what it was to change already changed by someone else, and wrote
   * nothing (decision 115); the host offers to reload or to overwrite.
   */
  "conflict",
  /**
   * The server stopped the statement at the limit `ExecuteOptions.serverTimeoutMs` set (decision
   * 129); the message names the server's setting.
   */
  "timedOut",
] as const;

export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];

/**
 * Where the database located a failure, relative to the statement text the plugin received:
 * `offset` is 0-based in UTF-16 code units (a JavaScript string index); `line` and `column` count
 * from 1, the column in UTF-16 code units too.
 */
export type ErrorPosition = { readonly offset: number } | { readonly line: number; readonly column: number };

export interface PluginErrorOptions extends ErrorOptions {
  /** Leave it out when the database did not say; the host then underlines nothing. */
  readonly position?: ErrorPosition;
}

/** What a plugin throws when the host should react to the kind of failure, not just show it. */
export class PluginError extends Error {
  override readonly name = "PluginError";
  readonly position: ErrorPosition | undefined;

  constructor(
    readonly code: PluginErrorCode,
    message: string,
    options?: PluginErrorOptions,
  ) {
    super(message, options);
    this.position = options?.position;
  }
}

/**
 * Structural, because every bundled plugin carries its own copy of this module, so `instanceof`
 * fails for an error thrown by a plugin and caught by the host.
 */
export function isPluginError(error: unknown): error is PluginError {
  if (!(error instanceof Error) || error.name !== "PluginError") return false;
  const code: unknown = (error as { code?: unknown }).code;
  return PLUGIN_ERROR_CODES.some((known) => known === code);
}

function isWholeAtLeast(value: unknown, least: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= least;
}

/**
 * The position a plugin attached to a `PluginError`, checked by shape, since the error comes from
 * another bundle; anything malformed reads as no position.
 */
export function errorPositionOf(error: unknown): ErrorPosition | undefined {
  if (!isPluginError(error)) return undefined;
  const position: unknown = (error as { position?: unknown }).position;
  if (typeof position !== "object" || position === null) return undefined;
  const { offset, line, column } = position as Record<string, unknown>;
  if (isWholeAtLeast(offset, 0)) return { offset };
  if (isWholeAtLeast(line, 1) && isWholeAtLeast(column, 1)) return { line, column };
  return undefined;
}

/** `position` as a 0-based offset into `text`, clamped to the text. */
export function offsetOfPosition(text: string, position: ErrorPosition): number {
  if ("offset" in position) return Math.min(position.offset, text.length);
  let start = 0;
  for (let line = 1; line < position.line; line += 1) {
    const end = text.indexOf("\n", start);
    if (end === -1) return text.length;
    start = end + 1;
  }
  const lineEnd = text.indexOf("\n", start);
  const limit = lineEnd === -1 ? text.length : lineEnd;
  return Math.min(start + position.column - 1, limit);
}

/**
 * A `connectionFailed` the SSL settings caused: a certificate file that cannot be read or used, or
 * a server certificate that failed verification. The host then points at those settings instead
 * of the host, port, user and password (decision 072).
 */
export class TlsSettingsError extends PluginError {
  readonly tlsSettings = true;

  constructor(message: string, options?: ErrorOptions) {
    super("connectionFailed", message, options);
  }
}

/** Structural for the same reason as `isPluginError`. */
export function isTlsSettingsError(error: unknown): error is TlsSettingsError {
  return isPluginError(error) && (error as { tlsSettings?: unknown }).tlsSettings === true;
}

/**
 * A guarded `Keyspace.apply` found `target` changed since it was read (decision 115): `detail`
 * says what differs, such as `field name is now "Bo"`. Nothing was written.
 */
export interface ConflictErrorOptions extends ErrorOptions {
  /** Omit when a complete bounded current value cannot be read safely. */
  readonly current?: KeyConflictSnapshot;
}

export class ConflictError extends PluginError {
  readonly current?: KeyConflictSnapshot;

  constructor(
    readonly target: string,
    readonly detail: string,
    options?: ConflictErrorOptions,
  ) {
    super("conflict", `${target} changed since it was read: ${detail}. Reload it, or overwrite the change.`, options);
    if (options?.current !== undefined) this.current = options.current;
  }
}

/**
 * `Introspector.definition` asked for a relation the database does not have, usually one dropped
 * or renamed since the catalog was read (decision 029). Coded `definitionNotFound`, so the host
 * recognises it with `isPluginError` across plugin bundles.
 */
export class DefinitionNotFoundError extends PluginError {
  constructor(
    readonly path: readonly string[],
    readonly relation: string,
    options?: ErrorOptions,
  ) {
    super(
      "definitionNotFound",
      `There is no relation ${relation} in ${path.join(".")}; synchronize the data source to see what it holds now.`,
      options,
    );
  }
}
