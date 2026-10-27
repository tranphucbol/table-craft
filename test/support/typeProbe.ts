import type { Row } from "@table-craft/plugin-api";

/**
 * `SELECT * FROM type_probe ORDER BY id` as wire values. Identical for every database: the schemas
 * under `test/db/schema/` seed the same row, and the value rules (decision 017) make it cross the
 * wire the same way.
 */
export const TYPE_PROBE_EXPECTED: readonly Row[] = [
  [
    1,
    42,
    { kind: "bigint", value: "9007199254740993" },
    "1234567890123456.7890",
    "héllo, 世界 🌍",
    true,
    { kind: "json", text: '{"a": 1, "b": [true, null]}' },
    { kind: "bytes", preview: "deadbeef", length: 4 },
    "2024-02-29",
    "2024-02-29 13:45:30",
  ],
  [2, null, null, null, null, null, null, null, null, null],
];

/** Rewrites one cell with its own value: a real write that leaves the fixture as it was. */
export const TYPE_PROBE_WRITE = "UPDATE type_probe SET small_int = small_int WHERE id = 1";

/** Postgres and MySQL keep declared types through `CREATE TABLE … AS`. */
export const TYPE_PROBE_COPY_AS = "CREATE TABLE type_probe_copy AS SELECT * FROM type_probe WHERE 1 = 0";

/** MariaDB's JSON is LONGTEXT with a `json_valid` check, which `CREATE TABLE … AS` drops and `LIKE` keeps. */
export const TYPE_PROBE_COPY_LIKE = "CREATE TABLE type_probe_copy LIKE type_probe";

/** SQLite's `CREATE TABLE … AS` keeps only affinities, which lose BOOLEAN and JSON, so it is spelled out. */
export const TYPE_PROBE_COPY_SQLITE = `CREATE TABLE type_probe_copy (
  id INTEGER PRIMARY KEY,
  small_int INTEGER,
  big_int INTEGER,
  exact_decimal TEXT,
  unicode_text TEXT,
  flag BOOLEAN,
  doc JSON,
  payload BLOB,
  day TEXT,
  moment TEXT
)`;
