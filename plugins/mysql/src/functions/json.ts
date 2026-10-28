import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { removedIn, since, TIDB_AFTER_4 } from "./ranges.js";

/**
 * JSON functions, summarised in our own words from
 * https://dev.mysql.com/doc/refman/8.4/en/json-function-reference.html,
 * https://dev.mysql.com/doc/refman/5.7/en/json-function-reference.html,
 * https://docs.pingcap.com/tidb/v4.0/json-functions and
 * https://docs.pingcap.com/tidb/stable/json-functions.
 */
export const JSON_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("json", [
  ["JSON_APPEND", "doc, path, value, more... -> json", "The older name of JSON_ARRAY_APPEND.", removedIn("8.0", false)],
  ["JSON_ARRAY", "value... -> json", "A JSON array of the arguments."],
  ["JSON_ARRAY_APPEND", "doc, path, value, more... -> json", "Adds values to the end of the arrays at the paths."],
  ["JSON_ARRAY_INSERT", "doc, path, value, more... -> json", "Inserts values into arrays at the given positions."],
  [
    "JSON_CONTAINS",
    "target, candidate, path? -> integer",
    "Whether a document holds another, at its root or at a path.",
  ],
  [
    "JSON_CONTAINS_PATH",
    "doc, one_or_all, path... -> integer",
    "Whether the document has data at one or at all of the paths.",
  ],
  ["JSON_DEPTH", "doc -> integer", "How deeply the document nests; 1 for a scalar or an empty container."],
  ["JSON_EXTRACT", "doc, path... -> json", "The values at the paths; the -> operator is a shorthand."],
  ["JSON_INSERT", "doc, path, value, more... -> json", "Adds values at paths that have none, leaving others alone."],
  ["JSON_KEYS", "doc, path? -> json", "The keys of the object at the root or at a path, as an array."],
  ["JSON_LENGTH", "doc, path? -> integer", "How many elements or members the value holds; 1 for a scalar."],
  ["JSON_MERGE", "doc, doc... -> json", "The older name of JSON_MERGE_PRESERVE."],
  [
    "JSON_MERGE_PATCH",
    "doc, doc... -> json",
    "Merges documents as RFC 7396 patches: later members replace earlier ones, nulls delete.",
    since("5.7.22", TIDB_AFTER_4),
  ],
  [
    "JSON_MERGE_PRESERVE",
    "doc, doc... -> json",
    "Merges documents, keeping every value by gathering clashes into arrays.",
    since("5.7.22"),
  ],
  ["JSON_OBJECT", "key, value, more... -> json", "A JSON object of key and value pairs."],
  [
    "JSON_OVERLAPS",
    "doc1, doc2 -> integer",
    "Whether two documents share an array element or an object member.",
    since("8.0.17", TIDB_AFTER_4),
  ],
  ["JSON_PRETTY", "doc -> string", "The document laid out on indented lines.", since("5.7.22", TIDB_AFTER_4)],
  ["JSON_QUOTE", "str -> json", "A string as a quoted, escaped JSON string."],
  ["JSON_REMOVE", "doc, path... -> json", "The document without the data at the paths."],
  ["JSON_REPLACE", "doc, path, value, more... -> json", "Replaces values at paths that exist, adding none."],
  [
    "JSON_SCHEMA_VALID",
    "schema, doc -> integer",
    "Whether the document satisfies a JSON Schema.",
    since("8.0.17", TIDB_AFTER_4),
  ],
  [
    "JSON_SCHEMA_VALIDATION_REPORT",
    "schema, doc -> json",
    "A report of whether and why the document fails a JSON Schema.",
    since("8.0.17", false),
  ],
  ["JSON_SEARCH", "doc, one_or_all, search, escape?, path... -> json", "The paths of strings matching a LIKE pattern."],
  ["JSON_SET", "doc, path, value, more... -> json", "Writes values at paths, replacing or adding."],
  [
    "JSON_STORAGE_FREE",
    "doc -> integer",
    "Bytes freed inside a stored JSON column by partial updates.",
    since("8.0", TIDB_AFTER_4),
  ],
  ["JSON_STORAGE_SIZE", "doc -> integer", "Bytes the document takes in storage.", since("5.7.22")],
  [
    "JSON_TABLE",
    "doc, path COLUMNS (columns) -> table",
    "Turns JSON into rows and columns, used in FROM with an alias.",
    since("8.0.4", false),
  ],
  ["JSON_TYPE", "value -> string", "The JSON type of the value, such as OBJECT, ARRAY or INTEGER."],
  ["JSON_UNQUOTE", "value -> string", "The string without its JSON quotes and escapes; ->> is a shorthand."],
  ["JSON_VALID", "value -> integer", "Whether the value is valid JSON."],
  [
    "JSON_VALUE",
    "doc, path RETURNING type? -> value",
    "The scalar at a path, optionally cast to a type.",
    since("8.0.21", false),
  ],
]);
