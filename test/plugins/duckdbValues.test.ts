import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDuckdb, rowsOf, type DuckdbSession } from "../support/duckdbSession.js";

describe("DuckDB values", () => {
  let session: DuckdbSession;

  beforeAll(async () => {
    session = await openDuckdb(":memory:");
  });

  afterAll(async () => {
    await session.close();
  });

  it("givenHugeint_whenCellFor_thenExactBigint", async () => {
    const rows = await rowsOf(session, "SELECT 170141183460469231731687303715884105727::HUGEINT AS h");

    expect(rows).toEqual([[{ kind: "bigint", value: "170141183460469231731687303715884105727" }]]);
  });

  it("givenDecimal_whenCellFor_thenDuckdbTextUnrounded", async () => {
    const rows = await rowsOf(session, "SELECT 12345678901234567890.123456789::DECIMAL(38,9) AS d");

    expect(rows).toEqual([["12345678901234567890.123456789"]]);
  });

  it("givenStruct_whenCellFor_thenJsonCell", async () => {
    const result = await session.execute("SELECT {'a': 1, 'b': [true, NULL]} AS s");
    const rows = [];
    for await (const row of result.rows) rows.push(row);

    expect(result.columns[0]?.typeClass).toBe("json");
    expect(rows).toEqual([[{ kind: "json", text: '{"a":1,"b":[true,null]}' }]]);
  });

  it("givenMapColumn_whenCellFor_thenJsonArrayOfKeyValue", async () => {
    const rows = await rowsOf(session, "SELECT MAP {'k': 2} AS m");

    expect(rows).toEqual([[{ kind: "json", text: '[{"key":"k","value":2}]' }]]);
  });

  it("givenTimestamptz_whenCellFor_thenSessionTimeZoneText", async () => {
    await rowsOf(session, "SET TimeZone = 'Asia/Ho_Chi_Minh'");

    const rows = await rowsOf(session, "SELECT TIMESTAMPTZ '2026-11-04 03:00:00+00' AS t");

    expect(rows).toEqual([["2026-11-04 10:00:00+07"]]);
  });

  it("givenUtinyint_whenColumnFor_thenIntegerTypeClass", async () => {
    const result = await session.execute("SELECT 200::UTINYINT AS u, INTERVAL 3 DAY AS i, '[1]'::JSON AS j");
    for await (const _row of result.rows) void _row;

    expect(result.columns.map((column) => [column.type, column.typeClass])).toEqual([
      ["UTINYINT", "integer"],
      ["INTERVAL", "text"],
      ["JSON", "json"],
    ]);
  });

  it("givenUpdate_whenExecute_thenRowsAffectedFromCount", async () => {
    await rowsOf(session, "CREATE TABLE counted AS SELECT range AS id FROM range(5)");

    const result = await session.execute("UPDATE counted SET id = id + 10 WHERE id < 3");

    expect(result.columns).toEqual([]);
    expect(result.rowsAffected).toBe(3);
  });
});
