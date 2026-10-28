import type { ConnectionFieldKind, ConnectionUrlForm, ConnectionUrlPart } from "./manifest.js";

/** A form value as `datasources.json` holds it. */
export type ConnectionValue = string | number | boolean;

/** What a pasted connection URL fills in (decision 055). */
export interface ParsedConnectionUrl {
  /** Field key to value, for the fields the URL names; secrets are not among them. */
  readonly values: Readonly<Record<string, ConnectionValue>>;
  /** Secret field key to value, such as the password; for the secret store, never `datasources.json`. */
  readonly secrets: Readonly<Record<string, string>>;
  /** The query parameters, or their values, no field takes, as the user should see them listed. */
  readonly ignored: readonly string[];
}

/** The text is not a connection URL this plugin reads; the message says what it expected. */
export class ConnectionUrlError extends Error {
  override readonly name = "ConnectionUrlError";
}

/** A manifest's `connection.url`, read-only so a host's copy of it serves as well. */
export interface ConnectionUrlSpec {
  readonly schemes: readonly string[];
  readonly form: ConnectionUrlForm;
  readonly parts: Readonly<Partial<Record<ConnectionUrlPart, string>>>;
  readonly params?:
    | readonly {
        readonly name: string;
        readonly key: string;
        readonly values?: Readonly<Record<string, string>> | undefined;
      }[]
    | undefined;
  readonly sets?: Readonly<Record<string, Readonly<Record<string, ConnectionValue>>>> | undefined;
  readonly semicolonParams?: boolean | undefined;
}

interface UrlField {
  readonly key: string;
  readonly kind: ConnectionFieldKind;
  readonly default?: ConnectionValue | undefined;
  readonly secret?: boolean | undefined;
}

/** The part of a manifest the URL functions read: its connection fields and URL. */
export interface ConnectionForm {
  readonly connection: { readonly fields: readonly UrlField[]; readonly url?: ConnectionUrlSpec | undefined };
}

/** Tools written for the JVM prefix their URLs with it; the rest of the URL is the usual one. */
const JDBC_PREFIX = "jdbc:";
const MEMORY_PATH = ":memory:";
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const WINDOWS_DRIVE_PATH = /^\/[A-Za-z]:[/\\]/;
const LEADING_SLASHES = /^\/+/;
const LOCAL_HOSTS = new Set(["", "localhost"]);
/** `host`, `[v6]`, then SQL Server's `\instance` and the port, as the JDBC driver reads them. */
const SEMICOLON_AUTHORITY = /^(\[[^\]]*\]|[^\\:]*)(?:\\([^:]*))?(?::([^:]*))?$/;
const INSTANCE_PARAM = "instanceName";

/** libpq's names for the parts of the URL, accepted as query parameters by every server form. */
const PART_PARAMS: Readonly<Record<string, ConnectionUrlPart>> = {
  host: "host",
  port: "port",
  dbname: "database",
  database: "database",
  user: "user",
  password: "password",
};

function urlOf(form: ConnectionForm): ConnectionUrlSpec {
  const url = form.connection.url;
  if (url === undefined) throw new ConnectionUrlError("This data source type has no connection URL.");
  return url;
}

function schemeList(url: ConnectionUrlSpec): string {
  const written = url.schemes.map((scheme) => (url.form === "server" ? `${scheme}://` : `${scheme}:`));
  return written.length === 1 ? (written[0] ?? "") : `${written.slice(0, -1).join(", ")} or ${written.at(-1) ?? ""}`;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new ConnectionUrlError(`"${text}" is not valid percent-encoding; write % as %25.`);
  }
}

function fieldOf(form: ConnectionForm, key: string): UrlField | undefined {
  return form.connection.fields.find((field) => field.key === key);
}

function coerced(field: UrlField | undefined, raw: string, label: string): ConnectionValue {
  if (field?.kind === "number") {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value))
      throw new ConnectionUrlError(`The ${label} "${raw}" is not a number.`);
    return value;
  }
  if (field?.kind === "checkbox") return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  return raw;
}

class Collected {
  readonly values: Record<string, ConnectionValue> = {};
  readonly secrets: Record<string, string> = {};
  readonly ignored: string[] = [];

  constructor(
    private readonly form: ConnectionForm,
    private readonly url: ConnectionUrlSpec,
  ) {}

  part(part: ConnectionUrlPart, raw: string): void {
    const key = this.url.parts[part];
    if (key === undefined || raw === "") return;
    const field = fieldOf(this.form, key);
    if (field?.secret === true) this.secrets[key] = raw;
    else this.values[key] = coerced(field, raw, part);
  }

