import mysql from "@table-craft/plugin-mysql";
import { describe, expect, it } from "vitest";
import { databaseEnabled, MARIADB_CONFIG, MARIADB_ROOT_CONFIG } from "../support/databases.js";
import { TYPE_PROBE_COPY_LIKE, TYPE_PROBE_EXPECTED } from "../support/typeProbe.js";
import { MYSQL_STATEMENTS, mysqlRoutines, runMysqlFamilyContract } from "./mysqlFamily.js";

describe.runIf(databaseEnabled("mariadb"))("mariadb server", () => {
  runMysqlFamilyContract(MARIADB_CONFIG, MARIADB_ROOT_CONFIG, {
    routines: mysqlRoutines("int(11)"),
    statements: {
      ...MYSQL_STATEMENTS,
      sessionTimeout: (ms) => `SET SESSION max_statement_time = ${String(ms / 1000)}`,
    },
    typeProbe: { expected: TYPE_PROBE_EXPECTED, copyTable: TYPE_PROBE_COPY_LIKE },
  });

  it("givenMariadbServer_whenSessionOpens_thenServerBrandMariadb", async () => {
    const session = await mysql.connect(MARIADB_CONFIG, { readOnly: false });
    try {
      expect(session.serverBrand).toBe("mariadb");
    } finally {
      await session.close();
    }
  });
});
