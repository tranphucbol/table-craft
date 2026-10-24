import { basename, join } from "node:path";
import { expandMacros } from "@table-craft/desktop/main/import/jdbc.js";
import type {
  ForeignConnection,
  ForeignSslMode,
  ImportEnvironment,
  PasswordSource,
} from "@table-craft/desktop/main/import/types.js";
import { child, childText, descendants, parseXml, type XmlElement } from "@table-craft/desktop/main/import/xml.js";

/**
 * Reads DataGrip's saved data sources. File names, element names and the credential service names
 * follow IntelliJ Community (Apache-2.0): `platform/credential-store/src/credentialStore/
 * CredentialAttributes.kt` (`generateServiceName`), `platform/credential-store-impl/src/
 * credentialStore/PasswordSafeSettings.kt` (`security.xml`, `PROVIDER`, `keepassDb`) and
 * `keePass/KeePassCredentialStore.kt` (`c.kdbx`, `c.pwd`).
 */
const CONFIG_DIR_PATTERN = /^DataGrip(\d+)\.(\d+)$/;
const OPTIONS = "options";
const GLOBAL_DATA_SOURCES = "dataSources.xml";
const PROJECT_DATA_SOURCES = "dataSources.xml";
const PROJECT_LOCAL_DATA_SOURCES = "dataSources.local.xml";
const IDEA_DIR = ".idea";
const PROJECT_NAME_FILE = ".name";
const PROJECTS_DIR = "projects";
const RECENT_PROJECTS = "recentProjects.xml";
const PATH_MACROS = "path.macros.xml";
const SECURITY = "security.xml";
const SSH_CONFIGS = "sshConfigs.xml";
const KEEPASS_DATABASE = "c.kdbx";
const KEEPASS_MAIN_KEY = "c.pwd";
const KEEPASS_OLD_MAIN_KEY = "pdb.pwd";
/** `generateServiceName("DB", uuid)`; the dash is U+2014. */
const DB_SERVICE_PREFIX = "IntelliJ Platform DB \u2014 ";
const NOT_SAVED = new Set(["never", "session", "until_restart", "untilrestart"]);
const NO_AUTH = "no-auth";
const DECIMAL_RADIX = 10;

export type DataGripPasswordStore =
  | { readonly kind: "native" }
  | { readonly kind: "keepass"; readonly database: string; readonly mainKey: readonly string[] }
  | { readonly kind: "memory" };

export interface DataGripScan {
  /** The newest DataGrip configuration directory, or null when none was found. */
  readonly configDir: string | null;
  /** Where the reader looked for configuration, for the "not found" card. */
  readonly looked: readonly string[];
  readonly projects: number;
  readonly connections: readonly ForeignConnection[];
  readonly passwordStore: DataGripPasswordStore;
}

/** The parent directories of `DataGrip<version>` configuration directories on this platform. */
export function dataGripRoots(environment: ImportEnvironment): string[] {
  const { platform, home, appData } = environment;
  if (platform === "darwin") return [join(home, "Library", "Application Support", "JetBrains")];
  if (platform === "win32") return appData === null ? [] : [join(appData, "JetBrains")];
  return [join(home, ".config", "JetBrains")];
}

async function readXml(environment: ImportEnvironment, path: string): Promise<XmlElement | null> {
  const text = await environment.files.readText(path);
  if (text === null) return null;
  try {
    return parseXml(text);
  } catch {
    return null;
  }
}

async function configDirs(environment: ImportEnvironment): Promise<string[]> {
  const found: { path: string; major: number; minor: number }[] = [];
  for (const root of dataGripRoots(environment)) {
    for (const name of (await environment.files.list(root)) ?? []) {
      const match = CONFIG_DIR_PATTERN.exec(name);
      if (match === null) continue;
      found.push({
        path: join(root, name),
        major: Number.parseInt(match[1] ?? "0", DECIMAL_RADIX),
        minor: Number.parseInt(match[2] ?? "0", DECIMAL_RADIX),
      });
    }
  }
  return found.sort((a, b) => b.major - a.major || b.minor - a.minor).map((entry) => entry.path);
}

async function pathMacros(environment: ImportEnvironment, configDir: string): Promise<Record<string, string>> {
  const macros: Record<string, string> = { USER_HOME: environment.home, APPLICATION_CONFIG_DIR: configDir };
  const document = await readXml(environment, join(configDir, OPTIONS, PATH_MACROS));
  for (const macro of document === null ? [] : descendants(document, "macro")) {
    const { name, value } = macro.attributes;
    if (name !== undefined && value !== undefined) macros[name] = value;
  }
  return macros;
}

