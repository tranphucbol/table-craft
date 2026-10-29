import mysql from "@table-craft/plugin-mysql";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { withWrongPassword } from "../support/databases.js";
import { MYSQL_MANIFEST } from "../support/manifests.js";
import { TYPE_PROBE_COPY_AS, TYPE_PROBE_EXPECTED, TYPE_PROBE_WRITE } from "../support/typeProbe.js";

type ContractOptions = Parameters<typeof runPluginContract>[1];

/**
 * The `calc_fee` and `settle_order` routines `schema/mysql.sql` seeds on every MySQL-family server.
 * `int` is how the server spells `settle_order`'s `INT` parameter: MySQL 8.0.19+ dropped the
 * display width that 5.7 and MariaDB still print as `int(11)`.
 */
export function mysqlRoutines(int = "int"): ContractOptions["routines"] {
  const settleSignature = `order_id ${int}, OUT total decimal(12,2), INOUT note varchar(64)`;
  return {
    expected: [
      {
        name: "calc_fee",
        kind: "function",
        signature: "amount decimal(12,2), rate decimal(6,4)",
        parameters: [
          { name: "amount", type: "decimal(12,2)", mode: "in", hasDefault: false },
          { name: "rate", type: "decimal(6,4)", mode: "in", hasDefault: false },
        ],
        returns: "decimal(12,2)",
      },
      {
        name: "settle_order",
        kind: "procedure",
        signature: settleSignature,
        parameters: [
          { name: "order_id", type: int, mode: "in", hasDefault: false },
          { name: "total", type: "decimal(12,2)", mode: "out", hasDefault: false },
          { name: "note", type: "varchar(64)", mode: "inout", hasDefault: false },
        ],
        returns: null,
      },
    ],
    function: {
      name: "calc_fee",
      kind: "function",
      signature: "amount decimal(12,2), rate decimal(6,4)",
      args: [
        { kind: "value", value: "100.00" },
        { kind: "value", value: "0.0200" },
      ],
      rows: [["2.00"]],
    },
    nullArgument: {
      name: "calc_fee",
      kind: "function",
      signature: "amount decimal(12,2), rate decimal(6,4)",
      args: [
        { kind: "value", value: null },
        { kind: "value", value: "0.0200" },
      ],
      rows: [[null]],
    },
    procedureOut: {
      name: "settle_order",
      kind: "procedure",
      signature: settleSignature,
      args: [
        { kind: "value", value: "3" },
        { kind: "value", value: null },
        { kind: "value", value: "paid" },
      ],
      rows: [["120.50", "paid settled"]],
    },
  };
}

/** A quarter-second `SLEEP` per row: the server's limit stops it between rows with an error. */
const SLEEPS_PER_SECOND = 4;

/**
 * A read of `seconds` that MySQL and MariaDB stop with an error at their limit. A lone
 * `SELECT SLEEP(n)` will not do: MySQL answers one cut short by `max_execution_time` with 1.
 */
export function mysqlSlowRead(seconds: number): string {
  const rows = Array.from({ length: seconds * SLEEPS_PER_SECOND }, (_, index) => `SELECT ${String(index)} AS n`);
  return `SELECT SLEEP(${String(1 / SLEEPS_PER_SECOND)}) AS s FROM (${rows.join(" UNION ALL ")}) t`;
}

export const MYSQL_STATEMENTS: NonNullable<ContractOptions["statements"]> = {
  write: TYPE_PROBE_WRITE,
  sleep: (seconds) => `SELECT SLEEP(${String(seconds)})`,
  slowRead: mysqlSlowRead,
  sessionTimeout: (ms) => `SET SESSION max_execution_time = ${String(ms)}`,
  message: { sql: "SELECT CAST('1x' AS SIGNED) AS n", level: "warning", code: "1292" },
  syntaxError: { sql: "SELECT id FROM customers WHER id = 1", offset: "SELECT id FROM customers WHER ".length },
};

/**
 * The plugin contract against a server seeded from `schema/mysql.sql`, as MySQL 8.4 runs it;
 * `overrides` carries what an older or compatible server answers differently.
 */
export function runMysqlFamilyContract(
  config: { readonly password: string },
  rootConfig: { readonly password: string },
  overrides: Partial<ContractOptions> = {},
): void {
  runPluginContract(mysql, {
    manifest: MYSQL_MANIFEST,
    config,
    wrongPasswordConfig: withWrongPassword(config),
    statements: MYSQL_STATEMENTS,
    typeProbe: { expected: TYPE_PROBE_EXPECTED, copyTable: TYPE_PROBE_COPY_AS },
    scripts: [
      {
        text: "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\nCALL p();",
        statements: ["CREATE PROCEDURE p() BEGIN SELECT 1; END", "CALL p()"],
      },
      { text: "SELECT 'it\\'s;' AS s; # a; note\nSELECT 2", statements: ["SELECT 'it\\'s;' AS s", "SELECT 2"] },
    ],
    catalog: {
      path: ["table_craft"],
      quoted: { name: "odd `name`", qualified: "`table_craft`.`odd ``name```" },
      lineItems: "`Line Items`",
      ordersCheck: "orders_total_nonnegative",
      customersComment: "People who place orders",
    },
    namespaceSwitch: { statement: "USE archive", path: ["archive"], missing: "USE no_such_database" },
    sessions: { monitorConfig: rootConfig, limited: { config, note: /GRANT PROCESS/ } },
    routines: mysqlRoutines(),
    ...overrides,
  });
}
