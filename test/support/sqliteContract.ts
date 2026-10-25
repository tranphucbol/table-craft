import type { PluginManifest } from "@table-craft/plugin-api";
import type { ContractFixture } from "@table-craft/plugin-api/testing";
import { seededSqliteFile } from "./sqliteFixture.js";
import { TYPE_PROBE_COPY_SQLITE, TYPE_PROBE_EXPECTED, TYPE_PROBE_WRITE } from "./typeProbe.js";

/** The SQLite contract fixture, shared by the built-in plugin's run and the frozen 1.0.0 bundle's. */
export function sqliteContractFixture(manifest: PluginManifest): ContractFixture {
  return {
    manifest,
    config: { path: seededSqliteFile() },
    statements: {
      write: TYPE_PROBE_WRITE,
      syntaxError: { sql: "SELECT 1 FROM customers ORDER id", offset: "SELECT 1 FROM customers ORDER ".length },
    },
    typeProbe: { expected: TYPE_PROBE_EXPECTED, copyTable: TYPE_PROBE_COPY_SQLITE },
    scripts: [
      {
        text: "CREATE TRIGGER t AFTER INSERT ON orders BEGIN UPDATE customers SET name = name; END;\nSELECT 1;",
        statements: ["CREATE TRIGGER t AFTER INSERT ON orders BEGIN UPDATE customers SET name = name; END", "SELECT 1"],
      },
    ],
    catalog: {
      path: ["main"],
      quoted: { name: 'odd "name"', qualified: '"main"."odd ""name"""' },
      lineItems: '"Line Items"',
      ordersCheck: "orders_total_nonnegative",
      customersComment: null,
    },
  };
}
