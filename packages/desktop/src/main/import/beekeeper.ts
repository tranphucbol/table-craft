import { dirname, join } from "node:path";
import { beekeeperKey, openSealed } from "@table-craft/desktop/main/import/beekeeperCrypto.js";
import {
  ImportBusyError,
  type ForeignConnection,
  type ForeignSsh,
  type ForeignSsl,
  type ImportDatabase,
  type ImportEnvironment,
  type ImportFiles,
  type PasswordSource,
} from "@table-craft/desktop/main/import/types.js";

/**
 * Reads Beekeeper Studio's saved connections (plan 150). Beekeeper is GPL-3.0, so this follows its
 * format, not its code: the `saved_connection` and `connection_folder` tables of `app.db` in its
 * userData folder (`apps/studio/src/common/appdb/models/saved_connection.ts`, `ConnectionFolder.ts`),
 * and the secrets sealed under the key in `.key` beside it (`src/common/encryption_key.ts`).
 */
export const BEEKEEPER_DATABASE_FILE = "app.db";
export const BEEKEEPER_KEY_FILE = ".key";
const FOLDER_NAMES = ["beekeeper-studio", "Beekeeper Studio"];
const MAC_DIR = ["Library", "Application Support"];
const LINUX_CONFIG = [".config"];
const SNAP_CONFIG = ["snap", "beekeeper-studio", "current", ".config", "beekeeper-studio"];
const FLATPAK_CONFIG = [".var", "app", "io.beekeeperstudio.Studio", "config", "beekeeper-studio"];
const SQLITE_HEADER = "SQLite format 3\u0000";
const CONNECTIONS_TABLE = "saved_connection";
const FOLDERS_TABLE = "connection_folder";
const LOCAL_WORKSPACE = -1;
const MAX_FOLDER_DEPTH = 32;
const DEFAULT_KEYFILE = [".ssh", "id_rsa"];
const DEFAULT_HOST = "localhost";
const NO_COLOR = "default";
const FOLDER_SEPARATOR = "/";
const SQLSERVER = "sqlserver";
const SQLITE = "sqlite";
const ORACLE = "oracle";
const TYPE_ALIASES: Readonly<Record<string, string>> = { psql: "postgresql", postgres: "postgresql", mssql: SQLSERVER };

const NOT_BEEKEEPER = "This SQLite file is not a Beekeeper Studio app.db.";
/** What an `ImportBusyError` from Beekeeper's database surfaces as. */
export const BEEKEEPER_BUSY =
  "Beekeeper Studio is saving or did not close cleanly; open and close Beekeeper Studio once, then import again.";
const SOCKET_PROBLEM =
  "Connects through a local socket; TableCraft connects over TCP/IP. Add it by host and port instead.";
const CONNECT_STRING_PROBLEM = "Uses an Oracle connect string; add it in TableCraft by hand.";
const SIGN_IN_WARNING = "Beekeeper signs in another way here; TableCraft signs in with a user and password.";
const KEY_UNREADABLE = "Beekeeper's .key could not be read, so the password is asked for on connect.";
const SEAL_UNREADABLE = "The saved password could not be decrypted, so it is asked for on connect.";

/** Why a SQLite file cannot be read as Beekeeper's, said so the user can pick another. */
export class BeekeeperFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeekeeperFormatError";
  }
}

export interface BeekeeperScan {
  readonly found: boolean;
  /** The `app.db` read, or null when there is none. */
  readonly path: string | null;
  /** Where the reader looked, for the "not found" card. */
  readonly looked: readonly string[];
  readonly connections: readonly ForeignConnection[];
  /** Every folder path, so an empty one comes along too. */
  readonly folders: readonly string[];
  /** Null when the secrets were not asked for; otherwise whether `.key` opened. */
  readonly secrets: "read" | "unreadable" | null;
  /** Set when the database could not be read right now. */
  readonly problem?: string;
}

