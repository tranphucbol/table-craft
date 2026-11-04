import type { InferredColumn, PluginLanguage } from "@table-craft/plugin-api";
import {
  classifyTokens,
  defaultKeyword,
  defaultValuesInsert,
  quoteIdentifierWith,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  sqlCompleter,
  sqlExplainable,
  sqlFormatter,
  sqlGenerator,
  sqlImporter,
  sqlInspector,
  sqlLiteral,
  sqlParameters,
  sqlSplitter,
  sqlStatementStream,
  type CompleterOptions,
  type FunctionSpec,
  type ParameterOptions,
  type SqlDialectOptions,
  type SqlLiteralOptions,
} from "@table-craft/plugin-api/sql";
import { EXPLAIN_VERBS } from "./explain.js";
import { DUCKDB_FUNCTIONS, DUCKDB_RESERVED_WORDS } from "./vocabulary.generated.js";

export const CAPABILITIES = [
  "sql",
  "cancel",
  "schemaTree",
  "transactions",
  "ddl",
  "explain",
  "explainAnalyze",
  "bulkInsert",
] as const;

export type DuckdbCapability = (typeof CAPABILITIES)[number];

/** DuckDB reads PostgreSQL's lexis: dollar quotes and nested block comments. */
export const DIALECT: SqlDialectOptions = { dollarQuotes: true, nestedBlockComments: true };

const PARAMETERS: ParameterOptions = {
  dialect: DIALECT,
  styles: ["named", "positional", "numbered"],
  native: "numbered",
};

const LITERALS: SqlLiteralOptions = { backslashEscapes: false, bytes: (hex) => `from_hex('${hex}')` };

export const quoteIdentifier = quoteIdentifierWith('"');

/** DuckDB matches unquoted names without regard to case and keeps the case they were created in. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const KEYWORDS: readonly string[] = [
  ...SQL_KEYWORDS,
  "ATTACH",
  "COPY",
  "DESCRIBE",
  "DETACH",
  "EXCLUDE",
  "ILIKE",
  "INSTALL",
  "LATERAL",
  "LOAD",
  "PIVOT",
  "QUALIFY",
  "RETURNING",
  "SUMMARIZE",
  "UNPIVOT",
];

/** DuckDB's catalog documents the shared functions too; its words win, the shared list fills gaps. */
const FUNCTIONS: readonly FunctionSpec[] = [
  ...DUCKDB_FUNCTIONS,
  ...SQL_FUNCTIONS.filter((shared) => !DUCKDB_FUNCTIONS.some((own) => own.name === shared.name)),
];

/** DuckDB's widest exact decimal; anything wider imports as `DOUBLE`. */
const MAX_DECIMAL_PRECISION = 38;

export const IMPORT_TYPES = {
  boolean: "BOOLEAN",
  integer: "INTEGER",
  bigint: "BIGINT",
  double: "DOUBLE",
  date: "DATE",
  timestamp: "TIMESTAMP",
  text: "VARCHAR",
} as const;

/** A bare `DECIMAL` is `DECIMAL(18,3)` in DuckDB and would cut digits, so the sample sizes it. */
export function duckdbDecimal(column: InferredColumn): string {
  const precision = Math.max(column.integerDigits + column.scale, 1);
  if (precision > MAX_DECIMAL_PRECISION) return IMPORT_TYPES.double;
  return `DECIMAL(${String(precision)},${String(column.scale)})`;
}

const COMPLETER: CompleterOptions = {
  dialect: DIALECT,
  identifierFolding: "none",
  plainIdentifier: PLAIN_IDENTIFIER,
  quoteIdentifier,
  keywords: KEYWORDS,
  functions: FUNCTIONS,
};

export const language: PluginLanguage<DuckdbCapability> = {
  split: sqlSplitter(DIALECT),
  splitStream: sqlStatementStream(DIALECT),
  classify: (sql) => classifyTokens(sql, DIALECT),
  quoteIdentifier,
  literal: (value) => sqlLiteral(value, LITERALS),
  emptyInsert: defaultValuesInsert,
  updateDefault: defaultKeyword,
  ...sqlCompleter(COMPLETER),
  ...sqlInspector({ ...COMPLETER, reservedWords: DUCKDB_RESERVED_WORDS }),
  ...sqlGenerator({
    quoteIdentifier,
    updateDefault: defaultKeyword,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: KEYWORDS,
  }),
  ...sqlFormatter({ dialect: "duckdb", lexer: DIALECT, parameters: PARAMETERS.styles }),
  ...sqlParameters(PARAMETERS),
  services: {
    explain: sqlExplainable({ dialect: DIALECT, name: "DuckDB", verbs: EXPLAIN_VERBS, analyzeVerbs: EXPLAIN_VERBS }),
    bulkInsert: sqlImporter({
      quoteIdentifier,
      plainIdentifier: PLAIN_IDENTIFIER,
      keywords: KEYWORDS,
      types: IMPORT_TYPES,
      decimal: duckdbDecimal,
    }),
  },
};
