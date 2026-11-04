import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import type { DatasourcePlugin, NamespaceCatalog, Relation } from "@table-craft/plugin-api";
import sqlitePlugin from "@table-craft/plugin-sqlite";
import {
  assembleScript,
  orderForScript,
  scriptHeader,
  scriptNamespace,
  scriptRelations,
  type ScriptRelation,
  type ScriptSource,
} from "@table-craft/desktop/engine/ddlScript.js";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import { SCRIPT_RELATION_KINDS, type EngineResponse, type SchemaScript } from "@table-craft/desktop/engine/protocol.js";
import { exportHarness, resultOf, startExport, type ExportHarness } from "../support/engineExports.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const sqlite: DatasourcePlugin = sqlitePlugin;
const GENERATED_AT = Date.UTC(2026, 10, 3);
const MAIN = ["main"];
const SQLITE_RELATIONS = ["Line Items", "customers", "edit_probe", "no_key_probe", "orders", "type_probe"];

function table(name: string, references: readonly string[] = []): ScriptRelation {
  return { name, kind: "table", references };
}

function names(relations: readonly ScriptRelation[]): string[] {
  return relations.map((relation) => relation.name);
}

function relation(name: string, foreignKeys: readonly { path: readonly string[]; relation: string }[]): Relation {
  return {
    name,
    kind: "table",
    comment: null,
    columns: [],
    primaryKey: null,
    uniqueKeys: [],
    foreignKeys: foreignKeys.map((target, index) => ({
      name: `fk_${String(index)}`,
      columns: ["id"],
      target: { ...target, columns: ["id"] },
      onDelete: "NO ACTION",
      onUpdate: "NO ACTION",
    })),
    indexes: [],
  };
}

function loaded(plugin: DatasourcePlugin): PluginLoadResult {
  return { status: "loaded", directory: "plugins/sqlite", manifest: SQLITE_MANIFEST, plugin };
}

function sqliteEngine(path: string, plugin: DatasourcePlugin = sqlite) {
  return createEngine({
    datasource: { id: "seeded", pluginId: "sqlite", config: { path }, readOnly: false, keepAliveSeconds: 0 },
    plugins: [loaded(plugin)],
  });
}

async function scripted(path: string, kinds: readonly string[] = SCRIPT_RELATION_KINDS): Promise<EngineResponse> {
  return sqliteEngine(path).connect().handle({ id: 1, type: "catalog.script", path: MAIN, kinds, title: "seeded" });
}

/** Sqlite whose definitions wait until `release` is called, so an export is still reading when cancelled. */
function gatedSqlite(): { plugin: DatasourcePlugin; release: () => void } {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const plugin: DatasourcePlugin = {
    ...sqlite,
    connect: async (config, options) => {
      const session = await sqlite.connect(config, options);
      const { ddl } = session.services;
      return {
        execute: (sql, params, executeOptions) => session.execute(sql, params, executeOptions),
        services: {
          ...session.services,
          ddl:
            ddl === undefined
              ? undefined
              : {
                  definition: async (definitionPath, name) => {
                    await gate;
                    return ddl.definition(definitionPath, name);
                  },
                },
        },
        serverVersion: session.serverVersion,
        close: () => session.close(),
      };
    },
  };
  return { plugin, release: () => release() };
}

