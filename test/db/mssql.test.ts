import mssql from "@table-craft/plugin-mssql";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { describe } from "vitest";
import { databaseEnabled, MSSQL_CONFIG, withWrongPassword } from "../support/databases.js";
import { MSSQL_MANIFEST } from "../support/manifests.js";
import { MSSQL_TYPE_PROBE_EXPECTED, TYPE_PROBE_WRITE } from "../support/typeProbe.js";
import { mssqlServerCases } from "./mssqlCases.js";

const SLEEP_SECONDS_WIDTH = 2;

/** `WAITFOR DELAY` takes `hh:mm:ss`. */
function waitFor(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `WAITFOR DELAY '00:${String(minutes).padStart(SLEEP_SECONDS_WIDTH, "0")}:${String(rest).padStart(SLEEP_SECONDS_WIDTH, "0")}'`;
}

/** Above any id a test server reaches; ids are reused, so a closed session's id may be taken again. */
const MISSING_SESSION_ID = "32000";

const LIMITED_CONFIG = { ...MSSQL_CONFIG, user: "table_craft_limited", password: "table_craft_limited" };

describe.runIf(databaseEnabled("mssql"))("mssql server", () => {
  runPluginContract(mssql, {
    manifest: MSSQL_MANIFEST,
    config: MSSQL_CONFIG,
    wrongPasswordConfig: withWrongPassword(MSSQL_CONFIG),
    statements: {
      write: TYPE_PROBE_WRITE,
      sleep: waitFor,
      message: { sql: "PRINT 'probe'", level: "info", code: null },
      syntaxError: { sql: "SELECT 1\n  FROM customers WHERE", offset: "SELECT 1\n  ".length },
    },
    typeProbe: {
      expected: MSSQL_TYPE_PROBE_EXPECTED,
      copyTable: "SELECT * INTO type_probe_copy FROM type_probe WHERE 1 = 0",
    },
    scripts: [
      { text: "SELECT 1 AS n\nGO\nSELECT 2 AS n\ngo", statements: ["SELECT 1 AS n", "SELECT 2 AS n"] },
      {
        text: "CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END\nGO\nEXEC p;",
        statements: ["CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END", "EXEC p"],
      },
      { text: "SELECT 1 AS [a;b]; SELECT N'c;d' AS s", statements: ["SELECT 1 AS [a;b]", "SELECT N'c;d' AS s"] },
    ],
    catalog: {
      path: ["table_craft", "dbo"],
      quoted: { name: "odd ]name", qualified: "[table_craft].[dbo].[odd ]]name]" },
      lineItems: "[Line Items]",
      ordersCheck: "orders_total_nonnegative",
      customersComment: "People who place orders",
    },
    namespaceSwitch: { statement: "USE master", path: ["master", "guest"], missing: "USE [table_craft_missing]" },
    sessions: {
      monitorConfig: MSSQL_CONFIG,
      cancels: false,
      missingId: MISSING_SESSION_ID,
      limited: { config: LIMITED_CONFIG, note: /VIEW SERVER STATE/ },
    },
    routines: {
      expected: [
        {
          name: "calc_fee",
          kind: "function",
          signature: "@amount decimal(12,2), @rate decimal(6,4)",
          parameters: [
            { name: "amount", type: "decimal(12,2)", mode: "in", hasDefault: false },
            { name: "rate", type: "decimal(6,4)", mode: "in", hasDefault: true },
          ],
          returns: "decimal(12,2)",
        },
        {
          name: "customer_orders",
          kind: "function",
          signature: "@customer int",
          parameters: [{ name: "customer", type: "int", mode: "in", hasDefault: false }],
          returns: "TABLE(id int, total decimal(12,2))",
        },
        {
          name: "settle_order",
          kind: "procedure",
          signature: "@order_id int, @total decimal(12,2) OUTPUT",
          parameters: [
            { name: "order_id", type: "int", mode: "in", hasDefault: false },
            { name: "total", type: "decimal(12,2)", mode: "out", hasDefault: false },
          ],
          returns: null,
        },
      ],
      function: {
        name: "calc_fee",
        kind: "function",
        signature: "@amount decimal(12,2), @rate decimal(6,4)",
        args: [
          { kind: "value", value: "100" },
          { kind: "value", value: "0.02" },
        ],
        rows: [["2.00"]],
      },
      nullArgument: {
        name: "calc_fee",
        kind: "function",
        signature: "@amount decimal(12,2), @rate decimal(6,4)",
        args: [
          { kind: "value", value: null },
          { kind: "value", value: "0.02" },
        ],
        rows: [[null]],
      },
      procedureOut: {
        name: "settle_order",
        kind: "procedure",
        signature: "@order_id int, @total decimal(12,2) OUTPUT",
        args: [
          { kind: "value", value: "3" },
          { kind: "value", value: null },
        ],
        rows: [[0, "120.50"]],
      },
      defaulted: {
        name: "calc_fee",
        kind: "function",
        signature: "@amount decimal(12,2), @rate decimal(6,4)",
        args: [{ kind: "value", value: "200" }, { kind: "default" }],
        rows: [["3.00"]],
      },
    },
    sql: {
      begin: "BEGIN TRANSACTION",
      explainStatement: /^SET (SHOWPLAN_XML|STATISTICS XML) ON\b/i,
      temporaryTable: (name, columns) => ({ create: `CREATE TABLE #${name} (${columns})`, name: `#${name}` }),
    },
  });

  mssqlServerCases();
});
