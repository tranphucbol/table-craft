import type { SqlLanguage } from "@table-craft/plugin-api";
import {
  defaultKeyword,
  defaultValuesInsert,
  identifierWriter,
  namespaceSwitcher,
  quoteIdentifierWith,
  sqlSavepoints,
  SQL_KEYWORDS,
  sqlCompleter,
  sqlInspector,
  sqlExplainable,
  sqlFormatter,
  sqlGenerator,
  sqlImporter,
  sqlLiteral,
  sqlParameters,
  sqlSplitter,
  sqlStatementStream,
  type CompleterOptions,
  type ParameterOptions,
  type SqlLiteralOptions,
} from "@table-craft/plugin-api/sql";
import { ORACLE_IMPORT_TYPES, oracleDecimal } from "./bulk.js";
import { EXPLAIN_VERBS } from "./explain.js";
import { ORACLE_FUNCTIONS } from "./functions/index.js";
import { oracleObjects } from "./objects.js";
import { ORACLE_KEYWORDS, ORACLE_RESERVED_WORDS } from "./reserved.js";
import { oracleRoutineCall } from "./routines.js";
import { serverIdentity } from "./server.js";
import { classify, DIALECT } from "./statements.js";

/** node-oracledb binds `:1`, `:2` by the order they occur, so the console's names become those. */
export const PARAMETERS: ParameterOptions = { dialect: DIALECT, styles: ["named"], native: "colonNumbered" };

const LITERALS: SqlLiteralOptions = {
  backslashEscapes: false,
  bytes: (hex) => `HEXTORAW('${hex}')`,
  nationalText: true,
};

export const quoteIdentifier = quoteIdentifierWith('"');

/** A lower-case letter would fold to upper case unquoted, so only upper case reads back as written. */
export const PLAIN_IDENTIFIER = /^[A-Z][A-Z0-9_$#]*$/;
const KEYWORDS: readonly string[] = [...SQL_KEYWORDS, ...ORACLE_KEYWORDS];
export const writeName = identifierWriter({ quoteIdentifier, plainIdentifier: PLAIN_IDENTIFIER, keywords: KEYWORDS });
/**
 * A file's column names are what the user typed, not stored names: `name` is written unquoted, so
 * the table gets `NAME` as every Oracle tool would make it, and the rows go to it the same way.
 */
const IMPORT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_$#]*$/;
export const importName = identifierWriter({ quoteIdentifier, plainIdentifier: IMPORT_IDENTIFIER, keywords: KEYWORDS });

export const { explainable } = sqlExplainable({
  dialect: DIALECT,
  name: "Oracle",
  verbs: EXPLAIN_VERBS,
  analyzeVerbs: EXPLAIN_VERBS,
});

const COMPLETER: CompleterOptions = {
  dialect: DIALECT,
  identifierFolding: "upper",
  plainIdentifier: PLAIN_IDENTIFIER,
  quoteIdentifier,
  keywords: KEYWORDS,
  functions: ORACLE_FUNCTIONS,
  server: serverIdentity,
};

/** Text literal of `value`, `N'…'` when it holds characters outside ASCII. */
export function textLiteral(value: string): string {
  return sqlLiteral(value, LITERALS);
}

export const language: SqlLanguage = {
  split: sqlSplitter(DIALECT),
  splitStream: sqlStatementStream(DIALECT),
  classify,
  quoteIdentifier,
  literal: (value) => sqlLiteral(value, LITERALS),
  /** Oracle has no `DEFAULT VALUES`; the session rewrites it to name one column `DEFAULT`. */
  emptyInsert: defaultValuesInsert,
  updateDefault: defaultKeyword,
  savepoint: sqlSavepoints(quoteIdentifier),
  ...sqlCompleter(COMPLETER),
  ...sqlInspector({ ...COMPLETER, reservedWords: ORACLE_RESERVED_WORDS }),
  ...sqlGenerator({
    quoteIdentifier,
    updateDefault: defaultKeyword,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: KEYWORDS,
  }),
  explainable,
  ...sqlFormatter({ dialect: "plsql", lexer: DIALECT, parameters: PARAMETERS.styles }),
  ...sqlParameters(PARAMETERS),
  ...sqlImporter({
    quoteIdentifier,
    plainIdentifier: IMPORT_IDENTIFIER,
    keywords: KEYWORDS,
    types: ORACLE_IMPORT_TYPES,
    decimal: oracleDecimal,
  }),
  namespaceSwitch: namespaceSwitcher("alterSessionSchema", quoteIdentifier),
  objects: oracleObjects({ name: writeName, text: textLiteral }),
  routineCall: oracleRoutineCall(writeName),
};