async function projectDirs(environment: ImportEnvironment, configDir: string, macros: Record<string, string>) {
  const projects: string[] = [];
  const projectsRoot = join(configDir, PROJECTS_DIR);
  for (const name of (await environment.files.list(projectsRoot)) ?? []) projects.push(join(projectsRoot, name));
  const recent = await readXml(environment, join(configDir, OPTIONS, RECENT_PROJECTS));
  for (const entry of recent === null ? [] : descendants(recent, "entry")) {
    const key = entry.attributes.key;
    if (key !== undefined && key.trim() !== "") projects.push(expandMacros(key, macros));
  }
  return projects;
}

async function passwordStore(environment: ImportEnvironment, configDir: string): Promise<DataGripPasswordStore> {
  const security = await readXml(environment, join(configDir, OPTIONS, SECURITY));
  const options = security === null ? [] : descendants(security, "option");
  const option = (name: string) => options.find((candidate) => candidate.attributes.name === name)?.attributes.value;
  const provider = option("PROVIDER");
  const onWindows = environment.platform === "win32";
  if (provider === "MEMORY_ONLY" || provider === "DO_NOT_STORE") return { kind: "memory" };
  if (provider === "KEEPASS" || (onWindows && provider !== "MEMORY_ONLY")) {
    const database = option("keepassDb") ?? join(configDir, KEEPASS_DATABASE);
    const directory = database.slice(0, database.length - basename(database).length);
    return {
      kind: "keepass",
      database,
      mainKey: [join(directory, KEEPASS_MAIN_KEY), join(directory, KEEPASS_OLD_MAIN_KEY)],
    };
  }
  return { kind: "native" };
}

interface SshConfig {
  readonly host: string;
  readonly port: number | null;
}

async function sshConfigs(environment: ImportEnvironment, configDir: string): Promise<Map<string, SshConfig>> {
  const configs = new Map<string, SshConfig>();
  const document = await readXml(environment, join(configDir, OPTIONS, SSH_CONFIGS));
  for (const config of document === null ? [] : descendants(document, "sshConfig")) {
    const { id, host, port } = config.attributes;
    if (id === undefined || host === undefined) continue;
    configs.set(id, { host, port: parsePort(port) });
  }
  return configs;
}

