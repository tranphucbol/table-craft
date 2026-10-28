import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CSV_FORMAT, TSV_FORMAT, type PluginLoadResult } from "@table-craft/core";
import mysql from "@table-craft/plugin-mysql";
import oracle from "@table-craft/plugin-oracle";
import postgres from "@table-craft/plugin-postgres";
import type { ExportFormat, ImportPreview } from "@table-craft/desktop/engine/protocol.js";
import {
  MYSQL_CONFIG,
  ORACLE_CONFIG,
  POSTGRES_CONFIG,
  databaseEnabled,
  type DatabaseId,
} from "../support/databases.js";
import {
  execute,
  exportHarness,
  openSession,
  resultOf,
  startExport,
  startImport,
  type ExportHarness,
} from "../support/engineExports.js";
import { MYSQL_MANIFEST, ORACLE_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";
import { ORACLE_TYPE_PROBE_EXPECTED, TYPE_PROBE_COPY_ORACLE, TYPE_PROBE_EXPECTED } from "../support/typeProbe.js";

/** Plan 021: files the exporter wrote, and files with inferred types, imported through the engine. */

const TYPE_PROBE_COLUMNS = [
  "id",
  "small_int",
  "big_int",
  "exact_decimal",
  "unicode_text",
  "flag",
  "doc",
  "payload",
  "day",
  "moment",
];
const NEW_TABLE = "table_craft_import_new";
/** Not the contract suite's `type_probe_copy`: the two files run in parallel against one database. */
const ROUND_TRIP_TABLE = "table_craft_import_round_trip";
const ROUND_TRIP_AS = `CREATE TABLE ${ROUND_TRIP_TABLE} AS SELECT * FROM type_probe WHERE 1 = 0`;
const ALL = { mode: "all" } as const;
const STOP = { mode: "stop" } as const;
const PRESETS: Readonly<Record<"csv" | "tsv", typeof CSV_FORMAT>> = { csv: CSV_FORMAT, tsv: TSV_FORMAT };

interface Target {
  readonly name: DatabaseId;
  readonly plugin: PluginLoadResult;
  readonly config: object;
  readonly path: readonly string[];
  /** How the server folds an unquoted name: Oracle's upper case. */
  readonly fold: (name: string) => string;
  readonly roundTripAs: string;
  readonly expected: readonly (readonly unknown[])[];
  /** `SELECT id + 1, score * 2, ratio * 2, born, note` of the inferred table. */
  readonly inferred: readonly (readonly unknown[])[];
}

const SAME = (name: string): string => name;
const INFERRED = [
  [2, expect.stringMatching(/^25\.0+$/u), 2000, "2024-02-29", "héllo"],
  [3, expect.stringMatching(/^-0\.50+$/u), 5, "1999-12-31", "line\nbreak"],
];

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    plugin: { status: "loaded", directory: "plugins/postgres", manifest: POSTGRES_MANIFEST, plugin: postgres },
    config: POSTGRES_CONFIG,
    path: ["table_craft", "public"],
    fold: SAME,
    roundTripAs: ROUND_TRIP_AS,
    expected: TYPE_PROBE_EXPECTED,
    inferred: INFERRED,
  },
  {
    name: "mysql",
    plugin: { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql },
    config: MYSQL_CONFIG,
    path: ["table_craft"],
    fold: SAME,
    roundTripAs: ROUND_TRIP_AS,
    expected: TYPE_PROBE_EXPECTED,
    inferred: INFERRED,
  },
  {
    name: "oracle",
    plugin: { status: "loaded", directory: "plugins/oracle", manifest: ORACLE_MANIFEST, plugin: oracle },
    config: ORACLE_CONFIG,
    path: ["TABLE_CRAFT"],
    fold: (name) => name.toUpperCase(),
    roundTripAs: TYPE_PROBE_COPY_ORACLE.replace("type_probe_copy", ROUND_TRIP_TABLE),
    expected: ORACLE_TYPE_PROBE_EXPECTED,
    // A product of decimals is an unconstrained NUMBER, an integer when its value is; DATE keeps its time.
    inferred: [
      [2, 25, 2000, "2024-02-29 00:00:00", "héllo"],
      [3, "-0.5", 5, "1999-12-31 00:00:00", "line\nbreak"],
    ],
  },
];

