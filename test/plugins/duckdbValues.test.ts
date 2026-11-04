import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offsetText, zonedText } from "@table-craft/plugin-duckdb/timeZone";
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

  it("givenNewYork_whenTimestamptzInSummerAndWinter_thenEachDatesOwnOffset", async () => {
    await rowsOf(session, "SET TimeZone = 'America/New_York'");

    const rows = await rowsOf(
      session,
      "SELECT TIMESTAMPTZ '2026-07-04 03:00:00.5+00' AS summer, TIMESTAMPTZ '2026-01-04 03:00:00+00' AS winter",
    );

    expect(rows).toEqual([["2026-07-03 23:00:00.5-04", "2026-01-03 22:00:00-05"]]);
  });

  it("givenResetTimeZone_whenTimestamptz_thenTheDefaultZoneAgain", async () => {
    const fresh = await openDuckdb(":memory:");
    const instant = "SELECT TIMESTAMPTZ '2026-11-04 03:00:00+00' AS t";
    try {
      const before = await rowsOf(fresh, instant);
      await rowsOf(fresh, "SET TimeZone = 'Asia/Kolkata'");
      const kolkata = await rowsOf(fresh, instant);
      await rowsOf(fresh, "RESET TimeZone");

      expect(kolkata).toEqual([["2026-11-04 08:30:00+05:30"]]);
      expect(await rowsOf(fresh, instant)).toEqual(before);
    } finally {
      await fresh.close();
    }
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

describe("DuckDB time zone text", () => {
  const local = (micros: bigint): string => `local:${String(micros)}`;

  it("givenOffsets_whenOffsetText_thenDuckdbSuffix", () => {
    expect([25_200, -12_600, 0, -17_762].map(offsetText)).toEqual(["+07", "-03:30", "+00", "-04:56"]);
  });

  it("givenInfinityOrUnknownZone_whenZonedText_thenDriverTextKept", () => {
    const infinity = { micros: 2n ** 63n - 1n };
    const newYear2026 = { micros: 1_767_225_600_000_000n };

    expect(zonedText("UTC", local)(infinity)).toBeNull();
    expect(zonedText("Not/AZone", local)(newYear2026)).toBeNull();
    expect(zonedText("Asia/Ho_Chi_Minh", local)(newYear2026)).toBe("local:1767250800000000+07");
  });
});
