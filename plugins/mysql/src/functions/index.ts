import type { FunctionSpec } from "@table-craft/plugin-api/sql";
import { AGGREGATE_FUNCTIONS } from "./aggregate.js";
import { CRYPTO_FUNCTIONS } from "./crypto.js";
import { DATETIME_FUNCTIONS } from "./datetime.js";
import { INFO_FUNCTIONS } from "./info.js";
import { JSON_FUNCTIONS } from "./json.js";
import { MISC_FUNCTIONS } from "./misc.js";
import { NUMERIC_FUNCTIONS } from "./numeric.js";
import { SPATIAL_FUNCTIONS } from "./spatial.js";
import { STRING_FUNCTIONS } from "./string.js";
import { TIDB_FUNCTIONS } from "./tidb.js";
import { WINDOW_FUNCTIONS } from "./window.js";

/** Every built-in function of MySQL and TiDB, each with the server versions that have it (decision 097). */
export const MYSQL_FUNCTIONS: readonly FunctionSpec[] = [
  ...STRING_FUNCTIONS,
  ...NUMERIC_FUNCTIONS,
  ...DATETIME_FUNCTIONS,
  ...JSON_FUNCTIONS,
  ...AGGREGATE_FUNCTIONS,
  ...WINDOW_FUNCTIONS,
  ...INFO_FUNCTIONS,
  ...CRYPTO_FUNCTIONS,
  ...MISC_FUNCTIONS,
  ...SPATIAL_FUNCTIONS,
  ...TIDB_FUNCTIONS,
];