describe("ddl script order", () => {
  it("givenOrdersReferencingCustomers_whenOrdered_thenCustomersFirst", () => {
    const { order, cycles } = orderForScript([table("orders", ["customers"]), table("customers")]);

    expect(names(order)).toEqual(["customers", "orders"]);
    expect(cycles).toEqual([]);
  });

  it("givenCrossNamespaceForeignKey_whenOrdered_thenIgnored", () => {
    const catalog: NamespaceCatalog = {
      path: ["archive"],
      relations: [relation("old_orders", [{ path: ["shop"], relation: "customers" }]), relation("customers", [])],
      routines: [],
      sequences: [],
    };

    const relations = scriptRelations(catalog, SCRIPT_RELATION_KINDS);

    expect(relations.find((candidate) => candidate.name === "old_orders")?.references).toEqual([]);
    expect(names(orderForScript(relations).order)).toEqual(["customers", "old_orders"]);
  });

  it("givenSelfReference_whenOrdered_thenNoCycle", () => {
    const { order, cycles } = orderForScript([table("employees", ["employees"]), table("depots")]);

    expect(names(order)).toEqual(["depots", "employees"]);
    expect(cycles).toEqual([]);
  });

  it("givenTwoTablesReferencingEachOther_whenOrdered_thenNameOrderAndCycleReported", () => {
    const { order, cycles } = orderForScript([
      table("orders", ["invoices"]),
      table("invoices", ["orders"]),
      table("lines", ["orders"]),
    ]);
    const header = scriptHeader({ title: "shop", path: ["shop"], generatedAt: GENERATED_AT, cycles });

    expect(names(order)).toEqual(["invoices", "orders", "lines"]);
    expect(cycles).toEqual([["invoices", "orders"]]);
    expect(header).toContain("-- invoices and orders reference each other; create them with foreign key checks off.");
  });

  it("givenTablesAndViews_whenOrdered_thenTablesFirst", () => {
    const { order } = orderForScript([
      { name: "a_totals", kind: "materializedView", references: [] },
      { name: "b_view", kind: "view", references: [] },
      table("z_table"),
      { name: "a_view", kind: "view", references: [] },
    ]);

    expect(names(order)).toEqual(["z_table", "a_view", "b_view", "a_totals"]);
  });
});

describe("ddl script text", () => {
  const header = scriptHeader({ title: "Local", path: ["shop", "public"], generatedAt: GENERATED_AT, cycles: [] });

  it("givenFailedDefinition_whenAssembled_thenCommentInPlace", () => {
    const text = assembleScript(header, [
      { name: "customers", definition: "CREATE TABLE customers (id INT);" },
      { name: "orders", error: "permission denied" },
      { name: "totals", definition: "CREATE VIEW totals AS SELECT 1;\n" },
    ]);

    expect(text).toBe(
      [
        "-- Local: shop.public",
        "-- Generated by TableCraft on 2026-11-03",
        "-- Routines and sequences are not included.",
        "",
        "CREATE TABLE customers (id INT);",
        "",
        "-- orders: permission denied",
        "",
        "CREATE VIEW totals AS SELECT 1;",
        "",
      ].join("\n"),
    );
  });

  it("givenEmptyNamespace_whenAssembled_thenHeaderOnly", () => {
    expect(assembleScript(header, [])).toBe(`${header}\n`);
  });

  it("givenScriptOverCap_whenScripted_thenScriptTooLarge", async () => {
    const source: ScriptSource = {
      describe: (path) => Promise.resolve({ path, relations: [relation("big", [])], routines: [], sequences: [] }),
      definition: () => Promise.resolve("x".repeat(2048)),
      now: () => GENERATED_AT,
    };

    await expect(scriptNamespace(source, { path: MAIN, kinds: ["table"], title: "big" }, 1024)).rejects.toMatchObject({
      error: { code: "scriptTooLarge", hint: "Choose Generate DDL to File… for a schema this size." },
    });
  });
});

