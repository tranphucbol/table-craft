import { join } from "node:path";
import type {
  ForeignConnection,
  ForeignSsh,
  ForeignSslMode,
  ImportEnvironment,
  PasswordSource,
} from "@table-craft/desktop/main/import/types.js";
import { childrenNamed, parseXml, XmlError, type XmlElement } from "@table-craft/desktop/main/import/xml.js";

/**
 * Reads MySQL Workbench's saved connections (plan 143). Workbench is GPL-2.0, so this follows its
 * format, not its code: `connections.xml` in the user data directory
 * (`backend/wbprivate/workbench/wb_context.cpp`), the driver ids, parameters and password keys of
 * `modules/db.mysql/res/mysql_rdbms_info.xml`, and the home screen's `Group/Name` titles
 * (`library/forms/home_screen_connections.cpp`).
 */
export const WORKBENCH_CONNECTIONS_FILE = "connections.xml";
const MAC_DIR = ["Library", "Application Support", "MySQL", "Workbench"];
const LINUX_DIR = [".mysql", "workbench"];
const WINDOWS_DIR = ["MySQL", "Workbench"];
const CONNECTION_STRUCT = "db.mgmt.Connection";
const DRIVER_PREFIX = "com.mysql.rdbms.mysql.driver.";
const DATABASE_TYPE = "mysql";
const GROUP_SEPARATOR = "/";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3306;
const DEFAULT_USER = "root";
const DECIMAL_RADIX = 10;
const GRT_ROOT = /^\s*(?:<\?xml[^>]*\?>\s*)?<data\b[^>]*\bgrt_format=/;

type Driver = "tcp" | "socket" | "ssh" | "ldap" | "kerberos";

const DRIVERS: Readonly<Record<string, Driver>> = {
  native: "tcp",
  native_socket: "socket",
  native_sshtun: "ssh",
  ldap_user_password: "ldap",
  ldap_sasl_kerberos: "kerberos",
  ldap_kerberos: "kerberos",
};

/** `useSSL`: 0 No, 1 If available, 2 Require, 3 Require and Verify CA, 4 Require and Verify Identity. */
const SSL_MODES: readonly ForeignSslMode[] = ["disabled", "preferred", "required", "verifyCa", "verifyIdentity"];

/** Parameters TableCraft's MySQL has no setting for; set to anything but off, they are named on the row. */
const IGNORED_PARAMETERS = [
  "sslCipher",
  "CLIENT_COMPRESS",
  "SQL_MODE",
  "useAnsiQuotes",
  "OPT_ENABLE_CLEARTEXT_PLUGIN",
  "$others",
  "sshCompressionLevel",
];
const OFF_VALUES = new Set(["", "0"]);

const SOCKET_PROBLEM =
  "Connects through a local socket or named pipe; TableCraft's MySQL connects over TCP/IP. Add it by host and port instead.";
const LDAP_WARNING = "Workbench signs in through LDAP here; TableCraft sends the password with MySQL's own sign-in.";
const KERBEROS_WARNING =
  "Workbench signs in with Kerberos here; TableCraft signs in with a password, which is not imported.";

export interface WorkbenchScan {
  /** The `connections.xml` read, or null when there is none. */
  readonly path: string | null;
  readonly found: boolean;
  /** Where the reader looked, for the "not found" card. */
  readonly looked: readonly string[];
  readonly connections: readonly ForeignConnection[];
}

/** Workbench's user data directory on this platform, or null where it has none. */
export function workbenchDirectory(environment: ImportEnvironment): string | null {
  if (environment.platform === "darwin") return join(environment.home, ...MAC_DIR);
  if (environment.platform === "win32") {
    return environment.appData === null ? null : join(environment.appData, ...WINDOWS_DIR);
  }
  return join(environment.home, ...LINUX_DIR);
}

/** Whether the text is a Workbench GRT document rather than another app's XML. */
export function isWorkbenchXml(text: string): boolean {
  return GRT_ROOT.test(text);
}

function values(element: XmlElement): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const value of [...childrenNamed(element, "value"), ...childrenNamed(element, "link")]) {
    const key = value.attributes.key;
    if (key !== undefined && value.children.length === 0) byKey.set(key, value.text.trim());
  }
  return byKey;
}

function parameterValues(connection: XmlElement): Map<string, string> {
  const dict = childrenNamed(connection, "value").find((value) => value.attributes.key === "parameterValues");
  return dict === undefined ? new Map<string, string>() : values(dict);
}

function connectionObjects(root: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (element: XmlElement): void => {
    for (const next of element.children) {
      if (next.name === "value" && next.attributes["struct-name"] === CONNECTION_STRUCT) found.push(next);
      else visit(next);
    }
  };
  visit(root);
  return found;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value.trim();
}

function parseInteger(value: string | undefined): number | null {
  const text = nonEmpty(value);
  if (text === null) return null;
  const number = Number.parseInt(text, DECIMAL_RADIX);
  return Number.isInteger(number) ? number : null;
}

/** `host`, `host:port` or `[v6]:port`, as Workbench's `sshHost` holds them. */
export function splitSshHost(text: string): { host: string; port: number | null } {
  const bracketed = /^\[([^\]]*)\](?::(\d+))?$/.exec(text);
  if (bracketed !== null) return { host: bracketed[1] ?? "", port: parseInteger(bracketed[2]) };
  const colon = text.lastIndexOf(":");
  if (colon < 0 || text.indexOf(":") !== colon) return { host: text, port: null };
  return { host: text.slice(0, colon), port: parseInteger(text.slice(colon + 1)) };
}

