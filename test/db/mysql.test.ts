import mysql from "@table-craft/plugin-mysql";
import { isPluginError, omittedMessages, SERVER_MESSAGE_LIMIT, type Session } from "@table-craft/plugin-api";
import { describe, expect, it } from "vitest";
import { databaseEnabled, MYSQL_CONFIG, MYSQL_ROOT_CONFIG } from "../support/databases.js";
import { runMysqlFamilyContract } from "./mysqlFamily.js";

describe.runIf(databaseEnabled("mysql"))("mysql server", () => {
  runMysqlFamilyContract(MYSQL_CONFIG, MYSQL_ROOT_CONFIG);

  /** More rows than `SERVER_MESSAGE_LIMIT`, each truncating `'<n>x'` to an integer with a warning. */
  const MANY_WARNINGS_SQL = `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(
    SERVER_MESSAGE_LIMIT + 5,
  )}) SELECT CAST(CONCAT(i, 'x') AS SIGNED) AS v FROM n`;

  describe("mysql server messages", () => {
    async function withMysql(run: (session: Session) => Promise<void>): Promise<void> {
      const session = await mysql.connect(MYSQL_CONFIG, { readOnly: false });
      try {
        await run(session);
      } finally {
        await session.close();
      }
    }

    async function drained(session: Session, sql: string) {
      const result = await session.execute(sql);
      for await (const _row of result.rows) {
        // Messages are complete once the rows are.
      }
      return result.messages;
    }

    it("givenNoRowsStatementWithWarning_whenExecuted_thenMessagesReturned", async () => {
      await withMysql(async (session) => {
        expect(await drained(session, "DO CAST('1x' AS SIGNED)")).toEqual([
          { level: "warning", code: "1292", text: "Truncated incorrect INTEGER value: '1x'" },
        ]);
      });
    });

    it("givenMoreWarningsThanTheLimit_whenExecuted_thenLimitAndHowManyMore", async () => {
      await withMysql(async (session) => {
        const messages = (await drained(session, MANY_WARNINGS_SQL)) ?? [];
        expect(messages).toHaveLength(SERVER_MESSAGE_LIMIT + 1);
        expect(messages.at(-1)).toEqual(omittedMessages(5));
      });
    });

    it("givenRowsLeftUnread_whenNextStatementRuns_thenNoWarningsAreRead", async () => {
      await withMysql(async (session) => {
        const abandoned = await session.execute(MANY_WARNINGS_SQL);
        const rows = abandoned.rows[Symbol.asyncIterator]();
        await rows.next();
        await rows.return?.();
        expect(abandoned.messages).toEqual([]);
        expect(await drained(session, "SELECT 1 AS n")).toEqual([]);
      });
    });
  });

  describe("mysql explain", () => {
    it("givenMysqlDelete_whenAnalyseExplainable_thenRefused", async () => {
      const verdict = mysql.language?.explainable?.("DELETE FROM orders WHERE id = 1", { analyze: true });
      expect(verdict).toEqual({
        ok: false,
        reason: "MySQL analyses only SELECT or TABLE statements; use Explain Plan for this DELETE.",
      });
      const session = await mysql.connect(MYSQL_CONFIG, { readOnly: false });
      try {
        const failure: unknown = await session
          .explain?.("DELETE FROM orders WHERE id = 1", { analyze: true })
          .catch((error: unknown) => error);
        expect(isPluginError(failure) && failure.code).toBe("explainUnsupported");
        const plan = await session.explain?.("UPDATE orders SET total = total WHERE id = 1", { analyze: false });
        expect(plan?.statement).toMatch(/^EXPLAIN FORMAT=JSON /);
        expect(plan?.roots[0]).toMatchObject({ operation: "Update", target: "orders" });
      } finally {
        await session.close();
      }
    });
  });
});
