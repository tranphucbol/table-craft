const JDBC_PREFIX = "jdbc:";
const MACRO = /\$([A-Za-z_][A-Za-z0-9_]*)\$/g;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Replaces IntelliJ path macros (`$USER_HOME$`, `$PROJECT_DIR$`, …) with their values; an unknown
 * macro stays as written so the preview shows what could not be resolved.
 */
export function expandMacros(text: string, macros: Readonly<Record<string, string>>): string {
  return text.replace(MACRO, (whole, name: string) => macros[name] ?? whole);
}

/** The URL without its `jdbc:` prefix, which the plugins' URL parser also accepts but need not see. */
export function withoutJdbc(url: string): string {
  return url.toLowerCase().startsWith(JDBC_PREFIX) ? url.slice(JDBC_PREFIX.length) : url;
}

/**
 * Oracle's JDBC forms (`oracle:thin:[user[/password]]@[//]host[:port]/service`, or
 * `…@host:port:SID`), which are no URL. The address descriptor form `@(DESCRIPTION=…)` stays as
 * written, so the preview says it could not be read.
 */
const ORACLE_THIN =
  /^oracle:(?:thin|oci):(?:([^/@:]+)(?:\/([^@]*))?)?@(?:\/\/)?([^:/?(]+)(?::(\d+))?(?:([/:])([^?]+))?$/i;

/** The Oracle plugin's URL for an Oracle JDBC URL (decision 103); other URLs as given. */
function oracleUrl(url: string): string {
  const match = ORACLE_THIN.exec(url);
  if (match === null) return url;
  const [, user, password, host = "", port, separator, target] = match;
  const credentials =
    user === undefined
      ? ""
      : `${encodeURIComponent(user)}${password === undefined ? "" : `:${encodeURIComponent(password)}`}@`;
  const address = port === undefined ? host : `${host}:${port}`;
  const path = target === undefined ? "" : `/${target}`;
  return `oracle://${credentials}${address}${path}${separator === ":" ? "?connect_by=sid" : ""}`;
}

/** The URL as a plugin's URL parser reads it: no `jdbc:` prefix, and Oracle's thin form rewritten. */
export function pluginUrl(url: string): string {
  return oracleUrl(withoutJdbc(url.trim()));
}

/** The scheme a connection URL names, lower-cased, with any `jdbc:` prefix dropped; null if none. */
export function urlScheme(url: string): string | null {
  return SCHEME.exec(withoutJdbc(url.trim()))?.[1]?.toLowerCase() ?? null;
}
