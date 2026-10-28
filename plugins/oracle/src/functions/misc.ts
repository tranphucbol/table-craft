import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { FROM_23 } from "./ranges.js";

/**
 * LOB, collection, hierarchical, model, object reference, OLAP, data cartridge, streaming window and
 * graph functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html,
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Model-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Functions.html.
 */
export const MISC_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("misc", [
  ["BFILENAME", "directory, filename -> bfile", "A BFILE locator for a file in a directory object."],
  ["CARDINALITY", "nested_table -> number", "How many elements a nested table has."],
  ["CUBE_TABLE", "cube -> table", "An OLAP cube or dimension as a relational table, for the FROM clause."],
  [
    "CUMULATE",
    "source, COLUMNS(column), step, size, origin? -> table",
    "The rows of a table assigned to windows that share a start and grow by a step up to a size.",
    FROM_23,
  ],
  ["CV", "dimension? -> any", "In a MODEL rule, the dimension value of the cell being computed."],
  [
    "DATAOBJ_TO_MAT_PARTITION",
    "table, data_object_id -> number",
    "The absolute partition number of a data object id, for data cartridge code on system-partitioned tables.",
  ],
  [
    "DATAOBJ_TO_PARTITION",
    "table, data_object_id -> number",
    "The partition number of a data object id, for data cartridge code on system-partitioned tables.",
  ],
  ["DEREF", "ref -> object", "The object a REF points at."],
  ["EMPTY_BLOB", "-> blob", "An empty BLOB locator, to initialise a column before writing to it."],
  ["EMPTY_CLOB", "-> clob", "An empty CLOB locator, to initialise a column before writing to it."],
  [
    "GRAPHQL",
    "query -> table",
    "The rows a GraphQL query over tables and their relationships returns, for the FROM clause.",
    FROM_23,
  ],
  [
    "HOP",
    "source, COLUMNS(column), size, slide, origin? -> table",
    "The rows of a table assigned to fixed-size windows that start every slide, overlapping when slide is shorter.",
    FROM_23,
  ],
  [
    "ITERATION_NUMBER",
    "= number",
    "In an ITERATE model rule, the iteration being run, from 0; written without parentheses.",
  ],
  [
    "MAKE_REF",
    "object_view, key... -> ref",
    "A REF to a row of an object view or object table with a primary key based id.",
  ],
  ["POWERMULTISET", "nested_table -> collection", "Every non-empty subset of a nested table."],
  [
    "POWERMULTISET_BY_CARDINALITY",
    "nested_table, size -> collection",
    "Every subset of a nested table with the given number of elements.",
  ],
  [
    "PRESENTNNV",
    "cell, if_present, if_absent -> any",
    "In a MODEL rule, if_present when the cell existed before the rules ran and is not null, else if_absent.",
  ],
  [
    "PRESENTV",
    "cell, if_present, if_absent -> any",
    "In a MODEL rule, if_present when the cell existed before the rules ran, else if_absent.",
  ],
  ["PREVIOUS", "cell -> any", "In an ITERATE ... UNTIL model rule, the cell's value at the start of the iteration."],
  ["REF", "correlation -> ref", "A REF to the row of an object table that a table alias names."],
  ["REFTOHEX", "ref -> string", "A REF as hexadecimal text."],
  [
    "SESSIONS",
    "source, COLUMNS(column), gap -> table",
    "The rows of a table grouped into sessions that end when the time between rows passes a gap.",
    FROM_23,
  ],
  [
    "SYS_CONNECT_BY_PATH",
    "column, separator -> string",
    "In a CONNECT BY query, the column's values from the root down to the row, each after a separator.",
  ],
  [
    "SYS_OP_ZONE_ID",
    "rowid, scale? -> number",
    "The zone a row falls in, as zone maps on attribute clustered tables number them.",
  ],
  ["SYS_TYPEID", "object -> raw", "The type id of an object's most specific type."],
  [
    "TUMBLE",
    "source, COLUMNS(column), size, origin? -> table",
    "The rows of a table assigned to consecutive windows of a fixed size that do not overlap.",
    FROM_23,
  ],
  ["VALUE", "correlation -> object", "The object stored in the row of an object table that a table alias names."],
]);