/** The `hostIdentifier` a driver's template builds, for files that lack it. */
function hostIdentifier(driver: Driver, host: string, port: number, socket: string, sshHost: string): string {
  if (driver === "socket") return `Mysql@local:${socket}`;
  if (driver === "ssh") return `Mysql@${host}:${String(port)}@${sshHost}`;
  return `Mysql@${host}:${String(port)}`;
}

function storePassword(windows: boolean, service: string, account: string): PasswordSource {
  // Windows keeps them in a DPAPI-encrypted file TableCraft does not read (plan 143, out of scope).
  return windows ? { kind: "elsewhere" } : { kind: "store", service, account };
}

function splitName(title: string): { folder: string | null; name: string } {
  const index = title.indexOf(GROUP_SEPARATOR);
  if (index <= 0 || index === title.length - 1) return { folder: null, name: title };
  return { folder: title.slice(0, index), name: title.slice(index + 1) };
}

function toConnection(element: XmlElement, index: number, windows: boolean): ForeignConnection {
  const own = values(element);
  const parameters = parameterValues(element);
  const parameter = (...keys: string[]) => {
    for (const key of keys) {
      const value = nonEmpty(parameters.get(key));
      if (value !== null) return value;
    }
    return null;
  };
  const driverId = own.get("driver") ?? "";
  const driver = driverId.startsWith(DRIVER_PREFIX) ? DRIVERS[driverId.slice(DRIVER_PREFIX.length)] : undefined;
  const title = nonEmpty(own.get("name")) ?? `Connection ${String(index + 1)}`;
  const { folder, name } = splitName(title);
  const host = parameter("hostName", "host") ?? DEFAULT_HOST;
  const port = parseInteger(parameters.get("port")) ?? DEFAULT_PORT;
  const user = parameter("userName", "username") ?? DEFAULT_USER;
  const sshHost = parameter("sshHost") ?? "";
  const identifier =
    nonEmpty(own.get("hostIdentifier")) ??
    hostIdentifier(driver ?? "tcp", host, port, parameter("socket") ?? "", sshHost);
  const legacyPassword = parameters.get("password");
  const warnings: string[] = [];
  const ignored = IGNORED_PARAMETERS.filter((key) => !OFF_VALUES.has((parameters.get(key) ?? "").trim()));
  if (ignored.length > 0) warnings.push(`Not imported: ${ignored.join(", ")}.`);
  if (driver === "ldap") warnings.push(LDAP_WARNING);
  if (driver === "kerberos") warnings.push(KERBEROS_WARNING);
  const sslLevel = parseInteger(parameters.get("useSSL"));
  const sslMode = sslLevel === null ? undefined : SSL_MODES[sslLevel];
  let ssh: ForeignSsh | null = null;
  if (driver === "ssh") {
    const keyFile = parameter("sshKeyFile");
    const sshUser = parameter("sshUserName");
    ssh = {
      ...splitSshHost(sshHost),
      user: sshUser,
      auth: keyFile === null ? "password" : "key",
      keyPath: keyFile,
      password:
        keyFile === null && sshUser !== null ? storePassword(windows, `ssh@${sshHost}`, sshUser) : { kind: "none" },
    };
  }
  let password: PasswordSource;
  if (legacyPassword !== undefined && legacyPassword !== "") password = { kind: "bundle", value: legacyPassword };
  else if (driver === "kerberos") password = { kind: "none" };
  else password = storePassword(windows, identifier, user);
  return {
    app: "workbench",
    id: element.attributes.id ?? `${title}#${String(index)}`,
    name,
    folder,
    driver: DATABASE_TYPE,
    url: null,
    host,
    port,
    database: parameter("schema"),
    user,
    path: null,
    ssh,
    ssl:
      sslMode === undefined
        ? null
        : {
            mode: sslMode,
            caFile: parameter("sslCA"),
            certFile: parameter("sslCert"),
            keyFile: parameter("sslKey"),
          },
    color: null,
    comment: "",
    readOnly: false,
    password,
    ...(driver === undefined
      ? { problem: `Uses the Workbench driver ${driverId || "(none)"}, which TableCraft does not import.` }
      : driver === "socket"
        ? { problem: SOCKET_PROBLEM }
        : {}),
    warnings,
  };
}

/**
 * The connections in a Workbench `connections.xml`; throws `XmlError` when it is not XML. The
 * platform decides where passwords are: the keychain on macOS and Linux, a file it cannot read on
 * Windows.
 */
export function readWorkbenchXml(text: string, platform: NodeJS.Platform): ForeignConnection[] {
  const root = parseXml(text);
  if (root.name !== "data") throw new XmlError("The file is not a MySQL Workbench connections file.");
  return connectionObjects(root).map((element, index) => toConnection(element, index, platform === "win32"));
}

/** Reads `connections.xml` from Workbench's user data directory. */
export async function scanWorkbench(environment: ImportEnvironment): Promise<WorkbenchScan> {
  const directory = workbenchDirectory(environment);
  if (directory === null) return { path: null, found: false, looked: [], connections: [] };
  const path = join(directory, WORKBENCH_CONNECTIONS_FILE);
  const text = await environment.files.readText(path);
  if (text === null) return { path: null, found: false, looked: [directory], connections: [] };
  try {
    return { path, found: true, looked: [directory], connections: readWorkbenchXml(text, environment.platform) };
  } catch (cause) {
    if (!(cause instanceof XmlError)) throw cause;
    return { path, found: true, looked: [directory], connections: [] };
  }
}
