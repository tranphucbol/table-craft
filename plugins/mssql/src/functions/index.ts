import type { FunctionSpec } from "@table-craft/plugin-api/sql";
import { AGGREGATE_FUNCTIONS } from "./aggregate.js";
import { CONTROL_FUNCTIONS } from "./control.js";
import { DATETIME_FUNCTIONS } from "./datetime.js";
import { ENCRYPTION_FUNCTIONS } from "./encryption.js";
import { INFORMATION_FUNCTIONS, SERVER_FUNCTIONS } from "./information.js";
import { JSON_FUNCTIONS } from "./json.js";
import { MISC_FUNCTIONS } from "./misc.js";
import { NUMERIC_FUNCTIONS } from "./numeric.js";
import { STRING_FUNCTIONS } from "./string.js";
import { WINDOW_FUNCTIONS } from "./window.js";

export { MANUAL_INDEX, NOT_OFFERED } from "./manualIndex.js";

/**
 * Every built-in function of SQL Server and Azure SQL, each with the versions that have it
 * (decision 097). A name 2022 extended appears once per shape, with ranges that do not overlap.
 */
export const MSSQL_FUNCTIONS: readonly FunctionSpec[] = [
  ...STRING_FUNCTIONS,
  ...NUMERIC_FUNCTIONS,
  ...DATETIME_FUNCTIONS,
  ...JSON_FUNCTIONS,
  ...AGGREGATE_FUNCTIONS,
  ...WINDOW_FUNCTIONS,
  ...CONTROL_FUNCTIONS,
  ...INFORMATION_FUNCTIONS,
  ...SERVER_FUNCTIONS,
  ...ENCRYPTION_FUNCTIONS,
  ...MISC_FUNCTIONS,
];
