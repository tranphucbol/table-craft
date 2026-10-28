import type { SavepointStatements, SqlLanguage, WireValue } from "@table-craft/plugin-api";
import {
  classifyTokens,
  defaultKeyword,
  defaultValuesInsert,
  identifierWriter,
  namespaceSwitcher,
  quoteIdentifierWith,
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
  type ParameterOptions,
  type SqlDialectOptions,
  type SqlLiteralOptions,
} from "@table-craft/plugin-api/sql";
import { MSSQL_IMPORT_TYPES, mssqlDecimal } from "./bulk.js";
import { EXPLAIN_VERBS } from "./explain.js";
import { MSSQL_FUNCTIONS } from "./functions/index.js";
import { mssqlObjects, nationalText } from "./objects.js";
import { MSSQL_KEYWORDS, MSSQL_RESERVED_WORDS } from "./reserved.js";
import { mssqlRoutineCall } from "./routines.js";
import { serverIdentity } from "./server.js";

/** T-SQL: `[name]` quotes, `N'…'` strings, `@local`, `@@global` and `#temp` words, `GO` lines (decision 125). */
export const DIALECT: SqlDialectOptions = {
  bracketIdentifiers: true,
  batchSeparator: "go",
  namespaceStatements: ["use"],
  nationalStrings: true,
  variables: true,
};

const PARAMETERS: ParameterOptions = { dialect: DIALECT, styles: ["named", "positional"], native: "atNumbered" };

const LITERALS: SqlLiteralOptions = { backslashEscapes: false, bytes: (hex) => `0x${hex}`, nationalText: true };

export const quoteIdentifier = quoteIdentifierWith("[");

/** Unquoted names keep their case, and `@`, `#` and `$` may follow the first letter. */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_@#$]*$/;
const KEYWORDS: readonly string[] = [...new Set([...SQL_KEYWORDS, ...MSSQL_KEYWORDS])];
/** A reserved word is quoted wherever it names something; other keywords read back as names. */
const QUOTED_WORDS: readonly string[] = [...MSSQL_RESERVED_WORDS];
export const writeName = identifierWriter({
  quoteIdentifier,
  plainIdentifier: PLAIN_IDENTIFIER,
  keywords: QUOTED_WORDS,
});

const { explainable } = sqlExplainable({
  dialect: DIALECT,
  name: "SQL Server",
  verbs: EXPLAIN_VERBS,
  analyzeVerbs: EXPLAIN_VERBS,
});

const COMPLETER: CompleterOptions = {
  dialect: DIALECT,
  identifierFolding: "none",
  plainIdentifier: PLAIN_IDENTIFIER,
  quoteIdentifier,
  keywords: KEYWORDS,
  functions: MSSQL_FUNCTIONS,
  server: serverIdentity,
};

/** `bit` reads `1` and `0`; SQL Server has no `TRUE` or `FALSE`. */
function literal(value: WireValue): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return sqlLiteral(value, LITERALS);
}

/**
 * SQL Server names savepoints with `SAVE TRANSACTION`, which needs a transaction to be open, and
 * releases none: a savepoint lives until its transaction ends, so `release` is a no-op batch.
 */
function savepoint(name: string): SavepointStatements {
  const quoted = quoteIdentifier(name);
  return {
    set: `IF @@TRANCOUNT = 0 BEGIN TRANSACTION;\nSAVE TRANSACTION ${quoted}`,
    rollback: `IF XACT_STATE() = 1 ROLLBACK TRANSACTION ${quoted}`,
    release: `-- SQL Server keeps savepoint ${quoted} until the transaction ends`,
  };
}

export const language: SqlLanguage = {
  split: sqlSplitter(DIALECT),
  splitStream: sqlStatementStream(DIALECT),
  classify: (sql) => classifyTokens(sql, DIALECT),
  quoteIdentifier,
  literal,
  emptyInsert: defaultValuesInsert,
  updateDefault: defaultKeyword,
  savepoint,
  ...sqlCompleter(COMPLETER),
  ...sqlInspector({ ...COMPLETER, reservedWords: MSSQL_RESERVED_WORDS }),
  ...sqlGenerator({
    quoteIdentifier,
    updateDefault: defaultKeyword,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: QUOTED_WORDS,
  }),
  explainable,
  ...sqlFormatter({ dialect: "transactsql", lexer: DIALECT, parameters: PARAMETERS.styles }),
  ...sqlParameters(PARAMETERS),
  ...sqlImporter({
    quoteIdentifier,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: QUOTED_WORDS,
    types: MSSQL_IMPORT_TYPES,
    decimal: mssqlDecimal,
  }),
  namespaceSwitch: namespaceSwitcher("use", quoteIdentifier),
  objects: mssqlObjects({ name: writeName, quoteIdentifier }),
  routineCall: mssqlRoutineCall(writeName),
};

export { nationalText };