export interface BeekeeperReadOptions {
  /** Decrypt the passwords with the `.key` beside the database. */
  readonly secrets: boolean;
  readonly home: string;
}

type Row = Readonly<Record<string, unknown>>;

/** The folders Beekeeper's userData may be in on this platform, most likely first. */
export function beekeeperDirectories(environment: ImportEnvironment): readonly string[] {
  const { home } = environment;
  if (environment.platform === "darwin") return FOLDER_NAMES.map((name) => join(home, ...MAC_DIR, name));
  if (environment.platform === "win32") {
    const { appData } = environment;
    return appData === null ? [] : FOLDER_NAMES.map((name) => join(appData, name));
  }
  return [
    ...FOLDER_NAMES.map((name) => join(home, ...LINUX_CONFIG, name)),
    join(home, ...SNAP_CONFIG),
    join(home, ...FLATPAK_CONFIG),
  ];
}

/** Whether the bytes start with SQLite's file header. */
export function isSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_HEADER.length) return false;
  for (let index = 0; index < SQLITE_HEADER.length; index++) {
    if (bytes[index] !== SQLITE_HEADER.charCodeAt(index)) return false;
  }
  return true;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function integer(value: unknown): number | null {
  const number = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) ? number : null;
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  return value === 1 || value === 1n || value === true || value === "1" || value === "true";
}

