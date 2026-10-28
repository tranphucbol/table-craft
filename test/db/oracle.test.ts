import oracle from "@table-craft/plugin-oracle";
import { PluginError, type ExecuteResult, type Session } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { describe, expect, it } from "vitest";
import { databaseEnabled, ORACLE_CONFIG, ORACLE_LIMITED_CONFIG, withWrongPassword } from "../support/databases.js";
import { ORACLE_MANIFEST } from "../support/manifests.js";
import { ORACLE_TYPE_PROBE_EXPECTED, TYPE_PROBE_COPY_ORACLE, TYPE_PROBE_WRITE } from "../support/typeProbe.js";

/** Oracle's private temporary tables must carry this prefix (the `PRIVATE_TEMP_TABLE_PREFIX` default). */
const PRIVATE_TEMPORARY_PREFIX = "ORA$PTT_";

describe.runIf(databaseEnabled("oracle"))("oracle server", () => {
  runPluginContract(oracle, {
    manifest: ORACLE_MANIFEST,
    config: ORACLE_CONFIG,
    wrongPasswordConfig: withWrongPassword(ORACLE_CONFIG),
    statements: {
      write: TYPE_PROBE_WRITE,
      sleep: (seconds) => `BEGIN DBMS_SESSION.SLEEP(${String(seconds)}); END;`,
      message: { sql: "BEGIN DBMS_OUTPUT.PUT_LINE('probe'); END;", level: "info", code: null },
      syntaxError: { sql: "SELECT id, FROM customers", offset: "SELECT id, ".length },
    },
    typeProbe: { expected: ORACLE_TYPE_PROBE_EXPECTED, copyTable: TYPE_PROBE_COPY_ORACLE },
    scripts: [
      {
        text: "CREATE PROCEDURE p IS\nBEGIN\n  NULL;\nEND;\n/\nSELECT q'[a;b]' FROM DUAL;",
        statements: ["CREATE PROCEDURE p IS\nBEGIN\n  NULL;\nEND;", "SELECT q'[a;b]' FROM DUAL"],
      },
    ],
    catalog: {
      path: ["TABLE_CRAFT"],
      quoted: { name: 'odd "name"', qualified: 'TABLE_CRAFT."odd ""name"""' },
      lineItems: '"Line Items"',
      ordersCheck: "ORDERS_TOTAL_NONNEGATIVE",
      customersComment: "People who place orders",
    },
    namespaceSwitch: {
      statement: "ALTER SESSION SET CURRENT_SCHEMA = archive",
      path: ["ARCHIVE"],
      missing: "ALTER SESSION SET CURRENT_SCHEMA = no_such_schema",
    },
    sessions: {
      monitorConfig: ORACLE_CONFIG,
      limited: { config: ORACLE_LIMITED_CONFIG, note: /SELECT_CATALOG_ROLE/ },
    },
    routines: {
      expected: [
        {
          name: "BILLING.CALC_FEE",
          kind: "function",
          signature: "AMOUNT NUMBER, RATE NUMBER",
          parameters: [
            { name: "AMOUNT", type: "NUMBER", mode: "in", hasDefault: false },
            { name: "RATE", type: "NUMBER", mode: "in", hasDefault: true },
          ],
          returns: "NUMBER",
        },
        {
          name: "BILLING.CALC_FEE",
          kind: "function",
          signature: "AMOUNT NUMBER, CURRENCY VARCHAR2, RATE NUMBER",
          parameters: [
            { name: "AMOUNT", type: "NUMBER", mode: "in", hasDefault: false },
            { name: "CURRENCY", type: "VARCHAR2", mode: "in", hasDefault: false },
            { name: "RATE", type: "NUMBER", mode: "in", hasDefault: true },
          ],
          returns: "NUMBER",
        },
        {
          name: "CALC_FEE",
          kind: "function",
          signature: "AMOUNT NUMBER, RATE NUMBER",
          parameters: [
            { name: "AMOUNT", type: "NUMBER", mode: "in", hasDefault: false },
            { name: "RATE", type: "NUMBER", mode: "in", hasDefault: true },
          ],
          returns: "NUMBER",
        },
        {
          name: "CUSTOMER_ORDERS",
          kind: "function",
          signature: "CUSTOMER NUMBER",
          parameters: [{ name: "CUSTOMER", type: "NUMBER", mode: "in", hasDefault: false }],
          returns: "SYS_REFCURSOR",
        },
        {
          name: "SETTLE_ORDER",
          kind: "procedure",
          signature: "ORDER_ID NUMBER, TOTAL OUT NUMBER, NOTE IN OUT VARCHAR2",
          parameters: [
            { name: "ORDER_ID", type: "NUMBER", mode: "in", hasDefault: false },
            { name: "TOTAL", type: "NUMBER", mode: "out", hasDefault: false },
            { name: "NOTE", type: "VARCHAR2", mode: "inout", hasDefault: false },
          ],
          returns: null,
        },
      ],
      function: {
        name: "CALC_FEE",
        kind: "function",
        signature: "AMOUNT NUMBER, RATE NUMBER",
        args: [
          { kind: "value", value: "100" },
          { kind: "value", value: "0.025" },
        ],
        rows: [["2.5"]],
      },
      nullArgument: {
        name: "CALC_FEE",
        kind: "function",
        signature: "AMOUNT NUMBER, RATE NUMBER",
        args: [
          { kind: "value", value: null },
          { kind: "value", value: "0.02" },
        ],
        rows: [[null]],
      },
      procedureOut: {
        name: "SETTLE_ORDER",
        kind: "procedure",
        signature: "ORDER_ID NUMBER, TOTAL OUT NUMBER, NOTE IN OUT VARCHAR2",
        args: [
          { kind: "value", value: "3" },
          { kind: "value", value: null },
          { kind: "value", value: "order 3" },
        ],
        rows: [["120.5", "order 3 settled"]],
      },
      defaulted: {
        name: "BILLING.CALC_FEE",
        kind: "function",
        signature: "AMOUNT NUMBER, CURRENCY VARCHAR2, RATE NUMBER",
        args: [{ kind: "value", value: "200" }, { kind: "value", value: "EUR" }, { kind: "default" }],
        rows: [[4]],
      },
    },
    sql: {
      select: (expressions) => `SELECT ${expressions} FROM DUAL`,
      dropTableIfExists: (name) => `DROP TABLE IF EXISTS ${name} PURGE`,
      temporaryTable: (name, columns) => ({
        create: `CREATE PRIVATE TEMPORARY TABLE ${PRIVATE_TEMPORARY_PREFIX}${name} (${columns}) ON COMMIT PRESERVE DEFINITION`,
        name: `${PRIVATE_TEMPORARY_PREFIX}${name}`,
      }),
      begin: "SET TRANSACTION READ WRITE",
      awkwardIdentifier: "we`ird name;",
    },
    foldName: (name) => name.toUpperCase(),
    emptyTextIsNull: true,
  });

  async function withSession<T>(work: (session: Session) => Promise<T>, config: object = ORACLE_CONFIG): Promise<T> {
    const session = await oracle.connect(config, { readOnly: false });
    try {
      return await work(session);
    } finally {
      await session.close();
    }
  }

  async function rowsOf(result: ExecuteResult): Promise<unknown[][]> {
    const rows: unknown[][] = [];
    for await (const row of result.rows) rows.push([...row]);
    return rows;
  }

  describe("oracle values", () => {
    it("givenNumberScaleZero_whenFetched_thenWireInteger", async () => {
      await withSession(async (session) => {
        const result = await session.execute("SELECT small_int, exact_decimal FROM type_probe WHERE id = 1");
        expect(result.columns.map((column) => column.typeClass)).toEqual(["integer", "decimal"]);
        expect(await rowsOf(result)).toEqual([[42, "1234567890123456.7890"]]);
      });
    });

    it("givenEmptyString_whenRoundTripped_thenNull", async () => {
      await withSession(async (session) => {
        expect(await rowsOf(await session.execute("SELECT '' AS empty_text FROM DUAL"))).toEqual([[null]]);
      });
    });
  });

  describe("oracle statements", () => {
    it("givenPlsqlBlockWithTrailingSemicolon_whenExecuted_thenKept", async () => {
      await withSession(async (session) => {
        const result = await session.execute("BEGIN NULL; END;");
        expect(result.columns).toEqual([]);
      });
    });

    it("givenSqlWithTrailingSemicolon_whenExecuted_thenStripped", async () => {
      await withSession(async (session) => {
        expect(await rowsOf(await session.execute("SELECT 1 AS one FROM DUAL;"))).toEqual([[1]]);
      });
    });

    it("givenOraOffset_whenFailed_thenEditorPosition", async () => {
      await withSession(async (session) => {
        const failure = await session.execute("SELECT nope FROM customers").catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(PluginError);
        expect(failure).toMatchObject({ code: "statementFailed", position: { offset: "SELECT ".length } });
        expect((failure as Error).message).toMatch(/^ORA-00904/);
        expect((failure as Error).message).not.toMatch(/Help:/);
      });
    });
  });

  describe("oracle server messages", () => {
    it("givenDbmsOutputLines_whenStatementEnds_thenMessages", async () => {
      await withSession(async (session) => {
        const result = await session.execute(
          "BEGIN DBMS_OUTPUT.PUT_LINE('first'); DBMS_OUTPUT.PUT_LINE('second'); END;",
        );
        expect(result.messages).toEqual([
          { level: "info", code: null, text: "first" },
          { level: "info", code: null, text: "second" },
        ]);
      });
    });

    it("givenCompileErrors_whenCreateProcedure_thenWarningWithLines", async () => {
      await withSession(async (session) => {
        try {
          const result = await session.execute(
            "CREATE OR REPLACE PROCEDURE table_craft_broken IS\nBEGIN\n  no_such_call;\nEND;",
          );
          const [warning, ...errors] = result.messages ?? [];
          expect(warning).toMatchObject({ level: "warning", code: "NJS-700" });
          expect(errors.length).toBeGreaterThan(0);
          expect(errors[0]).toMatchObject({ level: "error" });
          expect(errors[0]?.text).toMatch(/^Line 3, column 3: /);
        } finally {
          await session.execute("DROP PROCEDURE table_craft_broken");
        }
      });
    });
  });

  describe("oracle routines", () => {
    async function routines(session: Session) {
      const catalog = await session.introspector?.describe(["TABLE_CRAFT"]);
      return catalog?.routines ?? [];
    }

    it("givenPackageMember_whenDescribed_thenRoutinePkgDotName", async () => {
      await withSession(async (session) => {
        const names = (await routines(session)).map((routine) => routine.name);
        expect(names).toContain("BILLING.CALC_FEE");
        expect(names).toContain("CALC_FEE");
      });
    });

    it("givenOverloadedPackageMember_whenListed_thenSubprogramIdsDistinguish", async () => {
      await withSession(async (session) => {
        const overloads = (await routines(session)).filter((routine) => routine.name === "BILLING.CALC_FEE");
        expect(overloads.map((routine) => routine.signature)).toEqual([
          "AMOUNT NUMBER, RATE NUMBER",
          "AMOUNT NUMBER, CURRENCY VARCHAR2, RATE NUMBER",
        ]);
      });
    });

    it("givenRefCursorOut_whenCalled_thenResultSet", async () => {
      await withSession(async (session) => {
        const routine = (await routines(session)).find((candidate) => candidate.name === "CUSTOMER_ORDERS");
        if (routine === undefined || oracle.language?.routineCall === undefined) throw new Error("No routine call.");
        const call = oracle.language.routineCall(routine, "TABLE_CRAFT.CUSTOMER_ORDERS", [
          { kind: "value", value: "1" },
        ]);
        const bound = oracle.language.bind(call.sql, call.params);
        const result = await session.execute(bound.sql, bound.params);
        expect(result.columns.map((column) => column.name)).toEqual(["ID", "TOTAL"]);
        expect((await rowsOf(result)).length).toBeGreaterThan(0);
      });
    });
  });

  describe("oracle explain", () => {
    it("givenNoCatalogRole_whenAnalyze_thenHintNamesRole", async () => {
      await withSession(async (session) => {
        const failure = await session
          .explain?.("SELECT * FROM table_craft.customers", { analyze: true })
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: "explainUnsupported" });
        expect((failure as Error).message).toMatch(/SELECT_CATALOG_ROLE/);
      }, ORACLE_LIMITED_CONFIG);
    });
  });

  describe("oracle current schema", () => {
    it("givenCurrentSchemaSwitch_whenRun_thenCompletionFollows", async () => {
      await withSession(async (session) => {
        const statement = "ALTER SESSION SET CURRENT_SCHEMA = archive";
        expect(oracle.language?.classify(statement).setsNamespace).toBe(true);
        await session.execute(statement);
        expect(await session.currentNamespace?.()).toEqual(["ARCHIVE"]);
        const catalog = await session.introspector?.describe(["ARCHIVE"]);
        expect(catalog?.relations.map((relation) => relation.name)).toContain("OLD_ORDERS");
      });
    });
  });
});
