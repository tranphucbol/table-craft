import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { MYSQL_ONLY, since, TIDB_AFTER_4, TIDB_LATER } from "./ranges.js";

const MYSQL_8 = "8.0";
const MYSQL_PERFORMANCE_HELPERS = "8.0.16";

/**
 * Flow control, comparison, cast, locking, XML, replication and other functions, summarised in our
 * own words from https://dev.mysql.com/doc/refman/8.4/en/flow-control-functions.html,
 * https://dev.mysql.com/doc/refman/8.4/en/comparison-operators.html,
 * https://dev.mysql.com/doc/refman/8.4/en/cast-functions.html,
 * https://dev.mysql.com/doc/refman/8.4/en/miscellaneous-functions.html,
 * https://dev.mysql.com/doc/refman/8.4/en/locking-functions.html,
 * https://dev.mysql.com/doc/refman/8.4/en/xml-functions.html,
 * https://dev.mysql.com/doc/refman/8.4/en/gtid-functions.html,
 * https://dev.mysql.com/doc/refman/8.4/en/performance-schema-functions.html, their 5.7 pages,
 * https://docs.pingcap.com/tidb/v4.0/miscellaneous-functions and
 * https://docs.pingcap.com/tidb/stable/miscellaneous-functions and locking-functions.
 */
export const MISC_FUNCTIONS: readonly FunctionSpec[] = [
  ...functionSpecs("control", [
    ["CAST", "expr AS type -> value", "Converts a value to another type, such as CHAR, SIGNED or DATE."],
    ["COALESCE", "value... -> value", "The first argument that is not null."],
    [
      "CONVERT",
      ["expr, type -> value", "expr USING charset -> string"],
      "Converts a value to another type, or a string to another character set.",
    ],
    ["GREATEST", "value, value... -> value", "The largest argument."],
    ["IF", "condition, then, else -> value", "The second argument when the condition holds, else the third."],
    ["IFNULL", "value, fallback -> value", "The first argument, or the second when the first is null."],
    ["INTERVAL", "n, bound... -> integer", "How many of the ascending bounds n reaches or passes."],
    ["ISNULL", "expr -> integer", "Whether the value is null."],
    ["LEAST", "value, value... -> value", "The smallest argument."],
    ["NULLIF", "a, b -> value", "Null when both arguments are equal, else the first."],
  ]),
  ...functionSpecs("misc", [
    ["ANY_VALUE", "expr -> value", "Any one of the group's values, for a column ONLY_FULL_GROUP_BY would reject."],
    [
      "BIN_TO_UUID",
      "bin, swap? -> string",
      "A 16-byte UUID written out as text, undoing a swap of its time parts.",
      since(MYSQL_8, TIDB_AFTER_4),
    ],
    ["DEFAULT", "column -> value", "The column's default value."],
    [
      "FORMAT_BYTES",
      "count -> string",
      "A byte count written with a unit such as KiB or MiB.",
      since(MYSQL_PERFORMANCE_HELPERS),
    ],
    [
      "FORMAT_PICO_TIME",
      "picoseconds -> string",
      "A duration in picoseconds written with a unit such as ms or s.",
      since(MYSQL_PERFORMANCE_HELPERS, false),
    ],
    [
      "GROUPING",
      "expr... -> integer",
      "Whether a WITH ROLLUP row stands for all values of the expression.",
      since("8.0.1", TIDB_AFTER_4),
    ],
    ["INET_ATON", "address -> integer", "A dotted IPv4 address as a number."],
    ["INET_NTOA", "n -> string", "A number as a dotted IPv4 address."],
    ["INET6_ATON", "address -> string", "An IPv4 or IPv6 address as binary."],
    ["INET6_NTOA", "bin -> string", "A binary IPv4 or IPv6 address as text."],
    ["IS_IPV4", "str -> integer", "Whether the string is an IPv4 address."],
    ["IS_IPV4_COMPAT", "bin -> integer", "Whether the binary address is IPv4-compatible IPv6."],
    ["IS_IPV4_MAPPED", "bin -> integer", "Whether the binary address is IPv4-mapped IPv6."],
    ["IS_IPV6", "str -> integer", "Whether the string is an IPv6 address."],
    ["IS_UUID", "str -> integer", "Whether the string is a valid UUID.", since(MYSQL_8, TIDB_AFTER_4)],
    ["NAME_CONST", "name, value -> value", "A constant that names the column it appears in."],
    [
      "PS_CURRENT_THREAD_ID",
      "-> integer",
      "This connection's thread id in the performance schema.",
      since(MYSQL_PERFORMANCE_HELPERS, false),
    ],
    [
      "PS_THREAD_ID",
      "connection_id -> integer",
      "A connection's thread id in the performance schema.",
      since(MYSQL_PERFORMANCE_HELPERS, false),
    ],
    ["SLEEP", "seconds -> integer", "Pauses for that many seconds; 0 when not interrupted."],
    ["UUID", "-> string", "A new version 1 UUID as text."],
    ["UUID_SHORT", "-> integer", "A 64-bit number unique while the server id stays put.", MYSQL_ONLY],
    [
      "UUID_TO_BIN",
      "str, swap? -> string",
      "A UUID as 16 bytes, optionally with its time parts swapped to index better.",
      since(MYSQL_8, TIDB_AFTER_4),
    ],
    ["VALUES", "column -> value", "In ON DUPLICATE KEY UPDATE, the value the insert proposed for the column."],
  ]),
  ...functionSpecs("locking", [
    ["GET_LOCK", "name, timeout -> integer", "Takes a named advisory lock, waiting up to a timeout.", TIDB_LATER],
    ["IS_FREE_LOCK", "name -> integer", "Whether nobody holds the named lock.", TIDB_LATER],
    ["IS_USED_LOCK", "name -> integer", "The connection id holding the named lock, or null.", TIDB_LATER],
    ["RELEASE_ALL_LOCKS", "-> integer", "Releases every named lock this session holds.", TIDB_LATER],
    ["RELEASE_LOCK", "name -> integer", "Releases one named lock.", TIDB_LATER],
  ]),
  ...functionSpecs("xml", [
    ["EXTRACTVALUE", "xml, xpath -> string", "The text an XPath expression selects in an XML fragment.", MYSQL_ONLY],
    [
      "UPDATEXML",
      "xml, xpath, replacement -> string",
      "An XML fragment with the element an XPath selects replaced.",
      MYSQL_ONLY,
    ],
  ]),
  ...functionSpecs("server", [
    ["GTID_SUBSET", "set1, set2 -> integer", "Whether every GTID of the first set is in the second.", MYSQL_ONLY],
    ["GTID_SUBTRACT", "set1, set2 -> string", "The GTIDs of the first set that the second lacks.", MYSQL_ONLY],
    [
      "MASTER_POS_WAIT",
      "log, position, timeout?, channel? -> integer",
      "Waits until the replica has applied the source's log up to a position.",
      MYSQL_ONLY,
    ],
    [
      "SOURCE_POS_WAIT",
      "log, position, timeout?, channel? -> integer",
      "Waits until the replica has applied the source's log up to a position.",
      since("8.0.26", false),
    ],
    [
      "WAIT_FOR_EXECUTED_GTID_SET",
      "gtid_set, timeout? -> integer",
      "Waits until the server has applied every GTID of the set.",
      MYSQL_ONLY,
    ],
  ]),
];
