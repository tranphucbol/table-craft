import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { SQL_SERVER_2022, SQL_SERVER_2025 } from "./ranges.js";

/**
 * JSON functions, summarised in our own words from
 * https://learn.microsoft.com/en-us/sql/t-sql/functions/json-functions-transact-sql. OPENJSON is a
 * rowset function, in `misc.ts`.
 */
export const JSON_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("json", [
  ["ISJSON", "expression, type? -> integer", "1 when the text is valid JSON, of the kind named if any."],
  ["JSON_ARRAY", "value... -> string", "A JSON array of its arguments; NULL ON NULL keeps nulls.", SQL_SERVER_2022],
  ["JSON_ARRAYAGG", "value -> string", "A JSON array of the group's values.", SQL_SERVER_2025],
  ["JSON_CONTAINS", "json, value, path?, mode? -> integer", "Whether a JSON document holds a value.", SQL_SERVER_2025],
  ["JSON_MODIFY", "json, path, value -> string", "The JSON document with the value at a path changed."],
  [
    "JSON_OBJECT",
    "key_value... -> string",
    "A JSON object of 'key':value pairs; NULL ON NULL keeps nulls.",
    SQL_SERVER_2022,
  ],
  ["JSON_OBJECTAGG", "key_value -> string", "A JSON object of the group's key:value pairs.", SQL_SERVER_2025],
  ["JSON_PATH_EXISTS", "json, path -> integer", "1 when the path exists in the document.", SQL_SERVER_2022],
  ["JSON_QUERY", "json, path? -> string", "The object or array at a path, as JSON."],
  ["JSON_VALUE", "json, path -> string", "The scalar at a path, as text."],
]);
