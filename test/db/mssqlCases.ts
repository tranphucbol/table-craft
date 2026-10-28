import mssql from "@table-craft/plugin-mssql";
import type { ExecuteResult, Row, Session } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";
import { MSSQL_CONFIG } from "../support/databases.js";

async function connected<T>(work: (session: Session) => Promise<T>, config: unknown = MSSQL_CONFIG): Promise<T> {
  const session = await mssql.connect(mssql.connectionSchema.parse(config), { readOnly: false });
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

async function rowsOf(result: ExecuteResult): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const row of result.rows) rows.push(row);
  return rows;
}

async function run(session: Session, sql: string): Promise<Row[]> {
  return rowsOf(await session.execute(sql));
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** The SQL Server cases the shared contract has no slot for (plan 055). */
export function mssqlServerCases(): void {
  describe("mssql batches", () => {
    it("givenGoSeparatedScript_whenRunAll_thenEachBatchRuns", async () => {
      await connected(async (session) => {
        const script = "CREATE TABLE #batches (n int)\nGO\nINSERT INTO #batches VALUES (1)\nGO\nSELECT n FROM #batches";
        const spans = mssql.language?.split(script) ?? [];
        expect(spans.map((span) => span.sql)).toEqual([
          "CREATE TABLE #batches (n int)",
          "INSERT INTO #batches VALUES (1)",
          "SELECT n FROM #batches",
        ]);
        let last: Row[] = [];
        for (const span of spans) last = await run(session, span.sql);
        expect(last).toEqual([[1]]);
      });
    });

    it("givenGoCount_whenRun_thenRepeated", async () => {
      await connected(async (session) => {
        await run(session, "CREATE TABLE #repeated (n int)");
        const [span] = mssql.language?.split("INSERT INTO #repeated VALUES (1)\nGO 3") ?? [];
        expect(span?.repeat).toBe(3);
        const result = await session.execute(span?.sql ?? "", [], { repeat: span?.repeat ?? 1 });
        expect(result.rowsAffected).toBe(1);
        expect(await run(session, "SELECT COUNT(*) FROM #repeated")).toEqual([[3]]);
      });
    });

    it("givenBatchWithTwoResultSets_whenRun_thenFirstShownAndMessage", async () => {
      await connected(async (session) => {
        const result = await session.execute("SELECT 1 AS a\nSELECT 2 AS b\nSELECT 3 AS c");
        expect(result.columns.map((column) => column.name)).toEqual(["a"]);
        expect(await rowsOf(result)).toEqual([[1]]);
        expect(result.messages).toEqual([
          {
            level: "info",
            code: null,
            text: "2 more result sets in this batch; separate statements with ; to see each.",
          },
        ]);
      });
    });

    it("givenPrint_whenRun_thenServerMessage", async () => {
      await connected(async (session) => {
        const result = await session.execute("PRINT 'hello'; RAISERROR('careful', 10, 1)");
        expect(result.messages).toEqual([
          { level: "info", code: null, text: "hello" },
          { level: "notice", code: "50000", text: "careful" },
        ]);
      });
    });

    it("givenErrorOnLineThree_whenFailed_thenLineUnderlined", async () => {
      await connected(async (session) => {
        const failure = await failureOf(session.execute("PRINT 1\nPRINT 2\n    SELECT * FROM no_such_table"));
        expect(failure).toMatchObject({ code: "statementFailed", position: { line: 3, column: 5 } });
      });
    });
  });

  describe("mssql values", () => {
    it("givenBitColumn_whenFetched_thenBooleanClass", async () => {
      await connected(async (session) => {
        const result = await session.execute("SELECT flag FROM type_probe WHERE id = 1");
        expect(result.columns).toEqual([{ name: "flag", type: "bit", typeClass: "boolean" }]);
        expect(await rowsOf(result)).toEqual([[true]]);
      });
    });

    it("givenDatetime2Seven_whenFetched_thenFullPrecision", async () => {
      await connected(async (session) => {
        const rows = await run(
          session,
          "SELECT CAST('2024-02-29 13:45:30.1234567' AS datetime2(7)) AS a, " +
            "CAST('2024-02-29 13:45:30.1234567 +05:30' AS datetimeoffset(7)) AS b, " +
            "CAST('2024-02-29 13:45:30.123' AS datetime) AS c, CAST('13:45:30.12' AS time(2)) AS d",
        );
        expect(rows).toEqual([
          [
            "2024-02-29 13:45:30.1234567",
            "2024-02-29 13:45:30.1234567 +05:30",
            "2024-02-29 13:45:30.123",
            "13:45:30.12",
          ],
        ]);
      });
    });

    it("givenDecimalBeyondDouble_whenFetched_thenExactText", async () => {
      await connected(async (session) => {
        const rows = await run(
          session,
          "SELECT CAST('12345678901234567890.123456789' AS decimal(38, 9)) AS a, " +
            "CAST(-0.5 AS decimal(4, 2)) AS b, CAST(922337203685477.5807 AS money) AS c",
        );
        expect(rows).toEqual([["12345678901234567890.123456789", "-0.50", "922337203685477.5807"]]);
      });
    });
  });

  describe("mssql namespaces and transactions", () => {
    it("givenUseDatabase_whenRun_thenTreeAndCompletionFollow", async () => {
      await connected(async (session) => {
        expect(mssql.language?.classify("USE master").setsNamespace).toBe(true);
        await run(session, "USE master");
        expect(await session.currentNamespace?.()).toEqual(["master", "guest"]);
        await run(session, "USE [table_craft]");
        expect(await session.currentNamespace?.()).toEqual(["table_craft", "dbo"]);
      });
    });

    it("givenImplicitTransactions_whenManualMode_thenTrancountTracked", async () => {
      await connected(async (session) => {
        await session.transactions?.setMode("manual");
        expect(session.transactions?.open).toBe(false);
        await run(session, "UPDATE orders SET total = total WHERE id = 1");
        expect(session.transactions?.open).toBe(true);
        expect(await run(session, "SELECT @@TRANCOUNT")).toEqual([[1]]);
        await session.transactions?.commit();
        expect(session.transactions?.open).toBe(false);
        await session.transactions?.setMode("auto");
      });
    });

    it("givenDdlInManualMode_whenRolledBack_thenTableGone", async () => {
      await connected(async (session) => {
        await session.transactions?.setMode("manual");
        await run(session, "CREATE TABLE table_craft_rolled_back (id int)");
        expect(session.transactions?.open).toBe(true);
        await session.transactions?.rollback();
        expect(await run(session, "SELECT OBJECT_ID('table_craft_rolled_back')")).toEqual([[null]]);
        await session.transactions?.setMode("auto");
      });
    });
  });

  describe("mssql routines and sessions", () => {
    it("givenProcedureWithOutput_whenCalled_thenOutputsAndReturnValue", async () => {
      await connected(async (session) => {
        const catalog = await session.introspector?.describe(["table_craft", "dbo"]);
        const routine = catalog?.routines.find((candidate) => candidate.name === "settle_order");
        if (routine === undefined || mssql.language?.routineCall === undefined) throw new Error("No settle_order.");
        const call = mssql.language.routineCall(routine, "[table_craft].[dbo].[settle_order]", [
          { kind: "value", value: "1" },
          { kind: "value", value: null },
        ]);
        const bound = mssql.language.bind(call.sql, call.params);
        const result = await session.execute(bound.sql, bound.params);
        expect(result.columns.map((column) => column.name)).toEqual(["RETURN_VALUE", "total"]);
        expect(await rowsOf(result)).toEqual([[0, "19.99"]]);
      });
    });

    it("givenNoViewServerState_whenListSessions_thenOwnOnlyWithHint", async () => {
      const limited = { ...MSSQL_CONFIG, user: "table_craft_limited", password: "table_craft_limited" };
      await connected(async (session) => {
        const listing = await session.sessions?.list();
        expect(listing?.sessions.every((row) => row.user === "table_craft_limited")).toBe(true);
        expect(listing?.sessions.some((row) => row.id === session.serverSessionId)).toBe(true);
        expect(listing?.notes.join(" ")).toMatch(/GRANT VIEW SERVER STATE TO \[table_craft_limited\]/);
      }, limited);
    });
  });
}
