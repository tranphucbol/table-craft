import postgres from "@table-craft/plugin-postgres";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { describe, expect, it } from "vitest";
import { databaseEnabled, POSTGRES_CONFIG, withWrongPassword } from "../support/databases.js";
import { POSTGRES_MANIFEST } from "../support/manifests.js";
import { TYPE_PROBE_COPY_AS, TYPE_PROBE_EXPECTED, TYPE_PROBE_WRITE } from "../support/typeProbe.js";

describe.runIf(databaseEnabled("postgres"))("postgres server", () => {
  runPluginContract(postgres, {
    manifest: POSTGRES_MANIFEST,
    config: POSTGRES_CONFIG,
    wrongPasswordConfig: withWrongPassword(POSTGRES_CONFIG),
    statements: {
      write: TYPE_PROBE_WRITE,
      sleep: (seconds) => `SELECT pg_sleep(${String(seconds)})`,
      slowRead: (seconds) => `SELECT pg_sleep(${String(seconds)})`,
      sessionTimeout: (ms) => `SET statement_timeout = ${String(ms)}`,
      message: { sql: "DO $$ BEGIN RAISE NOTICE 'probe'; END $$", level: "notice", code: "00000" },
      syntaxError: { sql: "SELECT id, FROM customers", offset: "SELECT id, ".length },
    },
    typeProbe: { expected: TYPE_PROBE_EXPECTED, copyTable: TYPE_PROBE_COPY_AS },
    scripts: [
      {
        text: "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT f();",
        statements: ["CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql", "SELECT f()"],
      },
      { text: "/* a /* nested; */ comment; */ SELECT 1; SELECT $1", statements: ["SELECT 1", "SELECT $1"] },
    ],
    catalog: {
      path: ["table_craft", "public"],
      quoted: { name: 'odd "name"', qualified: '"public"."odd ""name"""' },
      lineItems: '"Line Items"',
      ordersCheck: "orders_total_nonnegative",
      customersComment: "People who place orders",
    },
    namespaceSwitch: { statement: "SET search_path TO archive, public", path: ["table_craft", "archive"] },
    sessions: { monitorConfig: POSTGRES_CONFIG },
    routines: {
      expected: [
        {
          name: "calc_fee",
          kind: "function",
          signature: "amount numeric, currency text, rate numeric",
          parameters: [
            { name: "amount", type: "numeric", mode: "in", hasDefault: false },
            { name: "currency", type: "text", mode: "in", hasDefault: false },
            { name: "rate", type: "numeric", mode: "in", hasDefault: true },
          ],
          returns: "numeric",
        },
        {
          name: "calc_fee",
          kind: "function",
          signature: "amount numeric, rate numeric",
          parameters: [
            { name: "amount", type: "numeric", mode: "in", hasDefault: false },
            { name: "rate", type: "numeric", mode: "in", hasDefault: true },
          ],
          returns: "numeric",
        },
        {
          name: "customer_orders",
          kind: "function",
          signature: "customer integer",
          parameters: [{ name: "customer", type: "integer", mode: "in", hasDefault: false }],
          returns: "TABLE(id integer, total numeric)",
        },
        {
          name: "settle_order",
          kind: "procedure",
          signature: "IN order_id integer, OUT total numeric",
          parameters: [
            { name: "order_id", type: "integer", mode: "in", hasDefault: false },
            { name: "total", type: "numeric", mode: "out", hasDefault: false },
          ],
          returns: null,
        },
      ],
      function: {
        name: "calc_fee",
        kind: "function",
        signature: "amount numeric, rate numeric",
        args: [
          { kind: "value", value: "100" },
          { kind: "value", value: "0.02" },
        ],
        rows: [["2.00"]],
      },
      nullArgument: {
        name: "calc_fee",
        kind: "function",
        signature: "amount numeric, rate numeric",
        args: [
          { kind: "value", value: null },
          { kind: "value", value: "0.02" },
        ],
        rows: [[null]],
      },
      procedureOut: {
        name: "settle_order",
        kind: "procedure",
        signature: "IN order_id integer, OUT total numeric",
        args: [
          { kind: "value", value: "3" },
          { kind: "value", value: null },
        ],
        rows: [["120.50"]],
      },
      defaulted: {
        name: "calc_fee",
        kind: "function",
        signature: "amount numeric, currency text, rate numeric",
        args: [{ kind: "value", value: "200" }, { kind: "value", value: "EUR" }, { kind: "default" }],
        rows: [["4.00"]],
      },
    },
  });

  it("givenPostgresServer_whenSessionOpens_thenCancelBackendReachesTheStatement", async () => {
    const session = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
    try {
      expect(session.cancelReach).toEqual({ method: "pg_cancel_backend", reaches: "statement" });
    } finally {
      await session.close();
    }
  });

  describe("postgres routines", () => {
    it("givenOverloads_whenTree_thenSeparateRoutines", async () => {
      const session = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
      try {
        const catalog = await session.introspector?.describe(["table_craft", "public"]);
        const overloads = catalog?.routines.filter((routine) => routine.name === "calc_fee") ?? [];
        expect(overloads.map((routine) => routine.signature)).toEqual([
          "amount numeric, currency text, rate numeric",
          "amount numeric, rate numeric",
        ]);
      } finally {
        await session.close();
      }
    });
  });

  describe("postgres current namespace", () => {
    it("givenSearchPathOfNoSchema_whenRead_thenNull", async () => {
      const session = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
      try {
        await session.execute("SET search_path TO no_such_schema");
        expect(await session.currentNamespace?.()).toBeNull();
      } finally {
        await session.close();
      }
    });

    it("givenSetLocalInTransaction_whenRolledBack_thenNamespaceReverts", async () => {
      const session = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
      try {
        await session.transactions?.setMode("manual");
        await session.execute("SET LOCAL search_path TO archive");
        expect(await session.currentNamespace?.()).toEqual(["table_craft", "archive"]);
        await session.transactions?.rollback();
        expect(await session.currentNamespace?.()).toEqual(["table_craft", "public"]);
      } finally {
        await session.close();
      }
    });
  });

  describe("postgres server messages", () => {
    const NOISY =
      "CREATE FUNCTION pg_temp.noisy(n int) RETURNS int AS $$ BEGIN RAISE WARNING 'row %', n; RETURN n; END $$ LANGUAGE plpgsql";

    it("givenRowsRaisingWarnings_whenDrained_thenEachWarningInOrder", async () => {
      const session = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
      try {
        await session.execute(NOISY);
        const result = await session.execute("SELECT pg_temp.noisy(n) AS n FROM generate_series(1, 2) AS n");
        for await (const _row of result.rows) {
          // Messages are complete once the rows are.
        }
        expect(result.messages).toEqual([
          { level: "warning", code: "01000", text: "row 1" },
          { level: "warning", code: "01000", text: "row 2" },
        ]);
      } finally {
        await session.close();
      }
    });
  });
});
