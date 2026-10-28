import type { StatementClass } from "@table-craft/plugin-api";
import {
  classifyTokens,
  transactionEffect,
  type SqlDialectOptions,
  type TransactionEffect,
} from "@table-craft/plugin-api/sql";

/**
 * Oracle's lexical rules: `q'[…]'` and `N'…'` literals, PL/SQL units and anonymous blocks running to
 * a `/` line as SQL*Plus sends them, and `ALTER SESSION SET CURRENT_SCHEMA` switching the schema.
 */
export const DIALECT: SqlDialectOptions = {
  batchSeparator: "slash",
  qQuotes: true,
  nationalStrings: true,
  namespaceStatements: ["alterSessionSchema"],
};

const WORD = /[A-Za-z_][A-Za-z0-9_$#]*/g;
/** What may precede the unit kind: `CREATE OR REPLACE EDITIONABLE PACKAGE BODY`. */
const UNIT_HEAD = new Set(["CREATE", "OR", "REPLACE", "EDITIONABLE", "NONEDITIONABLE", "EDITIONING"]);
const PLSQL_UNITS = new Set(["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "LIBRARY"]);
const BLOCK_STARTS = new Set(["DECLARE", "BEGIN"]);
const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const TRAILING_TERMINATOR = /[\s;]+$/;

/** The first words of `sql`, upper case, comments skipped; enough to tell PL/SQL from SQL. */
function leadingWords(sql: string, count: number): string[] {
  const body = sql.replace(LEADING_COMMENTS, "");
  return (body.slice(0, 200).match(WORD) ?? []).slice(0, count).map((word) => word.toUpperCase());
}

/** An anonymous block or a stored PL/SQL unit, whose text ends with its own `;`. */
export function isPlsql(sql: string): boolean {
  const words = leadingWords(sql, 6);
  const [first] = words;
  if (first === undefined) return false;
  if (BLOCK_STARTS.has(first)) return true;
  if (first !== "CREATE") return false;
  const kind = words.find((word) => !UNIT_HEAD.has(word));
  return kind !== undefined && PLSQL_UNITS.has(kind);
}

/**
 * The text the server is sent: a SQL statement loses its trailing `;`, which Oracle refuses
 * (ORA-00933), while a PL/SQL unit or block keeps it, as its grammar needs.
 */
export function serverText(sql: string): string {
  if (isPlsql(sql)) return sql.trimEnd();
  return sql.replace(TRAILING_TERMINATOR, "");
}

/** The first words of a statement, for the dispatch `execute` does before sending it. */
export function statementWords(sql: string, count = 4): string[] {
  return leadingWords(sql, count);
}

/**
 * The shared classifier with Oracle's differences: a PL/SQL block (`BEGIN`, `DECLARE`) is not a
 * transaction statement, `SET TRANSACTION` is one, and `ALTER SESSION` changes no schema object.
 */
export function classify(sql: string): StatementClass {
  const [first, second] = leadingWords(sql, 2);
  const base = classifyTokens(sql, DIALECT);
  if (first !== undefined && BLOCK_STARTS.has(first)) return { ...base, kind: "other", destructive: null };
  if (first === "SET" && second === "TRANSACTION") return { ...base, kind: "transaction" };
  if (first === "ALTER" && second === "SESSION") return { ...base, kind: "other", destructive: null };
  return base;
}

/**
 * `SET TRANSACTION` opens a transaction and `COMMIT` or `ROLLBACK` ends it. `BEGIN` opens a PL/SQL
 * block, not a transaction; the DDL that commits implicitly is the session's to track.
 */
export function oracleTransactionEffect(sql: string): TransactionEffect | null {
  const [first, second] = leadingWords(sql, 2);
  if (first === undefined || BLOCK_STARTS.has(first) || first === "END") return null;
  if (first === "SET") return second === "TRANSACTION" ? "begin" : null;
  return transactionEffect(sql, DIALECT);
}
