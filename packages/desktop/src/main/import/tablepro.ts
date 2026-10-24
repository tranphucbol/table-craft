import { createDecipheriv, pbkdf2 } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ForeignConnection,
  ForeignSslMode,
  ImportEnvironment,
  PasswordSource,
} from "@table-craft/desktop/main/import/types.js";
import { parseXml } from "@table-craft/desktop/main/import/xml.js";

/**
 * Reads TablePro's saved connections: the `connections.json` list in its Application Support
 * directory, and `.tablepro` export bundles, plain or passphrase-encrypted. Decision 067 describes
 * both formats; TablePro is AGPL-3.0, so this reader is written from those descriptions, not its code.
 */
export const TABLEPRO_CONNECTIONS = "connections.json";
export const TABLEPRO_BUNDLE_EXTENSION = "tablepro";

const ENCRYPTED_MAGIC = "TPRO";
const ENCRYPTED_VERSION = 1;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ENCRYPTED_MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES;
const KEY_BYTES = 32;
/** The iteration count the bundle's key derivation uses; fixed by the format. */
export const TABLEPRO_KDF_ITERATIONS = 600_000;
const KDF_DIGEST = "sha256";
const CIPHER = "aes-256-gcm";
const SQLITE_TYPE = "sqlite";
/** TablePro's preferences domain, and the key its groups are kept under. */
export const TABLEPRO_DEFAULTS_DOMAIN = "com.TablePro";
const TABLEPRO_GROUPS_KEY = "com.TablePro.groups";

const derive = promisify(pbkdf2);

export type TableProBundleProblem = "needsPassphrase" | "wrongPassphrase" | "unreadable";

/** A bundle that could not be opened; `problem` tells the dialog what to show. */
export class TableProBundleError extends Error {
  override readonly name = "TableProBundleError";
  constructor(
    readonly problem: TableProBundleProblem,
    message: string,
  ) {
    super(message);
  }
}

export interface TableProGroup {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

export interface TableProScan {
  /** Null where TablePro does not run (it is a macOS app). */
  readonly path: string | null;
  readonly found: boolean;
  readonly connections: readonly ForeignConnection[];
}

export function tableProDirectory(environment: ImportEnvironment): string | null {
  return environment.platform === "darwin"
    ? join(environment.home, "Library", "Application Support", "TablePro")
    : null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function port(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : null;
}

function sslMode(value: unknown): ForeignSslMode {
  switch (typeof value === "string" ? value.toLowerCase().replace(/[\s_-]/g, "") : "") {
    case "preferred":
      return "preferred";
    case "required":
      return "required";
    case "verifyca":
      return "verifyCa";
    case "verifyidentity":
      return "verifyIdentity";
    default:
      return "disabled";
  }
}

function ssl(mode: unknown, files: readonly unknown[]): ForeignConnection["ssl"] {
  return { mode: sslMode(mode), certificateFiles: files.some((file) => text(file) !== null) };
}

/** The `/`-joined names from the group up through its parents; cycles end the walk. */
function groupPath(id: string | null, groups: ReadonlyMap<string, TableProGroup>): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = id === null ? undefined : groups.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name.replaceAll("/", "-"));
    current = current.parentId === null ? undefined : groups.get(current.parentId);
  }
  return names.length === 0 ? null : names.join("/");
}

interface ConnectionShape {
  readonly id: string;
  readonly entry: Json;
  readonly ssh: ForeignConnection["ssh"];
  readonly ssl: ForeignConnection["ssl"];
  readonly folder: string | null;
  readonly password: PasswordSource;
}

function toConnection(shape: ConnectionShape): ForeignConnection {
  const { entry } = shape;
  const type = text(entry.type);
  const database = text(entry.database);
  const isFile = type?.toLowerCase() === SQLITE_TYPE;
  return {
    app: "tablepro",
    id: shape.id,
    name: text(entry.name) ?? shape.id,
    folder: shape.folder,
    driver: type,
    url: null,
    host: isFile ? null : text(entry.host),
    port: isFile ? null : port(entry.port),
    database: isFile ? null : database,
    user: isFile ? null : text(entry.username),
    path: isFile ? database : null,
    ssh: shape.ssh,
    ssl: shape.ssl,
    color: text(entry.color),
    comment: "",
    readOnly: false,
    password: shape.password,
  };
}

/** Reads `connections.json` from TablePro's directory; passwords stay in TablePro's keychain. */
export async function scanTablePro(
  environment: ImportEnvironment,
  groups: readonly TableProGroup[] = [],
): Promise<TableProScan> {
  const directory = tableProDirectory(environment);
  if (directory === null) return { path: null, found: false, connections: [] };
  const path = join(directory, TABLEPRO_CONNECTIONS);
  const contents = await environment.files.readText(path);
  if (contents === null) return { path, found: false, connections: [] };
  let entries: unknown;
  try {
    entries = JSON.parse(contents);
  } catch {
    return { path, found: true, connections: [] };
  }
  const byId = new Map(groups.map((group) => [group.id, group]));
  const connections = (Array.isArray(entries) ? entries : []).filter(isObject).map((entry, index) =>
    toConnection({
      id: text(entry.id) ?? String(index),
      entry,
      ssh: entry.sshEnabled === true ? { host: text(entry.sshHost) ?? "", port: port(entry.sshPort) } : null,
      ssl: ssl(entry.sslMode, [entry.sslCaCertificatePath, entry.sslClientCertificatePath, entry.sslClientKeyPath]),
      folder: groupPath(text(entry.groupId), byId),
      password: { kind: "elsewhere" },
    }),
  );
  return { path, found: true, connections };
}