  param(name: string, raw: string): void {
    const lower = name.toLowerCase();
    const param = this.url.params?.find((candidate) => candidate.name.toLowerCase() === lower);
    if (param === undefined) {
      const part = this.url.form === "server" ? PART_PARAMS[lower] : undefined;
      if (part !== undefined && this.url.parts[part] !== undefined) this.part(part, raw);
      else this.ignored.push(name);
      return;
    }
    if (param.values === undefined) {
      this.values[param.key] = coerced(fieldOf(this.form, param.key), raw, name);
      return;
    }
    const match = Object.entries(param.values).find(([value]) => value.toLowerCase() === raw.toLowerCase());
    if (match === undefined) this.ignored.push(`${name}=${raw}`);
    else this.values[param.key] = match[1];
  }

  query(search: string): void {
    for (const [name, value] of new URLSearchParams(search)) this.param(name, value);
  }

  done(): ParsedConnectionUrl {
    return { values: this.values, secrets: this.secrets, ignored: this.ignored };
  }
}

function parseServer(form: ConnectionForm, url: ConnectionUrlSpec, text: string): ParsedConnectionUrl {
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === undefined || !url.schemes.includes(scheme) || !text.slice(scheme.length + 1).startsWith("//")) {
    throw new ConnectionUrlError(`Expected a URL starting with ${schemeList(url)}.`);
  }
  if (url.semicolonParams === true) return parseSemicolon(form, url, scheme, text);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ConnectionUrlError(
      `That is not a valid ${scheme}:// URL; check the port is a number and special characters are percent-encoded.`,
    );
  }
  const collected = new Collected(form, url);
  Object.assign(collected.values, url.sets?.[scheme]);
  collected.part("host", decoded(parsed.hostname.replace(/^\[(.*)\]$/, "$1")));
  collected.part("port", parsed.port);
  collected.part("database", decoded(parsed.pathname.replace(LEADING_SLASHES, "")));
  collected.part("user", decoded(parsed.username));
  collected.part("password", decoded(parsed.password));
  collected.query(parsed.search);
  return collected.done();
}

/** Splits on `;` outside `{…}`, which the JDBC driver uses to put a `;` in a value. */
function semicolonPairs(text: string): string[] {
  const pairs: string[] = [];
  let current = "";
  let braced = false;
  for (const char of text) {
    if (char === "{") braced = true;
    else if (char === "}") braced = false;
    if (char === ";" && !braced) {
      pairs.push(current);
      current = "";
    } else current += char;
  }
  pairs.push(current);
  return pairs.filter((pair) => pair.trim() !== "");
}

function unbraced(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed.slice(1, -1) : trimmed;
}

function parseSemicolon(
  form: ConnectionForm,
  url: ConnectionUrlSpec,
  scheme: string,
  text: string,
): ParsedConnectionUrl {
  const [authority = "", ...pairs] = semicolonPairs(text.slice(scheme.length + "://".length));
  const match = SEMICOLON_AUTHORITY.exec(authority.trim());
  if (match === null) {
    throw new ConnectionUrlError(`"${authority}" is not host, host\\instance or host:port.`);
  }
  const [, host = "", instance, port] = match;
  if (port !== undefined && !/^\d+$/.test(port)) {
    throw new ConnectionUrlError(`The port "${port}" is not a number.`);
  }
  const collected = new Collected(form, url);
  Object.assign(collected.values, url.sets?.[scheme]);
  collected.part("host", host.replace(/^\[(.*)\]$/, "$1"));
  if (port !== undefined) collected.part("port", port);
  if (instance !== undefined && instance !== "") collected.param(INSTANCE_PARAM, instance);
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals < 0) collected.ignored.push(pair.trim());
    else collected.param(pair.slice(0, equals).trim(), unbraced(pair.slice(equals + 1)));
  }
  return collected.done();
}

