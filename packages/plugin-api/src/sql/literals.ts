import type { SavepointStatements, WireValue } from "@table-craft/plugin-api";

/** How a dialect spells what the shared literal writer cannot decide for it. */
export interface SqlLiteralOptions {
  /** `'` doubled is standard; MySQL also needs backslashes escaped unless `NO_BACKSLASH_ESCAPES` is set. */
  readonly backslashEscapes: boolean;
  /** A bytes literal from lower-case hex, such as `X'dead'` or `'\xdead'::bytea`. */
  readonly bytes: (hex: string) => string;
  /** Text holding a non-ASCII character is written `N'…'`, which SQL Server and Oracle need to keep it whole. */
  readonly nationalText?: boolean;
}

export type IdentifierQuote = '"' | "`" | "[";

const CLOSING_QUOTE: Readonly<Record<IdentifierQuote, string>> = { '"': '"', "`": "`", "[": "]" };

/**
 * Quotes an identifier with `quote`, doubling the closing quote inside it: `"a""b"`, `` `a``b` ``
 * or SQL Server's `[a]]b]`.
 */
export function quoteIdentifierWith(quote: IdentifierQuote): (name: string) => string {
  const close = CLOSING_QUOTE[quote];
  return (name) => `${quote}${name.replaceAll(close, close + close)}${close}`;
}

/** The standard savepoint statements, which PostgreSQL, MySQL and SQLite all accept (plan 026). */
export function sqlSavepoints(quoteIdentifier: (name: string) => string): (name: string) => SavepointStatements {
  return (name) => {
    const quoted = quoteIdentifier(name);
    return {
      set: `SAVEPOINT ${quoted}`,
      rollback: `ROLLBACK TO SAVEPOINT ${quoted}`,
      release: `RELEASE SAVEPOINT ${quoted}`,
    };
  };
}

/** The standard insert of a row made only of defaults, which PostgreSQL and SQLite accept. */
export function defaultValuesInsert(qualifiedTable: string): string {
  return `INSERT INTO ${qualifiedTable} DEFAULT VALUES`;
}

/** `DEFAULT` inside `SET`, which PostgreSQL and MySQL accept. */
export function defaultKeyword(): string {
  return "DEFAULT";
}

const BACKSLASH_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\", "\\\\"],
  ["'", "\\'"],
  ["\0", "\\0"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\u001a", "\\Z"],
]);

const NATIONAL_PREFIX = "N";
const NON_ASCII = /[\u0080-\uffff]/;

function quoteString(text: string, options: SqlLiteralOptions): string {
  const prefix = options.nationalText === true && NON_ASCII.test(text) ? NATIONAL_PREFIX : "";
  if (options.backslashEscapes) {
    return `${prefix}'${Array.from(text, (char) => BACKSLASH_ESCAPES.get(char) ?? char).join("")}'`;
  }
  return `${prefix}'${text.replaceAll("'", "''")}'`;
}

const BYTES_PER_HEX_DIGIT = 0.5;

/**
 * A literal any of the three built-in dialects reads back as the same value. Decimals, dates and
 * JSON travel as text (decision 017), so they are written as strings and the column's type
 * converts them; `columnType` is accepted for dialects that need a cast.
 */
export function sqlLiteral(value: WireValue, options: SqlLiteralOptions): string {
  if (value === null) return "NULL";
  switch (typeof value) {
    case "boolean":
      return value ? "TRUE" : "FALSE";
    case "number":
      return Number.isFinite(value) ? String(value) : quoteString(String(value), options);
    case "string":
      return quoteString(value, options);
    default:
      break;
  }
  switch (value.kind) {
    case "bigint":
      return value.value;
    case "json":
      return quoteString(value.text, options);
    case "date":
      return quoteString(value.iso, options);
    case "bytes": {
      const literal = options.bytes(value.preview);
      const shown = value.preview.length * BYTES_PER_HEX_DIGIT;
      return shown < value.length ? `${literal} /* ${String(shown)} of ${String(value.length)} bytes */` : literal;
    }
  }
}
