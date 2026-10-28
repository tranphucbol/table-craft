import type { FunctionSpec } from "@table-craft/plugin-api/sql";
import { AGGREGATE_FUNCTIONS } from "./aggregate.js";
import { CONVERSION_FUNCTIONS } from "./conversion.js";
import { DATETIME_FUNCTIONS } from "./datetime.js";
import { INFORMATION_FUNCTIONS } from "./information.js";
import { JSON_FUNCTIONS } from "./json.js";
import { MISC_FUNCTIONS } from "./misc.js";
import { NUMERIC_FUNCTIONS } from "./numeric.js";
import { DBMS_FUNCTIONS } from "./packages/dbms.js";
import { UTL_FUNCTIONS } from "./packages/utl.js";
import { STRING_FUNCTIONS } from "./string.js";
import { VECTOR_FUNCTIONS } from "./vector.js";
import { WINDOW_FUNCTIONS } from "./window.js";
import { XML_FUNCTIONS } from "./xml.js";

/** Every function of the SQL Language Reference's "SQL Functions" chapter, 19c to 23ai. */
export const ORACLE_SQL_FUNCTIONS: readonly FunctionSpec[] = [
  ...STRING_FUNCTIONS,
  ...NUMERIC_FUNCTIONS,
  ...DATETIME_FUNCTIONS,
  ...CONVERSION_FUNCTIONS,
  ...JSON_FUNCTIONS,
  ...XML_FUNCTIONS,
  ...AGGREGATE_FUNCTIONS,
  ...WINDOW_FUNCTIONS,
  ...INFORMATION_FUNCTIONS,
  ...MISC_FUNCTIONS,
  ...VECTOR_FUNCTIONS,
];

/** Members of the supplied PL/SQL packages, named `PKG.MEMBER`, offered after `pkg.`. */
export const ORACLE_PACKAGE_FUNCTIONS: readonly FunctionSpec[] = [...DBMS_FUNCTIONS, ...UTL_FUNCTIONS];

/** What the completer offers on Oracle (decision 097). */
export const ORACLE_FUNCTIONS: readonly FunctionSpec[] = [...ORACLE_SQL_FUNCTIONS, ...ORACLE_PACKAGE_FUNCTIONS];