function parsePort(text: string | undefined | null): number | null {
  if (text === undefined || text === null || text.trim() === "") return null;
  const port = Number.parseInt(text, DECIMAL_RADIX);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** The first non-empty text among the local element's child and the shared one's (local wins). */
function field(local: XmlElement | undefined, shared: XmlElement | undefined, name: string): string | null {
  for (const element of [local, shared]) {
    if (element === undefined) continue;
    const value = childText(element, name);
    if (value !== null && value !== "") return value;
  }
  return null;
}

function attribute(local: XmlElement | undefined, shared: XmlElement | undefined, name: string): string | null {
  return local?.attributes[name] ?? shared?.attributes[name] ?? null;
}

function sslMode(text: string): ForeignSslMode {
  const mode = text.toUpperCase();
  if (mode.includes("VERIFY_CA")) return "verifyCa";
  if (mode.includes("VERIFY")) return "verifyIdentity";
  if (mode.includes("PREFER")) return "preferred";
  if (mode.includes("DISABLE")) return "disabled";
  return "required";
}

function ssl(local: XmlElement | undefined, shared: XmlElement | undefined): ForeignConnection["ssl"] {
  const config =
    (local === undefined ? undefined : child(local, "ssl-config")) ??
    (shared === undefined ? undefined : child(shared, "ssl-config"));
  if (config === undefined) return null;
  if (childText(config, "enabled") === "false") return null;
  const file = (name: string): string | null => {
    const value = childText(config, name) ?? "";
    return value === "" ? null : value;
  };
  return {
    mode: sslMode(childText(config, "mode") ?? ""),
    caFile: file("ca-cert"),
    certFile: file("client-cert"),
    keyFile: file("client-key"),
  };
}

function ssh(
  local: XmlElement | undefined,
  shared: XmlElement | undefined,
  configs: ReadonlyMap<string, SshConfig>,
): ForeignConnection["ssh"] {
  const properties =
    (local === undefined ? undefined : child(local, "ssh-properties")) ??
    (shared === undefined ? undefined : child(shared, "ssh-properties"));
  if (properties === undefined || childText(properties, "enabled") !== "true") return null;
  const id = childText(properties, "ssh-config-id");
  const config = id === null ? undefined : configs.get(id);
  return config ?? { host: childText(properties, "host") ?? "", port: parsePort(childText(properties, "port")) };
}

function password(
  local: XmlElement | undefined,
  shared: XmlElement | undefined,
  uuid: string,
  user: string | null,
): PasswordSource {
  const storage = (field(local, shared, "secret-storage") ?? "").toLowerCase();
  const auth = (field(local, shared, "auth-provider") ?? "").toLowerCase();
  if (auth === NO_AUTH || NOT_SAVED.has(storage)) return { kind: "none" };
  return { kind: "store", service: `${DB_SERVICE_PREFIX}${uuid}`, user };
}

function normalizeGroup(group: string | null): string | null {
  const segments = (group ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  return segments.length === 0 ? null : segments.join("/");
}

interface Context {
  readonly macros: Readonly<Record<string, string>>;
  readonly ssh: ReadonlyMap<string, SshConfig>;
  /** The folder a data source without its own group lands in: the project's name, or none. */
  readonly folder: string | null;
}

function dataSources(document: XmlElement | null): Map<string, XmlElement> {
  const byUuid = new Map<string, XmlElement>();
  for (const element of document === null ? [] : descendants(document, "data-source")) {
    const uuid = element.attributes.uuid;
    if (uuid !== undefined && !byUuid.has(uuid)) byUuid.set(uuid, element);
  }
  return byUuid;
}

function toConnection(
  uuid: string,
  local: XmlElement | undefined,
  shared: XmlElement | undefined,
  context: Context,
): ForeignConnection {
  const url = field(local, shared, "jdbc-url");
  const user = field(local, shared, "user-name");
  const group = attribute(local, shared, "group") ?? field(local, shared, "group-name");
  return {
    app: "datagrip",
    id: uuid,
    name: attribute(local, shared, "name") ?? uuid,
    folder: normalizeGroup(group) ?? context.folder,
    driver: field(local, shared, "driver-ref"),
    url: url === null ? null : expandMacros(url, context.macros),
    host: null,
    port: null,
    database: null,
    user,
    path: null,
    ssh: ssh(local, shared, context.ssh),
    ssl: ssl(local, shared),
    color: null,
    comment: field(local, shared, "comment") ?? "",
    readOnly: attribute(local, shared, "read-only") === "true",
    password: password(local, shared, uuid, user),
  };
}

function merge(shared: XmlElement | null, local: XmlElement | null, context: Context): ForeignConnection[] {
  const sharedByUuid = dataSources(shared);
  const localByUuid = dataSources(local);
  // A data source exists where the shared file defines it; the local file only adds its fields.
  return [...sharedByUuid].map(([uuid, element]) => toConnection(uuid, localByUuid.get(uuid), element, context));
}

async function projectName(environment: ImportEnvironment, project: string): Promise<string> {
  const named = (await environment.files.readText(join(project, IDEA_DIR, PROJECT_NAME_FILE)))?.trim();
  return named === undefined || named === "" ? basename(project) : named;
}

/** Finds and reads DataGrip's data sources; reads files only, and asks no credential store. */
export async function scanDataGrip(environment: ImportEnvironment): Promise<DataGripScan> {
  const looked = dataGripRoots(environment).map((root) => join(root, "DataGrip*"));
  const dirs = await configDirs(environment);
  const newest = dirs[0];
  if (newest === undefined) {
    return { configDir: null, looked, projects: 0, connections: [], passwordStore: { kind: "native" } };
  }
  const connections: ForeignConnection[] = [];
  const seen = new Set<string>();
  const add = (found: readonly ForeignConnection[]) => {
    for (const connection of found) {
      if (seen.has(connection.id)) continue;
      seen.add(connection.id);
      connections.push(connection);
    }
  };
  const visitedProjects = new Set<string>();
  for (const configDir of dirs) {
    const macros = await pathMacros(environment, configDir);
    const sshById = await sshConfigs(environment, configDir);
    const global = await readXml(environment, join(configDir, OPTIONS, GLOBAL_DATA_SOURCES));
    add(merge(global, null, { macros, ssh: sshById, folder: null }));
    for (const project of await projectDirs(environment, configDir, macros)) {
      if (visitedProjects.has(project)) continue;
      const shared = await readXml(environment, join(project, IDEA_DIR, PROJECT_DATA_SOURCES));
      if (shared === null) continue;
      visitedProjects.add(project);
      const local = await readXml(environment, join(project, IDEA_DIR, PROJECT_LOCAL_DATA_SOURCES));
      const projectMacros = { ...macros, PROJECT_DIR: project, ProjectFileDir: project };
      const folder = await projectName(environment, project);
      add(merge(shared, local, { macros: projectMacros, ssh: sshById, folder }));
    }
  }
  return {
    configDir: newest,
    looked,
    projects: visitedProjects.size,
    connections,
    passwordStore: await passwordStore(environment, newest),
  };
}

/** Reads one `dataSources.xml` the user picked, with its `dataSources.local.xml` beside it if any. */
export async function readDataGripFile(environment: ImportEnvironment, path: string): Promise<ForeignConnection[]> {
  const shared = await readXml(environment, path);
  if (shared === null) return [];
  const directory = path.slice(0, path.length - basename(path).length);
  const local = await readXml(environment, join(directory, PROJECT_LOCAL_DATA_SOURCES));
  const project = basename(directory) === IDEA_DIR ? join(directory, "..") : directory;
  const macros = { USER_HOME: environment.home, PROJECT_DIR: project, ProjectFileDir: project };
  return merge(shared, local, { macros, ssh: new Map(), folder: await projectName(environment, project) });
}
