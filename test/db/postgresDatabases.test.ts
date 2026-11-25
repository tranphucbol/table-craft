import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import postgres from "@table-craft/plugin-postgres";
import type { Session } from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import type { TableQuery } from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { databaseEnabled, POSTGRES_CONFIG } from "../support/databases.js";
import { POSTGRES_MANIFEST } from "../support/manifests.js";
import { execute, exportHarness, openSession, resultOf } from "../support/engineExports.js";

const LOADED: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/postgres",
  manifest: POSTGRES_MANIFEST,
  plugin: postgres,
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function run(session: Session, sql: string): Promise<void> {
  const result = await session.execute(sql);
  for await (const _row of result.rows) {
    /* Drain before the next statement. */
  }
}

describe.runIf(databaseEnabled("postgres"))("PostgreSQL database isolation", () => {
  it("givenTwoDiscoveredDatabases_whenQueriesTablesAndTransactionsInterleave_thenEveryConnectionStaysInItsDatabase", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const names = [`tc_run_${suffix}_a`, `tc_run_${suffix}_b "quoted`, `tc_run_${suffix}_denied`];
    const [a, b, denied] = names as [string, string, string];
    const role = `tc_run_${suffix}`;
    const password = `password_${suffix}`;
    const admin = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
    const created: string[] = [];
    const engines: ReturnType<typeof exportHarness>[] = [];
    let roleCreated = false;
    try {
      for (const name of names) {
        await run(admin, `CREATE DATABASE ${quote(name)}`);
        created.push(name);
      }
      await run(admin, `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}'`);
      roleCreated = true;
      await run(admin, `REVOKE CONNECT ON DATABASE ${quote(denied)} FROM PUBLIC`);
      const reader = await postgres.connect({ ...POSTGRES_CONFIG, user: role, password }, { readOnly: true });
      try {
        const databases = await reader.services.databases!.list();
        expect(databases).toEqual(expect.arrayContaining([a, b]));
        expect(databases).not.toContain(denied);
        expect(databases).not.toContain("template0");
        expect(databases).not.toContain("template1");
      } finally {
        await reader.close();
      }

      const open = (database: string) => {
        const harness = exportHarness(
          {
            id: database,
            pluginId: "postgres",
            config: { ...POSTGRES_CONFIG, database },
            readOnly: false,
            keepAliveSeconds: 0,
          },
          [LOADED],
        );
        engines.push(harness);
        return harness.connection;
      };
      const left = open(a);
      const right = open(b);
      const leftSession = await openSession(left);
      const rightSession = await openSession(right);
      for (const [connection, sessionId, marker] of [
        [left, leftSession, "A"],
        [right, rightSession, "B"],
      ] as const) {
        await execute(connection, sessionId, "CREATE TABLE public.same_name (id integer PRIMARY KEY, marker text)");
        await execute(connection, sessionId, `INSERT INTO public.same_name VALUES (1, '${marker}')`);
      }
      await execute(right, rightSession, "INSERT INTO public.same_name VALUES (2, 'B2')");
      expect(resultOf<string[]>(await left.handle({ id: 3, type: "catalog.databases" }))).toContain(b);
      const table = async (connection: typeof left, sessionId: string, database: string) =>
        resultOf<TableQuery>(
          await connection.handle({
            id: 4,
            type: "table.query",
            sessionId,
            path: [database, "public"],
            relation: "same_name",
            where: "",
            orderBy: "id",
            pageRows: RESULT_PAGE_ROWS,
            fetchAllCap: RESULT_FETCH_ALL_CAP,
          }),
        );
      expect((await table(left, leftSession, a)).statement.firstWindow.rows).toEqual([[1, "A"]]);
      expect((await table(right, rightSession, b)).statement.firstWindow.rows).toEqual([
        [1, "B"],
        [2, "B2"],
      ]);
      expect(await left.handle({ id: 5, type: "catalog.describe", path: [b, "public"] })).toMatchObject({
        type: "engine.error",
      });

      await execute(left, leftSession, "BEGIN");
      await execute(left, leftSession, "UPDATE same_name SET marker = 'pending A' WHERE id = 1");
      await execute(right, rightSession, "BEGIN");
      await execute(right, rightSession, "UPDATE same_name SET marker = 'committed B' WHERE id = 1");
      await execute(right, rightSession, "COMMIT");
      expect(
        (await execute(left, leftSession, "SELECT current_database(), marker FROM same_name WHERE id = 1")).firstWindow
          .rows,
      ).toEqual([[a, "pending A"]]);
      await execute(left, leftSession, "ROLLBACK");
      expect((await table(left, leftSession, a)).statement.firstWindow.rows).toEqual([[1, "A"]]);
      expect((await table(right, rightSession, b)).statement.firstWindow.rows).toEqual([
        [1, "committed B"],
        [2, "B2"],
      ]);
      expect(
        resultOf<number>(
          await right.handle({ id: 6, type: "table.count", path: [b, "public"], relation: "same_name", where: "" }),
        ),
      ).toBe(2);
      const reconnected = open(b);
      const newSession = await openSession(reconnected);
      expect(
        (await execute(reconnected, newSession, "SELECT current_database(), marker FROM same_name WHERE id = 1"))
          .firstWindow.rows,
      ).toEqual([[b, "committed B"]]);
    } finally {
      for (const engine of engines) await engine.close();
      for (const database of created.reverse()) await run(admin, `DROP DATABASE ${quote(database)} WITH (FORCE)`);
      if (roleCreated) await run(admin, `DROP ROLE ${quote(role)}`);
      await admin.close();
    }
  });
});