for (const target of TARGETS) {
  describe.skipIf(!databaseEnabled(target.name))(`import: ${target.name}`, () => {
    const cleanup: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const step of cleanup.splice(0).reverse()) await step();
    });

    async function rig(): Promise<{
      engine: ExportHarness;
      run: (sql: string) => Promise<readonly unknown[]>;
      folder: string;
    }> {
      const folder = await mkdtemp(join(tmpdir(), "table-craft-import-"));
      cleanup.push(() => rm(folder, { recursive: true, force: true }));
      const engine = exportHarness(
        { id: target.name, pluginId: target.name, config: target.config, readOnly: false, keepAliveSeconds: 0 },
        [target.plugin],
      );
      cleanup.push(() => engine.close());
      const sessionId = await openSession(engine.connection);
      const run = async (sql: string) => (await execute(engine.connection, sessionId, sql)).firstWindow.rows;
      return { engine, run, folder };
    }

    for (const format of ["csv", "tsv"] as const satisfies readonly ExportFormat[]) {
      it(`givenExporter${format.toUpperCase()}_whenImportedBack_thenTableEqualsSource`, async () => {
        const { engine, run, folder } = await rig();
        const file = join(folder, `type_probe.${format}`);
        await run(`DROP TABLE IF EXISTS ${ROUND_TRIP_TABLE}`);
        cleanup.push(async () => void (await run(`DROP TABLE IF EXISTS ${ROUND_TRIP_TABLE}`)));
        await run(target.roundTripAs);
        const exported = await startExport(engine.connection, {
          source: {
            kind: "table",
            path: target.path,
            relation: target.fold("type_probe"),
            columns: TYPE_PROBE_COLUMNS.map(target.fold),
          },
          format,
          path: file,
        });
        expect((await engine.finished(exported.taskId)).state).toBe("done");

        const task = await startImport(engine.connection, {
          file,
          format: PRESETS[format],
          target: {
            kind: "table",
            path: target.path,
            relation: target.fold(ROUND_TRIP_TABLE),
            mapping: TYPE_PROBE_COLUMNS.map((column, field) => ({ column: target.fold(column), field })),
          },
          transaction: ALL,
          errors: STOP,
        });
        const done = await engine.imported(task.taskId);

        expect(done).toMatchObject({ state: "done", committed: target.expected.length });
        expect(await run(`SELECT * FROM ${ROUND_TRIP_TABLE} ORDER BY id`)).toEqual(target.expected);
      });
    }

    it("givenCsv_whenImportedIntoNewTableWithInferredTypes_thenValuesTyped", async () => {
      const { engine, run, folder } = await rig();
      const file = join(folder, "people.csv");
      await writeFile(
        file,
        "id,born,score,ratio,active,seen_at,note\n" +
          "1,2024-02-29,12.50,1e3,true,2024-02-29 13:45:30,héllo\n" +
          '2,1999-12-31,-0.25,2.5,false,1999-12-31 23:59:59,"line\nbreak"\n',
      );
      await run(`DROP TABLE IF EXISTS ${NEW_TABLE}`);
      cleanup.push(async () => void (await run(`DROP TABLE IF EXISTS ${NEW_TABLE}`)));
      const preview = resultOf<ImportPreview>(
        await engine.connection.handle({ id: 7, type: "import.preview", file, format: CSV_FORMAT }),
      );
      const columns = preview.names.map((name, field) => ({ name, type: preview.types[field] ?? "", field }));

      const task = await startImport(engine.connection, {
        file,
        format: CSV_FORMAT,
        target: { kind: "new", path: target.path, relation: target.fold(NEW_TABLE), columns },
        transaction: ALL,
        errors: STOP,
      });
      const done = await engine.imported(task.taskId);

      expect(preview.kinds).toEqual(["integer", "date", "decimal", "double", "boolean", "timestamp", "text"]);
      expect(done).toMatchObject({ state: "done", committed: 2, created: true });
      expect(await run(`SELECT id + 1, score * 2, ratio * 2, born, note FROM ${NEW_TABLE} ORDER BY id`)).toEqual(
        target.inferred,
      );
    });
  });
}
