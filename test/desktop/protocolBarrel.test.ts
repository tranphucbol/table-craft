import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as barrel from "@table-craft/desktop/engine/protocol.js";
import type { EngineMethod, RequestOf, ResultOf } from "@table-craft/desktop/engine/protocol.js";
import * as calls from "@table-craft/desktop/engine/protocol/calls.js";
import * as catalog from "@table-craft/desktop/engine/protocol/catalog.js";
import * as datasource from "@table-craft/desktop/engine/protocol/datasource.js";
import * as inspection from "@table-craft/desktop/engine/protocol/inspection.js";
import * as keyspace from "@table-craft/desktop/engine/protocol/keyspace.js";
import * as keyAdvanced from "@table-craft/desktop/engine/protocol/keyAdvanced.js";
import * as keyAdvancedCalls from "@table-craft/desktop/engine/protocol/keyAdvancedCalls.js";
import * as objects from "@table-craft/desktop/engine/protocol/objects.js";
import * as results from "@table-craft/desktop/engine/protocol/results.js";
import * as sessions from "@table-craft/desktop/engine/protocol/sessions.js";
import * as sql from "@table-craft/desktop/engine/protocol/sql.js";
import * as server from "@table-craft/desktop/engine/protocol/server.js";
import * as tables from "@table-craft/desktop/engine/protocol/tables.js";
import * as transfer from "@table-craft/desktop/engine/protocol/transfer.js";
import * as wire from "@table-craft/desktop/engine/protocol/wire.js";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { ROUTE_GROUPS } from "@table-craft/desktop/engine/routes/index.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROTOCOL_FIXTURE = "packages/desktop/src/engine/protocol/fixture.ts";
/** A route group only reads its connection when a handler runs, so building one needs none. */
const NO_CONNECTION = {} as ConnectionContext;
const AREAS = {
  calls,
  catalog,
  datasource,
  inspection,
  keyspace,
  keyAdvanced,
  keyAdvancedCalls,
  objects,
  results,
  server,
  sessions,
  sql,
  tables,
  transfer,
  wire,
};

const METHODS = [
  "keyspace.features",
  "keyspace.children",
  "keyspace.countRange",
  "keyspace.prepareDelete",
  "keyspace.deletePrepared",
  "leases.list",
  "leases.get",
  "leases.keys",
  "leases.grant",
  "leases.keepAliveOnce",
  "leases.keepAliveStart",
  "leases.keepAliveStop",
  "leases.prepareRevoke",
  "leases.revokePrepared",
  "watch.start",
  "watch.window",
  "watch.stop",
  "watch.clear",
  "watch.list",
  "watch.exportStart",
  "watch.exportList",
  "watch.exportCancel",
  "cluster.endpoints",
  "cluster.members",
  "cluster.status",
  "cluster.alarms",
  "cluster.disarm",
  "cluster.compact",
  "cluster.promote",
  "cluster.remove",
  "maintenance.defragmentStart",
  "maintenance.snapshotStart",
  "maintenance.consistencyStart",
  "maintenance.list",
  "maintenance.cancel",
  "access.status",
  "access.users",
  "access.roles",
  "access.apply",
  "coordination.prefixes",
  "coordination.read",
  "commands.admit",
  "commandTxn.parse",
  "commandTxn.serialize",
  "keyTransfer.previewImport",
  "keyTransfer.importStart",
  "keyTransfer.exportStart",
  "keyTransfer.resume",
  "keyTransfer.list",
  "keyTransfer.cancel",
  "session.open",
  "session.close",
  "statement.execute",
  "statement.cancel",
  "statement.explain",
  "script.split",
  "script.run",
  "script.answer",
  "script.cancel",
  "script.list",
  "sql.format",
  "sql.explainable",
  "sql.generate",
  "transaction.setMode",
  "transaction.commit",
  "transaction.rollback",
  "result.window",
  "result.release",
  "result.fetchMore",
  "result.stopFetch",
  "result.sort",
  "result.view",
  "result.viewState",
  "result.findMatch",
  "result.editable",
  "result.extract",
  "result.aggregate",
  "result.cellBytes",
  "result.saveBytes",
  "result.loadBytes",
  "export.start",
  "export.cancel",
  "export.retry",
  "export.list",
  "import.preview",
  "import.ddl",
  "import.start",
  "import.cancel",
  "import.resume",
  "import.list",
  "objects.features",
  "objects.design",
  "objects.script",
  "objects.apply",
  "catalog.namespaces",
  "catalog.describe",
  "catalog.qualifiedName",
  "catalog.definition",
  "namespace.targets",
  "namespace.switchStatement",
  "server.nodes",
  "server.info",
  "server.slowLog",
  "keyspace.databases",
  "keyspace.history",
  "keyspace.scan",
  "keyspace.describe",
  "keyspace.open",
  "keyspace.preview",
  "keyspace.apply",
  "keyspace.rename",
  "keyspace.expire",
  "keyspace.remove",
  "routine.call",
  "table.query",
  "table.count",
  "table.condition",
  "table.orderBy",
  "completion.complete",
  "completion.signature",
  "inspection.inspect",
  "navigation.resolve",
  "edits.preview",
  "edits.submit",
  "sessions.list",
  "sessions.cancel",
  "sessions.terminate",
] as const;

async function lintProtocolModule(source: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: REPOSITORY_ROOT,
    overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
    ruleFilter: ({ ruleId }) => ruleId === "no-restricted-imports",
  });
  const [result] = await eslint.lintText(source, { filePath: PROTOCOL_FIXTURE });
  return (result?.messages ?? []).map((message) => message.message);
}

describe("the protocol barrel", () => {
  it("givenProtocolBarrel_whenImported_thenEveryEngineMethodHasARequestAndResult", () => {
    expectTypeOf<EngineMethod>().toEqualTypeOf<(typeof METHODS)[number]>();
    expectTypeOf<RequestOf<"routine.call">>().not.toBeNever();
    expectTypeOf<ResultOf<"session.open">>().not.toBeNever();
    expect(new Set(METHODS).size).toBe(METHODS.length);

    const exported = Object.keys(barrel).sort();
    const fromAreas = Object.values(AREAS)
      .flatMap((area) => Object.keys(area))
      .sort();
    expect(fromAreas.length).toBeGreaterThan(0);
    expect(exported).toEqual(fromAreas);
  });

  it("givenProtocolModule_whenItImportsOutsideProtocol_thenLintFails", async () => {
    const outside = await lintProtocolModule('import { z } from "zod";\n\nexport const schema = z.string();\n');
    const sibling = await lintProtocolModule(
      'import type { Row } from "./wire.js";\n\nexport type Rows = readonly Row[];\n',
    );

    expect(outside).toEqual([expect.stringContaining("imports nothing but its sibling areas")]);
    expect(sibling).toEqual([]);
  });

  it("givenRouteGroups_whenMerged_thenEveryEngineMethodHasExactlyOneRoute", () => {
    const keys = ROUTE_GROUPS.flatMap((group) => Object.keys(group(NO_CONNECTION)));

    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...METHODS].sort());
  });
});