/** Reads the groups TablePro keeps in its preferences: a JSON array of `{id, name, parentId}`. */
export function parseTableProGroups(json: string): TableProGroup[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : []).filter(isObject).flatMap((group) => {
    const id = text(group.id);
    const name = text(group.name);
    return id === null || name === null ? [] : [{ id, name, parentId: text(group.parentId) }];
  });
}

/**
 * Finds TablePro's groups in its exported preferences (`defaults export com.TablePro -`): a plist
 * dict whose `com.TablePro.groups` key holds the JSON array as `<data>`.
 */
export function parseTableProDefaults(plist: string): TableProGroup[] {
  let document;
  try {
    document = parseXml(plist);
  } catch {
    return [];
  }
  const dict = document.children.find((node) => node.name === "dict");
  const nodes = dict?.children ?? [];
  const keyAt = nodes.findIndex((node) => node.name === "key" && node.text.trim() === TABLEPRO_GROUPS_KEY);
  const value = keyAt < 0 ? undefined : nodes[keyAt + 1];
  if (value === undefined) return [];
  const json =
    value.name === "data" ? Buffer.from(value.text.replace(/\s+/g, ""), "base64").toString("utf8") : value.text;
  return parseTableProGroups(json);
}

export function isEncryptedBundle(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, ENCRYPTED_MAGIC.length)).toString("latin1") === ENCRYPTED_MAGIC;
}

async function decrypt(bytes: Uint8Array, passphrase: string): Promise<string> {
  const buffer = Buffer.from(bytes);
  if (buffer.length < HEADER_BYTES + TAG_BYTES || buffer[ENCRYPTED_MAGIC.length] !== ENCRYPTED_VERSION) {
    throw new TableProBundleError(
      "unreadable",
      "This .tablepro file is encrypted in a format TableCraft does not know.",
    );
  }
  let offset = ENCRYPTED_MAGIC.length + 1;
  const salt = buffer.subarray(offset, (offset += SALT_BYTES));
  const nonce = buffer.subarray(offset, (offset += NONCE_BYTES));
  const sealed = buffer.subarray(offset);
  const key = await derive(passphrase, salt, TABLEPRO_KDF_ITERATIONS, KEY_BYTES, KDF_DIGEST);
  const decipher = createDecipheriv(CIPHER, key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new TableProBundleError("wrongPassphrase", "The passphrase does not open this .tablepro file.");
  } finally {
    key.fill(0);
  }
}

function bundleGroups(document: Json, version: number): Map<string, TableProGroup> {
  const groups = new Map<string, TableProGroup>();
  for (const group of (Array.isArray(document.groups) ? document.groups : []).filter(isObject)) {
    const name = text(group.name);
    if (name === null) continue;
    const id = version >= 2 ? (text(group.ref) ?? name) : name;
    groups.set(id, { id, name, parentId: version >= 2 ? text(group.parentRef) : null });
  }
  return groups;
}

/**
 * Reads a `.tablepro` bundle. An encrypted one needs `passphrase`, used for this call only; its
 * passwords come back as `bundle` sources and never leave main.
 */
export async function readTableProBundle(
  bytes: Uint8Array,
  passphrase: string | null,
  source: string,
): Promise<ForeignConnection[]> {
  let json: string;
  if (isEncryptedBundle(bytes)) {
    if (passphrase === null || passphrase === "") {
      throw new TableProBundleError("needsPassphrase", "This .tablepro file is encrypted. Enter its passphrase.");
    }
    json = await decrypt(bytes, passphrase);
  } else {
    json = Buffer.from(bytes).toString("utf8");
  }
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch {
    throw new TableProBundleError("unreadable", "This file is not a TablePro export.");
  }
  if (!isObject(document) || !Array.isArray(document.connections)) {
    throw new TableProBundleError("unreadable", "This file is not a TablePro export.");
  }
  const version = typeof document.formatVersion === "number" ? document.formatVersion : 1;
  const groups = bundleGroups(document, version);
  const credentials = isObject(document.credentials) ? document.credentials : {};
  return document.connections.filter(isObject).map((entry, index) => {
    const ref = version >= 2 ? text(entry.ref) : null;
    const credential = credentials[ref ?? String(index)];
    const value = isObject(credential) ? text(credential.password) : null;
    const sshConfig = isObject(entry.sshConfig) ? entry.sshConfig : {};
    const sslConfig = isObject(entry.sslConfig) ? entry.sslConfig : {};
    const groupId = version >= 2 ? text(entry.groupRef) : text(entry.groupName);
    return toConnection({
      id: ref ?? `${source}#${String(index)}`,
      entry,
      ssh: sshConfig.enabled === true ? { host: text(sshConfig.host) ?? "", port: port(sshConfig.port) } : null,
      ssl: ssl(sslConfig.mode, [sslConfig.caCertificatePath, sslConfig.clientCertificatePath, sslConfig.clientKeyPath]),
      folder: groupPath(groupId, groups),
      password: value === null ? { kind: "none" } : { kind: "bundle", value },
    });
  });
}
