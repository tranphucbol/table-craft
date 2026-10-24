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

/** The scheme a connection URL names, lower-cased, with any `jdbc:` prefix dropped; null if none. */
export function urlScheme(url: string): string | null {
  return SCHEME.exec(withoutJdbc(url.trim()))?.[1]?.toLowerCase() ?? null;
}