function parseFile(form: ConnectionForm, url: ConnectionUrlSpec, text: string): ParsedConnectionUrl {
  const collected = new Collected(form, url);
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  // One letter before the colon is a Windows drive, not a scheme.
  if (scheme === undefined || scheme.length === 1 || text === MEMORY_PATH) {
    collected.part("path", text);
    return collected.done();
  }
  if (!url.schemes.includes(scheme)) {
    throw new ConnectionUrlError(`Expected a file path, or a URL starting with ${schemeList(url)}.`);
  }
  let rest = text.slice(scheme.length + 1);
  const queryAt = rest.search(/[?#]/);
  if (queryAt >= 0) {
    const query = rest.slice(queryAt);
    rest = rest.slice(0, queryAt);
    if (query.startsWith("?")) collected.query(query.split("#")[0] ?? "");
  }
  if (rest.startsWith("//")) {
    const authorityEnd = rest.indexOf("/", 2);
    const authority = authorityEnd < 0 ? rest.slice(2) : rest.slice(2, authorityEnd);
    if (authority === MEMORY_PATH) rest = MEMORY_PATH;
    else if (!LOCAL_HOSTS.has(authority.toLowerCase())) {
      throw new ConnectionUrlError(`"${authority}" names another machine; a file URL reads a local file.`);
    } else rest = authorityEnd < 0 ? "" : rest.slice(authorityEnd).replace(LEADING_SLASHES, "/");
  }
  const path = decoded(rest);
  collected.part("path", WINDOWS_DRIVE_PATH.test(path) ? path.slice(1) : path);
  return collected.done();
}

/**
 * Reads `text` as the plugin's connection URL: `scheme://user:password@host:port/database?params`
 * for a server, or a path, bare or as a `sqlite:`/`file:` URL, for a file. A `jdbc:` prefix is
 * dropped. Throws `ConnectionUrlError` when it is none.
 */
export function parseConnectionUrl(form: ConnectionForm, text: string): ParsedConnectionUrl {
  const url = urlOf(form);
  let trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith(JDBC_PREFIX)) trimmed = trimmed.slice(JDBC_PREFIX.length);
  if (trimmed === "") throw new ConnectionUrlError(`Expected a URL starting with ${schemeList(url)}.`);
  return url.form === "server" ? parseServer(form, url, trimmed) : parseFile(form, url, trimmed);
}

function isConnectionValue(value: unknown): value is ConnectionValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function written(value: ConnectionValue): string {
  return String(value);
}

function bracedValue(value: string): string {
  return /[;{}=]/.test(value) || value !== value.trim() ? `{${value}}` : value;
}

/** Every parameter after a `;`, one per field, so a part a parameter also names is written once. */
function semicolonUrl(
  form: ConnectionForm,
  url: ConnectionUrlSpec,
  scheme: string,
  config: Readonly<Record<string, unknown>>,
): string {
  const text = (key: string | undefined): string => {
    if (key === undefined || fieldOf(form, key)?.secret === true) return "";
    const value = config[key];
    return isConnectionValue(value) ? written(value) : "";
  };
  const host = text(url.parts.host);
  const port = text(url.parts.port);
  const pairs: string[] = [];
  const keys = new Set([url.parts.host, url.parts.port]);
  for (const param of url.params ?? []) {
    if (keys.has(param.key)) continue;
    keys.add(param.key);
    const value = config[param.key];
    const field = fieldOf(form, param.key);
    if (field?.secret === true || !isConnectionValue(value) || value === "" || value === field?.default) continue;
    const shown =
      param.values === undefined
        ? written(value)
        : Object.entries(param.values).find(([, mapped]) => mapped === value)?.[0];
    if (shown !== undefined) pairs.push(`;${param.name}=${bracedValue(shown)}`);
  }
  return `${scheme}://${host.includes(":") ? `[${host}]` : host}${port === "" ? "" : `:${port}`}${pairs.join("")}`;
}

function encodedPath(path: string): string {
  return encodeURI(path).replaceAll("?", "%3F").replaceAll("#", "%23");
}

/**
 * The connection URL of `config`, in the first scheme whose `sets` the config holds, else the first
 * that sets nothing. Never carries a secret field, so
 * the result is safe to copy, show and log; params equal to their field's default are left out.
 */
export function formatConnectionUrl(form: ConnectionForm, config: Readonly<Record<string, unknown>>): string {
  const url = urlOf(form);
  const implied = (candidate: string): boolean => {
    const sets = url.sets?.[candidate];
    return sets !== undefined && Object.entries(sets).every(([key, value]) => config[key] === value);
  };
  const scheme =
    url.schemes.find(implied) ??
    url.schemes.find((candidate) => url.sets?.[candidate] === undefined) ??
    url.schemes[0] ??
    "";
  if (url.semicolonParams === true) return semicolonUrl(form, url, scheme, config);
  const valueOf = (part: ConnectionUrlPart): string => {
    const key = url.parts[part];
    if (key === undefined || fieldOf(form, key)?.secret === true) return "";
    const value = config[key];
    return isConnectionValue(value) ? written(value) : "";
  };
  const params = new URLSearchParams();
  for (const param of url.params ?? []) {
    const value = config[param.key];
    const field = fieldOf(form, param.key);
    if (field?.secret === true || !isConnectionValue(value) || value === "" || value === field?.default) continue;
    const text =
      param.values === undefined
        ? written(value)
        : Object.entries(param.values).find(([, mapped]) => mapped === value)?.[0];
    if (text !== undefined) params.append(param.name, text);
  }
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  if (url.form === "file") {
    const path = valueOf("path");
    if (path === MEMORY_PATH || !path.startsWith("/")) return `${scheme}:${encodedPath(path)}${query}`;
    return `${scheme}://${encodedPath(path)}${query}`;
  }
  const user = valueOf("user");
  const host = valueOf("host");
  const port = valueOf("port");
  const database = valueOf("database");
  const authority = `${user === "" ? "" : `${encodeURIComponent(user)}@`}${host.includes(":") ? `[${host}]` : encodeURIComponent(host)}${port === "" ? "" : `:${port}`}`;
  return `${scheme}://${authority}${database === "" ? "" : `/${encodeURIComponent(database)}`}${query}`;
}
