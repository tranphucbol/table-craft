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

const DOC_COLUMN = 6;

/** SQL Server 2022 has no JSON type: `doc` is `nvarchar(max)` with an ISJSON check, so it reads as text. */
export const MSSQL_TYPE_PROBE_EXPECTED: readonly Row[] = TYPE_PROBE_EXPECTED.map((row) =>
  row.map((value, index) =>
    index === DOC_COLUMN && value !== null && typeof value === "object" && "text" in value ? value.text : value,
  ),
);

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

/**
 * Oracle's row: `NUMBER(1)` reads as the integer it is, and `DATE` carries a time of day, so the
 * flag and the day differ from every other database's.
 */
export const ORACLE_TYPE_PROBE_EXPECTED: readonly Row[] = [
  [
    1,
    42,
    { kind: "bigint", value: "9007199254740993" },
    "1234567890123456.7890",
    "héllo, 世界 🌍",
    1,
    { kind: "json", text: '{"a": 1, "b": [true, null]}' },
    { kind: "bytes", preview: "deadbeef", length: 4 },
    "2024-02-29 00:00:00",
    "2024-02-29 13:45:30",
  ],
  [2, null, null, null, null, null, null, null, null, null],
];

/** Oracle's `CREATE TABLE … AS` drops the `IS JSON` check that makes `doc` read as JSON, so it is spelled out. */
export const TYPE_PROBE_COPY_ORACLE = `CREATE TABLE type_probe_copy (
  id NUMBER(10),
  small_int NUMBER(5),
  big_int NUMBER(19),
  exact_decimal NUMBER(20, 4),
  unicode_text NVARCHAR2(100),
  flag NUMBER(1),
  doc CLOB CHECK (doc IS JSON),
  payload BLOB,
  day DATE,
  moment TIMESTAMP
)`;