function json(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Each folder id's `/`-joined path from the top; a cycle or a deep chain stops the walk. */
function folderPaths(database: ImportDatabase): Map<number, string> {
  const paths = new Map<number, string>();
  const columns = database.columns(FOLDERS_TABLE);
  if (!columns.includes("id") || !columns.includes("name")) return paths;
  const parent = columns.includes("parentId") ? quote("parentId") : "NULL";
  const rows = database.all(`SELECT id, name, ${parent} AS parentId FROM ${quote(FOLDERS_TABLE)}`);
  const byId = new Map<number, { name: string; parentId: number | null }>();
  for (const row of rows) {
    const id = integer(row.id);
    const name = text(row.name);
    if (id !== null && name !== null) byId.set(id, { name, parentId: integer(row.parentId) });
  }
  for (const id of byId.keys()) {
    const names: string[] = [];
    const seen = new Set<number>();
    let next: number | null = id;
    while (next !== null && !seen.has(next) && names.length < MAX_FOLDER_DEPTH) {
      seen.add(next);
      const folder = byId.get(next);
      if (folder === undefined) break;
      names.unshift(folder.name);
      next = folder.parentId;
    }
    paths.set(id, names.join(FOLDER_SEPARATOR));
  }
  return paths;
}

/** The key the secrets open with: undefined when not asked for, null when `.key` does not open. */
type Key = string | null | undefined;

function secret(row: Row, column: string, key: Key): PasswordSource {
  const sealed = text(row[column]);
  if (sealed === null || !flag(row.rememberPassword, true)) return { kind: "none" };
  if (typeof key !== "string") return { kind: "elsewhere" };
  const value = openSealed(key, sealed);
  return typeof value === "string" ? { kind: "bundle", value } : { kind: "elsewhere" };
}

function sslOf(row: Row): ForeignSsl {
  const files = {
    caFile: text(row.sslCaFile),
    certFile: text(row.sslCertFile),
    keyFile: text(row.sslKeyFile),
  };
  if (!flag(row.ssl, false)) return { mode: "disabled", caFile: null, certFile: null, keyFile: null };
  // Beekeeper checks the server's certificate only when a certificate file is set.
  const anyFile = files.caFile !== null || files.certFile !== null || files.keyFile !== null;
  const verify = anyFile && flag(row.sslRejectUnauthorized, true);
  return { mode: verify ? "verifyIdentity" : "required", ...files };
}

function sshOf(row: Row, key: Key, home: string): ForeignSsh | null {
  if (!flag(row.sshEnabled, false)) return null;
  const mode = text(row.sshMode);
  const auth = mode === "agent" ? "agent" : mode === "userpass" ? "password" : mode === "keyfile" ? "key" : null;
  const bastion = text(row.sshBastionHost);
  const host = text(row.sshHost) ?? "";
  return {
    host,
    port: integer(row.sshPort),
    user: text(row.sshUsername),
    auth,
    keyPath: auth === "key" ? (text(row.sshKeyfile) ?? join(home, ...DEFAULT_KEYFILE)) : null,
    password: auth === "password" ? secret(row, "sshPassword", key) : { kind: "none" },
    passphrase: auth === "key" ? secret(row, "sshKeyfilePassword", key) : { kind: "none" },
    ...(bastion === null
      ? {}
      : {
          unsupported: `Beekeeper reaches this server through the jump host ${bastion}; TableCraft tunnels through one SSH host, so set the tunnel up after import.`,
        }),
  };
}

/** A JDBC-style URL: SQL Server takes TLS from `trustServerCertificate`, which the plugin's URL reads. */
function sqlServerUrl(row: Row, host: string, port: number | null, database: string | null): string {
  const files = [text(row.sslCaFile), text(row.sslCertFile), text(row.sslKeyFile)];
  const trust = files.every((file) => file !== null)
    ? !flag(row.sslRejectUnauthorized, true)
    : flag(row.trustServerCertificate, false);
  const params = [`trustServerCertificate=${String(trust)}`];
  if (database !== null) params.unshift(`databaseName=${database}`);
  if (flag(row.ssl, false) && files[0] !== null) params.push(`trustStore=${files[0]}`);
  return `jdbc:sqlserver://${host}${port === null ? "" : `:${String(port)}`};${params.join(";")}`;
}

function otherSignIn(row: Row, type: string): boolean {
  if (type === SQLSERVER && (flag(row.windowsAuthEnabled, false) || text(row.domain) !== null)) return true;
  return (
    json(row.azureAuthOptions).azureAuthEnabled === true || json(row.iamAuthOptions).iamAuthenticationEnabled === true
  );
}

function toConnection(row: Row, folders: ReadonlyMap<number, string>, key: Key, home: string): ForeignConnection {
  const id = text(row.id) ?? "";
  const rawType = (text(row.connectionType) ?? "").toLowerCase();
  const type = TYPE_ALIASES[rawType] ?? rawType;
  const folderId = integer(row.connectionFolderId);
  const warnings: string[] = [];
  const options = json(row.options);
  const host = text(row.host) ?? DEFAULT_HOST;
  const port = integer(row.port);
  const file = type === SQLITE;
  let database = text(row.defaultDatabase);
  if (type === ORACLE) {
    database = text(row.serviceName) ?? database;
    if (text(options.privilege) !== null)
      warnings.push(`The Oracle privilege ${String(options.privilege)} was not imported.`);
  }
  const signIn = otherSignIn(row, type);
  if (signIn) warnings.push(SIGN_IN_WARNING);
  const problem = flag(row.socketPathEnabled, false)
    ? SOCKET_PROBLEM
    : type === ORACLE && options.connectionMethod === "connectionString"
      ? CONNECT_STRING_PROBLEM
      : undefined;
  const password: PasswordSource = file || signIn ? { kind: "none" } : secret(row, "password", key);
  if (password.kind === "elsewhere" && key !== undefined)
    warnings.push(key === null ? KEY_UNREADABLE : SEAL_UNREADABLE);
  return {
    app: "beekeeper",
    id: `${id}@${text(row.createdAt) ?? ""}`,
    name: text(row.name) ?? `Connection ${id}`,
    folder: folderId === null ? null : (folders.get(folderId) ?? null),
    driver: type === "" ? null : type,
    url: type === SQLSERVER ? sqlServerUrl(row, host, port, database) : null,
    host: file ? null : host,
    port: file ? null : port,
    database: file ? null : database,
    user: file ? null : text(row.username),
    path: file ? database : null,
    ssh: file ? null : sshOf(row, key, home),
    ssl: file || type === SQLSERVER ? null : sslOf(row),
    color: text(row.labelColor) === NO_COLOR ? null : text(row.labelColor),
    comment: "",
    readOnly: flag(row.readOnlyMode, false),
    password,
    ...(problem === undefined ? {} : { problem }),
    warnings,
  };
}

function ordered(rows: readonly Row[], folders: ReadonlyMap<number, string>): Row[] {
  const folderOf = (row: Row) => {
    const id = integer(row.connectionFolderId);
    return id === null ? "" : (folders.get(id) ?? "");
  };
  const position = (row: Row) => (typeof row.position === "number" ? row.position : 0);
  return [...rows].sort(
    (a, b) =>
      folderOf(a).localeCompare(folderOf(b)) ||
      position(a) - position(b) ||
      (text(a.name) ?? "").localeCompare(text(b.name) ?? ""),
  );
}

async function readKey(files: ImportFiles, databasePath: string, wanted: boolean): Promise<Key> {
  if (!wanted) return undefined;
  const keyText = await files.readText(join(dirname(databasePath), BEEKEEPER_KEY_FILE));
  return keyText === null ? null : beekeeperKey(keyText);
}

/**
 * The local connections and folders in a Beekeeper `app.db`. Throws `BeekeeperFormatError` when the
 * file is not one, and `ImportBusyError` when Beekeeper is writing it.
 */
export async function readBeekeeperDatabase(
  files: ImportFiles,
  databasePath: string,
  options: BeekeeperReadOptions,
): Promise<Omit<BeekeeperScan, "found" | "looked">> {
  const database = await files.readDatabase(databasePath);
  if (database === null) throw new BeekeeperFormatError(NOT_BEEKEEPER);
  let rows: readonly Row[];
  let folders: Map<number, string>;
  try {
    const columns = database.columns(CONNECTIONS_TABLE);
    if (columns.length === 0) throw new BeekeeperFormatError(NOT_BEEKEEPER);
    const local = columns.includes("workspaceId") ? ` WHERE ${quote("workspaceId")} = ${String(LOCAL_WORKSPACE)}` : "";
    rows = database.all(`SELECT * FROM ${quote(CONNECTIONS_TABLE)}${local}`);
    folders = folderPaths(database);
  } finally {
    database.close();
  }
  const key = await readKey(files, databasePath, options.secrets);
  const connections = ordered(rows, folders).map((row) => toConnection(row, folders, key, options.home));
  return {
    path: databasePath,
    connections,
    folders: [...new Set(folders.values())].filter((path) => path !== "").sort(),
    secrets: key === undefined ? null : key === null ? "unreadable" : "read",
  };
}

/** Finds `app.db` in Beekeeper's userData folder and reads it; a busy database is found but unread. */
export async function scanBeekeeper(
  environment: ImportEnvironment,
  options: { readonly secrets: boolean },
): Promise<BeekeeperScan> {
  const looked = beekeeperDirectories(environment);
  for (const directory of looked) {
    const path = join(directory, BEEKEEPER_DATABASE_FILE);
    const names = await environment.files.list(directory);
    if (names === null || !names.includes(BEEKEEPER_DATABASE_FILE)) continue;
    try {
      const read = await readBeekeeperDatabase(environment.files, path, {
        secrets: options.secrets,
        home: environment.home,
      });
      return { found: true, looked, ...read };
    } catch (cause) {
      if (cause instanceof BeekeeperFormatError) {
        return { found: true, looked, path, connections: [], folders: [], secrets: null, problem: cause.message };
      }
      if (cause instanceof ImportBusyError) {
        return { found: true, looked, path, connections: [], folders: [], secrets: null, problem: BEEKEEPER_BUSY };
      }
      throw cause;
    }
  }
  return { found: false, path: null, looked, connections: [], folders: [], secrets: null };
}
