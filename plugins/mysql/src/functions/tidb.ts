import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { tidbOnly } from "./ranges.js";

/**
 * TiDB's own functions, summarised in our own words from https://docs.pingcap.com/tidb/stable/tidb-functions
 * and https://docs.pingcap.com/tidb/stable/aggregate-group-by-functions; each version is the first
 * of v4.0, v5.0, v5.4, v6.1, v7.1, v7.5 and v8.5 whose pages (https://docs.pingcap.com/tidb/<version>/tidb-functions)
 * list it.
 */
export const TIDB_FUNCTIONS: readonly FunctionSpec[] = [
  ...functionSpecs("server", [
    ["CURRENT_RESOURCE_GROUP", "-> string", "The resource group this session is bound to.", tidbOnly("7.5")],
    [
      "TIDB_BOUNDED_STALENESS",
      "earliest, latest -> datetime",
      "The newest timestamp in the range whose data is ready, for stale reads.",
      tidbOnly("5.0"),
    ],
    ["TIDB_CURRENT_TSO", "-> integer", "The current timestamp oracle value.", tidbOnly("7.5")],
    [
      "TIDB_DECODE_BINARY_PLAN",
      "plan -> string",
      "A binary-encoded execution plan from the slow log or statement tables, as text.",
      tidbOnly("7.5"),
    ],
    ["TIDB_DECODE_KEY", "key -> json", "A TiKV key, as the table, index and handle it stands for.", tidbOnly()],
    ["TIDB_DECODE_PLAN", "plan -> string", "An encoded execution plan from the slow log, as text.", tidbOnly()],
    [
      "TIDB_DECODE_SQL_DIGESTS",
      "digests, length? -> json",
      "The normalized statements of a JSON array of digests, optionally cut to a length.",
      tidbOnly("5.4"),
    ],
    [
      "TIDB_ENCODE_INDEX_KEY",
      "db, table, index, value..., handle -> string",
      "The TiKV key of an index entry.",
      tidbOnly("8.5"),
    ],
    ["TIDB_ENCODE_RECORD_KEY", "db, table, handle... -> string", "The TiKV key of a row.", tidbOnly("8.5")],
    [
      "TIDB_ENCODE_SQL_DIGEST",
      "statement -> string",
      "The digest TiDB records a statement of this shape under.",
      tidbOnly("7.5"),
    ],
    ["TIDB_IS_DDL_OWNER", "-> integer", "Whether this TiDB server owns DDL execution.", tidbOnly()],
    ["TIDB_MVCC_INFO", "key -> json", "The versions TiKV keeps of a key.", tidbOnly("8.5")],
    ["TIDB_PARSE_TSO", "tso -> datetime", "The physical time a timestamp oracle value stands for.", tidbOnly()],
    ["TIDB_PARSE_TSO_LOGICAL", "tso -> integer", "The logical counter of a timestamp oracle value.", tidbOnly("7.5")],
    ["TIDB_ROW_CHECKSUM", "-> integer", "The checksum of the row read by a point query on its key.", tidbOnly("7.1")],
    ["TIDB_SHARD", "value -> integer", "A hash prefix that spreads a monotonic index over regions.", tidbOnly("6.1")],
    ["TIDB_VERSION", "-> string", "The TiDB version with its build details.", tidbOnly()],
    ["VITESS_HASH", "value -> integer", "The hash Vitess shards by, for migrations from it.", tidbOnly("5.0")],
  ]),
  ...functionSpecs("aggregate", [
    [
      "APPROX_COUNT_DISTINCT",
      "expr... -> integer",
      "An estimate of how many distinct values the group has.",
      tidbOnly(),
    ],
    [
      "APPROX_PERCENTILE",
      "expr, percent -> value",
      "An estimate of the value at a percentile of the group.",
      tidbOnly(),
    ],
  ]),
];
