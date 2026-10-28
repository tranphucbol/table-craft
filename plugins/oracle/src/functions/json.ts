import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { FROM_21 } from "./ranges.js";

/**
 * JSON functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/JSON-Functions.html,
 * https://docs.oracle.com/en/database/oracle/oracle-database/21/sqlrf/JSON-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/JSON-Functions.html.
 */
export const JSON_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("json", [
  ["JSON", "expr -> json", "Text or a value read as the JSON type.", FROM_21],
  [
    "JSON_ARRAY",
    ["element... -> json", "element... RETURNING type -> json"],
    "A JSON array of its arguments; nulls are left out unless NULL ON NULL is given.",
  ],
  [
    "JSON_ARRAYAGG",
    ["expr -> json", "expr RETURNING type -> json"],
    "The group's values as one JSON array, in an optional ORDER BY order.",
  ],
  [
    "JSON_DATAGUIDE",
    "json, format?, flags? -> clob",
    "A description of the paths and types found in the group's JSON documents.",
  ],
  [
    "JSON_MERGEPATCH",
    ["target, patch -> json", "target, patch RETURNING type -> json"],
    "A JSON document updated by an RFC 7396 merge patch.",
  ],
  [
    "JSON_OBJECT",
    ["KEY key VALUE value... -> json", "key VALUE value... -> json", "* -> json"],
    "A JSON object of key and value pairs; key : value also works.",
  ],
  [
    "JSON_OBJECTAGG",
    ["KEY key VALUE value -> json", "key VALUE value -> json"],
    "The group's key and value pairs as one JSON object.",
  ],
  [
    "JSON_QUERY",
    ["json, path -> json", "json, path RETURNING type -> json"],
    "The JSON object or array a path selects, with wrapper and error handling clauses.",
  ],
  ["JSON_SCALAR", "expr -> json", "A SQL scalar value as a JSON scalar.", FROM_21],
  ["JSON_SERIALIZE", ["json -> string", "json RETURNING type -> string"], "JSON as text, PRETTY or ASCII if asked."],
  ["JSON_TABLE", "json, path COLUMNS columns -> table", "Projects JSON into rows and columns, for the FROM clause."],
  [
    "JSON_TRANSFORM",
    "json, operation... -> json",
    "A JSON document changed by SET, INSERT, APPEND, REMOVE, RENAME and other operations on paths.",
  ],
  [
    "JSON_VALUE",
    ["json, path -> string", "json, path RETURNING type -> scalar"],
    "The scalar a path selects, as text or the type RETURNING names.",
  ],
]);