describe("engine catalog.script", () => {
  it("givenSqliteFixture_whenScripted_thenEveryRelationOnce", async () => {
    const script = resultOf<SchemaScript>(await scripted(seededSqliteFile()));
    const created = [...script.text.matchAll(/^CREATE (?:TABLE|VIEW) (?:"([^"]+)"|(\S+))/gmu)].map(
      (match) => match[1] ?? match[2],
    );

    expect(script).toMatchObject({ relations: SQLITE_RELATIONS.length + 1, failed: 0 });
    expect(script.text.startsWith("-- seeded: main\n")).toBe(true);
    expect(created.sort()).toEqual([...SQLITE_RELATIONS, "customer_totals"].sort());
    expect(created.indexOf("customers")).toBeLessThan(created.indexOf("orders"));
  });

  it("givenTablesGroup_whenScripted_thenTablesOnly", async () => {
    const script = resultOf<SchemaScript>(await scripted(seededSqliteFile(), ["table"]));

    expect(script.relations).toBe(SQLITE_RELATIONS.length);
    expect(script.text).not.toContain("CREATE VIEW");
  });

  it("givenSqliteScript_whenRunInEmptyDatabase_thenDescribesTheSame", async () => {
    const script = resultOf<SchemaScript>(await scripted(seededSqliteFile()));
    const target = join(await mkdtemp(join(tmpdir(), "table-craft-ddl-")), "recreated.sqlite");
    const database = new DatabaseSync(target);
    try {
      database.exec(script.text);
    } finally {
      database.close();
    }

    const again = resultOf<SchemaScript>(await scripted(target));

    expect(again.text.split("\n").slice(1)).toEqual(script.text.split("\n").slice(1));
  });

  it("givenDatasourceWithoutDdl_whenScripted_thenInvalidRequest", async () => {
    const plugin: DatasourcePlugin = { ...sqlite, capabilities: sqlite.capabilities.filter((name) => name !== "ddl") };

    const response = await sqliteEngine(seededSqliteFile(), plugin)
      .connect()
      .handle({ id: 1, type: "catalog.script", path: MAIN, kinds: ["table"], title: "seeded" });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
  });
});

describe("engine ddl file export", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function folder(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "table-craft-ddl-export-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }

  function harness(path: string, plugin: DatasourcePlugin = sqlite): ExportHarness {
    const opened = exportHarness(
      { id: "ddl", pluginId: "sqlite", config: { path }, readOnly: false, keepAliveSeconds: 0 },
      [loaded(plugin)],
    );
    cleanup.push(() => opened.close());
    return opened;
  }

  it("givenDdlFileTask_whenDone_thenFileMatchesTheScript", async () => {
    const path = join(await folder(), "main.sql");
    const fixture = seededSqliteFile();
    const { connection, finished } = harness(fixture);
    const source = { kind: "ddl", path: MAIN, kinds: SCRIPT_RELATION_KINDS, title: "seeded" };

    const task = await startExport(connection, { source, format: "sql", path });
    const done = await finished(task.taskId);
    const script = resultOf<SchemaScript>(await scripted(fixture));

    expect(task).toMatchObject({ origin: "ddl", format: "sql", estimate: script.relations, retryable: true });
    expect(done).toMatchObject({ state: "done", rows: script.relations });
    expect((await readFile(path, "utf8")).split("\n").slice(1)).toEqual(script.text.split("\n").slice(1));
  });

  it("givenDdlFileTask_whenCancelled_thenPartFileRemoved", async () => {
    const directory = await folder();
    const { plugin, release } = gatedSqlite();
    const { connection, finished } = harness(seededSqliteFile(), plugin);
    const source = { kind: "ddl", path: MAIN, kinds: ["table"], title: "seeded" };

    const task = await startExport(connection, { source, format: "sql", path: join(directory, "main.sql") });
    await connection.handle({ id: 5, type: "export.cancel", taskId: task.taskId });
    const done = await finished(task.taskId);
    release();

    expect(done).toMatchObject({ state: "cancelled", error: { code: "cancelled" } });
    expect(await readdir(directory)).toEqual([]);
  });

  it("givenDdlSourceWithCsvFormat_whenStarted_thenInvalidRequest", async () => {
    const { connection } = harness(seededSqliteFile());

    const response = await connection.handle({
      id: 3,
      type: "export.start",
      source: { kind: "ddl", path: MAIN, kinds: ["table"], title: "seeded" },
      format: "csv",
      path: join(await folder(), "main.csv"),
      stallSeconds: 120,
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
  });
});
