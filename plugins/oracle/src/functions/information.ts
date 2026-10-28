import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { FROM_21, FROM_23 } from "./ranges.js";

/**
 * Environment, identifier and container functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html,
 * https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/Single-Row-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Single-Row-Functions.html.
 */
export const INFORMATION_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("information", [
  ["CON_DBID_TO_ID", "dbid -> number", "The container id of a pluggable database's DBID."],
  ["CON_GUID_TO_ID", "guid -> number", "The container id of a pluggable database's GUID."],
  ["CON_ID_TO_CON_NAME", "con_id -> string", "The name of a container id."],
  ["CON_ID_TO_DBID", "con_id -> number", "The DBID of a container id."],
  ["CON_ID_TO_GUID", "con_id -> raw", "The GUID of a container id.", FROM_21],
  ["CON_ID_TO_UID", "con_id -> number", "The unique id of a container id.", FROM_21],
  ["CON_NAME_TO_ID", "name -> number", "The container id of a container name."],
  ["CON_UID_TO_ID", "uid -> number", "The container id of a container's unique id."],
  [
    "ORA_CHECK_DATA_PRIVILEGE",
    "object, SELECT|INSERT|UPDATE|DELETE, column? -> boolean",
    "Whether the end user holds a data privilege on the row, or on one of its columns.",
    FROM_23,
  ],
  [
    "ORA_END_USER_CONTEXT",
    "= json",
    "The end user's security context as JSON, or one attribute after a dot path; written without parentheses.",
    FROM_23,
  ],
  ["ORA_INVOKING_USER", "= string", "The user who invoked the current statement or view, written without parentheses."],
  [
    "ORA_INVOKING_USERID",
    "= number",
    "The id of the user who invoked the current statement, written without parentheses.",
  ],
  [
    "ORA_IS_COLUMN_AUTHORIZED",
    "column, privilege? -> boolean",
    "Whether the end user may see a column's value in the row, telling a hidden value from a real null.",
    FROM_23,
  ],
  [
    "SYS_CONTEXT",
    "namespace, parameter, length? -> string",
    "A value from an application context; 'USERENV' holds the session's user, schema, host and more.",
  ],
  ["SYS_GUID", "-> raw", "A new 16-byte globally unique identifier."],
  [
    "SYS_ROW_ETAG",
    "column... -> raw",
    "A hash of some columns of the row, to detect a concurrent change without locking.",
    FROM_23,
  ],
  ["UID", "= number", "The current user's id, written without parentheses."],
  ["USER", "= string", "The name of the user the session logged in as, written without parentheses."],
  [
    "USERENV",
    "parameter -> string",
    "Session information such as 'LANG' or 'SID'; prefer SYS_CONTEXT('USERENV', ...).",
  ],
]);
